/**
 * udaDashboard.controller.js
 *
 * Spec: "For UDA, he will direct only to PC meeting dashboard and will notify
 *        with latest scheduled PC meeting date."
 *
 * All PC members (PSO, TO, SW, GJS, RDA, HO, UDA, Chairman) can view the PC
 * meeting dashboard. This controller provides the UDA-specific entry point:
 *   - latest scheduled meeting info
 *   - applications on that agenda (with tracking line)
 *   - ability to submit a minute on each application
 *
 * Routes:
 *   GET  /uda/dashboard               — upcoming meeting + agenda summary
 *   GET  /uda/pc-meetings             — all PC meetings UDA can see
 *   GET  /uda/pc-meetings/:meetingId  — single meeting full detail
 *   POST /uda/pc-meetings/:meetingId/applications/:appId/minute  — submit UDA minute
 */

const {
  PlanningCommitteeMeeting, PCApplication, Application,
  TrackingLine, TrackingNode, Minute, Notification, User,
} = require('../models');
const { Op } = require('sequelize');
const notifEvents = require('../services/notificationEvents.service');
const { success, created, notFound, badRequest, forbidden } = require('../utils/responseHelper');

const UDA_ROLES = ['UDA', 'ADMIN'];

// ─── GET /uda/dashboard ───────────────────────────────────────────────────────
/**
 * Returns:
 *  - next_meeting : the nearest SCHEDULED meeting with its agenda
 *  - unread_notifications : count of unread notifications for this UDA user
 *  - recent_meetings : last 5 completed meetings (for historical reference)
 */
exports.getUDADashboard = async (req, res, next) => {
  try {
    if (!UDA_ROLES.includes(req.user.role)) {
      return forbidden(res, 'UDA dashboard is restricted to UDA officers');
    }

    // Next scheduled meeting
    const nextMeeting = await PlanningCommitteeMeeting.findOne({
      where: {
        status: 'SCHEDULED',
        meeting_date: { [Op.gte]: new Date() },
      },
      order: [['meeting_date', 'ASC']],
      include: [{
        model: PCApplication,
        include: [{
          model: Application,
          attributes: ['application_id', 'reference_number', 'status', 'sub_plan_type'],
        }],
      }],
    });

    // Recent completed meetings
    const recentMeetings = await PlanningCommitteeMeeting.findAll({
      where: { status: 'COMPLETED' },
      order: [['meeting_date', 'DESC']],
      limit: 5,
      attributes: ['meeting_id', 'meeting_number', 'meeting_date', 'venue', 'status'],
    });

    // Unread notification count
    const unreadCount = await Notification.count({
      where: { recipient_id: req.user.user_id, is_read: false },
    });

    return success(res, {
      next_meeting:          nextMeeting || null,
      recent_meetings:       recentMeetings,
      unread_notifications:  unreadCount,
    });
  } catch (err) { next(err); }
};

// ─── GET /uda/pc-meetings ─────────────────────────────────────────────────────
/**
 * All PC meetings visible to UDA — scheduled and completed.
 */
exports.listPCMeetings = async (req, res, next) => {
  try {
    if (!UDA_ROLES.includes(req.user.role)) {
      return forbidden(res, 'Access denied');
    }

    const meetings = await PlanningCommitteeMeeting.findAll({
      order: [['meeting_date', 'DESC']],
      include: [{
        model: PCApplication,
        attributes: ['pc_application_id', 'application_id', 'reference_number', 'status', 'presentation_order'],
      }],
    });

    return success(res, meetings);
  } catch (err) { next(err); }
};

// ─── GET /uda/pc-meetings/:meetingId ─────────────────────────────────────────
/**
 * Full meeting detail: agenda with tracking lines per application.
 * UDA sees tracking nodes relevant to their role (all nodes visible to officers).
 */
