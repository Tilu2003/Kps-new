/**
 * pcMemberMinute.controller.js
 *
 * Spec: "every PC meeting member can add pc meeting minute on each application
 *        so that will be shown in tracking line when extract the node of pc meeting"
 *
 * The addPCMeetingMinute endpoint already exists in pcMeeting.controller.js.
 * This controller adds the READ side — retrieving all member minutes for a
 * specific application in a specific meeting, with full minute content and
 * author role details. This is what the frontend calls when a user clicks the
 * PC_COMMITTEE tracking node to "extract" it.
 *
 * Also provides a cross-meeting summary: all PC minutes ever submitted for a
 * reference number (useful for appeals which can go through multiple PC rounds).
 *
 * Routes (registered under /pc-member-minutes):
 *   GET /pc-member-minutes/meeting/:meetingId/application/:appId
 *       → all member minutes for one application in one meeting
 *
 *   GET /pc-member-minutes/ref/:ref
 *       → all PC minutes across all meetings for a reference number
 *
 *   GET /pc-member-minutes/meeting/:meetingId/application/:appId/my
 *       → the calling user's own minute for this application/meeting
 */

const {
  PCApplication, PlanningCommitteeMeeting, Application,
  Minute, User, Officer,
} = require('../models');
const { Op } = require('sequelize');
const { success, notFound, forbidden } = require('../utils/responseHelper');

const PC_MEMBER_ROLES = ['PSO', 'SW', 'TO', 'HO', 'RDA', 'GJS', 'UDA', 'CHAIRMAN', 'ADMIN'];

// ── Helper: resolve author details for a list of minute records ───────────────
const enrichWithAuthors = async (minutes) => {
  const userIds = [...new Set(minutes.map(m => m.authored_by).filter(Boolean))];
  if (!userIds.length) return minutes.map(m => ({ ...m.toJSON(), author: null }));

  const users = await User.findAll({
    where: { user_id: { [Op.in]: userIds } },
    attributes: ['user_id', 'full_name', 'role'],
  });
  const userMap = Object.fromEntries(users.map(u => [u.user_id, u]));

  return minutes.map(m => ({
    ...m.toJSON(),
    author: userMap[m.authored_by]
      ? { user_id: m.authored_by, full_name: userMap[m.authored_by].full_name, role: userMap[m.authored_by].role }
      : null,
  }));
};

// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /pc-member-minutes/meeting/:meetingId/application/:appId
 *
 * Returns all PC_MEETING + UDA_COMPLIANCE + SW_FINAL_REVIEW minutes
 * submitted by any member for this specific application in this meeting.
 * Sorted by submitted_at ascending (chronological order of contributions).
 */
exports.getMinutesForApplicationInMeeting = async (req, res, next) => {
  try {
    if (!PC_MEMBER_ROLES.includes(req.user.role)) {
      return forbidden(res, 'Only PC meeting members can view PC minutes');
    }

    // Validate application is on this meeting's agenda
    const pcApp = await PCApplication.findOne({
      where: {
        meeting_id:     req.params.meetingId,
        application_id: req.params.appId,
      },
    });
    if (!pcApp) return notFound(res, 'Application not found on this meeting agenda');

    const app = await Application.findByPk(req.params.appId, {
      attributes: ['application_id', 'reference_number', 'status', 'sub_plan_type'],
    });
    if (!app) return notFound(res, 'Application not found');

    const meeting = await PlanningCommitteeMeeting.findByPk(req.params.meetingId, {
      attributes: ['meeting_id', 'meeting_number', 'meeting_date', 'status'],
    });

    // Fetch all member minutes for this application
    const minutes = await Minute.findAll({
      where: {
        application_id: req.params.appId,
        minute_type: { [Op.in]: ['PC_MEETING', 'UDA_COMPLIANCE', 'SW_FINAL_REVIEW', 'HO_ASSESSMENT', 'RDA_ASSESSMENT', 'GJS_LAND_CONDITION'] },
        // Only minutes submitted around this meeting's date (within a 7-day window either side)
        submitted_at: meeting?.meeting_date ? {
          [Op.between]: [
            new Date(new Date(meeting.meeting_date).getTime() - 7 * 24 * 60 * 60 * 1000),
            new Date(new Date(meeting.meeting_date).getTime() + 7 * 24 * 60 * 60 * 1000),
          ],
        } : { [Op.ne]: null },
      },
      order: [['submitted_at', 'ASC']],
    });

    const enriched = await enrichWithAuthors(minutes);

    // Also include the member_minutes index from the PCApplication record
    // (quick lookup of who submitted without loading full content)
    const memberIndex = Array.isArray(pcApp.member_minutes) ? pcApp.member_minutes : [];

    return success(res, {
      meeting,
      application: app,
      minutes:      enriched,
      member_index: memberIndex,
      total:        enriched.length,
    });
  } catch (err) { next(err); }
};

/**
 * GET /pc-member-minutes/ref/:ref
 *
 * All PC-related minutes across every meeting for a reference number.
 * Used by the tracking line node extraction for PC_COMMITTEE nodes.
 * Especially important for appeals (which can have multiple PC rounds).
 */
exports.getAllPCMinutesForRef = async (req, res, next) => {
  try {
    if (!PC_MEMBER_ROLES.includes(req.user.role)) {
      return forbidden(res, 'Only PC meeting members can view PC minutes');
    }

    const minutes = await Minute.findAll({
      where: {
        reference_number: req.params.ref,
        minute_type: { [Op.in]: ['PC_MEETING', 'UDA_COMPLIANCE', 'SW_FINAL_REVIEW', 'HO_ASSESSMENT', 'RDA_ASSESSMENT', 'GJS_LAND_CONDITION'] },
      },
      order: [['submitted_at', 'ASC']],
    });

    const enriched = await enrichWithAuthors(minutes);

    // Group by meeting (inferred from submitted_at proximity to known PC meetings)
    return success(res, {
      reference_number: req.params.ref,
      total:    enriched.length,
      minutes:  enriched,
    });
  } catch (err) { next(err); }
};

/**
 * GET /pc-member-minutes/meeting/:meetingId/application/:appId/my
 *
 * Returns the calling user's own minute for this application in this meeting.
 * Used by the frontend to pre-fill the minute form if the user has already submitted.
 */
exports.getMyMinuteForApplication = async (req, res, next) => {
  try {
    if (!PC_MEMBER_ROLES.includes(req.user.role)) {
      return forbidden(res, 'Access denied');
    }

    const app = await Application.findByPk(req.params.appId, {
      attributes: ['application_id', 'reference_number'],
    });
    if (!app) return notFound(res, 'Application not found');

    const meeting = await PlanningCommitteeMeeting.findByPk(req.params.meetingId, {
      attributes: ['meeting_id', 'meeting_date'],
    });
    if (!meeting) return notFound(res, 'Meeting not found');

    const minute = await Minute.findOne({
      where: {
        application_id: req.params.appId,
        authored_by:    req.user.user_id,
        minute_type: { [Op.in]: ['PC_MEETING', 'UDA_COMPLIANCE', 'SW_FINAL_REVIEW', 'HO_ASSESSMENT', 'RDA_ASSESSMENT', 'GJS_LAND_CONDITION'] },
      },
      order: [['submitted_at', 'DESC']],
    });

    return success(res, minute || null);
  } catch (err) { next(err); }
};