exports.getPCMeetingDetail = async (req, res, next) => {
  try {
    if (!UDA_ROLES.includes(req.user.role)) {
      return forbidden(res, 'Access denied');
    }

    const meeting = await PlanningCommitteeMeeting.findByPk(req.params.meetingId, {
      include: [{
        model: PCApplication,
        include: [{
          model: Application,
          attributes: [
            'application_id', 'reference_number', 'status', 'sub_plan_type',
            'plan_type_id', 'site_area', 'building_area', 'submitted_at',
          ],
        }],
      }],
    });
    if (!meeting) return notFound(res, 'PC meeting not found');

    // Enrich each agenda item with its tracking line
    const agendaWithTracking = await Promise.all(
      (meeting.PCApplications || []).map(async (pcApp) => {
        let trackingSummary = null;
        if (pcApp.Application?.reference_number) {
          const line = await TrackingLine.findOne({
            where: { reference_number: pcApp.Application.reference_number },
          });
          if (line) {
            const nodes = await TrackingNode.findAll({
              where: { tracking_line_id: line.tracking_line_id },
              order: [['sequence_number', 'ASC']],
              attributes: [
                'node_id', 'node_type', 'label', 'status',
                'started_at', 'completed_at', 'metadata',
                'linked_minute_id', 'linked_inspection_id',
              ],
            });
            trackingSummary = { tracking_line_id: line.tracking_line_id, nodes };
          }
        }

        // Fetch any UDA minutes already submitted on this pc_application
        const existingMinutes = await Minute.findAll({
          where: {
            application_id: pcApp.application_id,
            minute_type: 'UDA_COMPLIANCE',
            authored_by: req.user.user_id,
          },
          attributes: ['minute_id', 'content', 'status', 'submitted_at'],
          order: [['submitted_at', 'DESC']],
          limit: 5,
        });

        return {
          ...pcApp.toJSON(),
          tracking: trackingSummary,
          uda_minutes: existingMinutes,
        };
      })
    );

    return success(res, {
      ...meeting.toJSON(),
      PCApplications: agendaWithTracking,
    });
  } catch (err) { next(err); }
};

// ─── POST /uda/pc-meetings/:meetingId/applications/:appId/minute ──────────────
/**
 * UDA submits their compliance minute on a specific application in a PC meeting.
 *
 * Spec: "every PC meeting member can add pc meeting minute on each application
 *        so that will be shown in tracking line when extract the node of pc meeting"
 *
 * Creates a Minute with minute_type='UDA_COMPLIANCE' and records it on the
 * PCApplication.member_minutes JSON so the tracking line PC_COMMITTEE node
 * shows the full set of member minutes when extracted.
 */
exports.submitUDAMinute = async (req, res, next) => {
  try {
    if (!UDA_ROLES.includes(req.user.role)) {
      return forbidden(res, 'Only UDA officers can submit UDA compliance minutes');
    }

    const { content, observations, recommendation, uda_regulation_ref } = req.body;
    const minuteContent = content || observations;
    if (!minuteContent) return badRequest(res, 'content (or observations) is required');

    // Validate application is on this meeting's agenda
    const pcApp = await PCApplication.findOne({
      where: {
        meeting_id:     req.params.meetingId,
        application_id: req.params.appId,
      },
    });
    if (!pcApp) return notFound(res, 'Application not found on this meeting agenda');

    const app = await Application.findByPk(req.params.appId);
    if (!app) return notFound(res, 'Application not found');

    // Compose full minute content including optional UDA regulation reference
    const fullContent = uda_regulation_ref
      ? `[UDA Regulation Ref: ${uda_regulation_ref}]\n\n${minuteContent}${recommendation ? `\n\nRecommendation: ${recommendation}` : ''}`
      : `${minuteContent}${recommendation ? `\n\nRecommendation: ${recommendation}` : ''}`;

    const minute = await Minute.create({
      reference_number: app.reference_number,
      application_id:   app.application_id,
      authored_by:      req.user.user_id,
      minute_type:      'UDA_COMPLIANCE',
      content:          fullContent,
      visibility:       'OFFICERS_ONLY',
      status:           'SUBMITTED',
      submitted_at:     new Date(),
    });

    // Append to PCApplication.member_minutes so SW can see all member inputs
    const existing = Array.isArray(pcApp.member_minutes) ? pcApp.member_minutes : [];
    existing.push({
      minute_id:   minute.minute_id,
      authored_by: req.user.user_id,
      role:        'UDA',
      added_at:    new Date().toISOString(),
    });
    await pcApp.update({ member_minutes: existing });

    return created(res, minute, 'UDA compliance minute submitted');
  } catch (err) { next(err); }
};

// ─── GET /uda/notifications ───────────────────────────────────────────────────
/**
 * UDA's own notification list — PC meeting schedules, application decisions.
 */
exports.getNotifications = async (req, res, next) => {
  try {
    if (!UDA_ROLES.includes(req.user.role)) {
      return forbidden(res, 'Access denied');
    }

    const notifications = await Notification.findAll({
      where: { recipient_id: req.user.user_id },
      order: [['created_at', 'DESC']],
      limit: 50,
    });

    // Mark all as read
    await Notification.update(
      { is_read: true },
      { where: { recipient_id: req.user.user_id, is_read: false } }
    );

    return success(res, notifications);
  } catch (err) { next(err); }
};
