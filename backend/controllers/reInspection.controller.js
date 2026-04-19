/**
 * reInspection.controller.js
 *
 * Spec (Applicant quick actions): "Request Re-inspection"
 *
 * Allows an applicant to request a new site inspection on an application
 * that has already had an inspection completed. Common triggers:
 *   - Applicant has rectified issues raised in the TO's inspection minute
 *   - Construction has progressed and applicant wants a supplementary check
 *
 * Flow:
 *   1. Applicant POSTs a re-inspection request with a reason
 *   2. System validates the application belongs to the applicant and has
 *      a completed inspection (status INSPECTION_DONE or FURTHER_REVIEW)
 *   3. A ReInspectionRequest record is created (status: PENDING)
 *   4. The original TO + SW are notified IN_APP
 *   5. SW can approve → creates a new Inspection record assigned to the
 *      original TO, adds a SUPPLEMENTARY tracking node
 *   6. SW can reject → notifies applicant with reason
 *
 * Routes:
 *   POST /re-inspections                        — applicant submits request
 *   GET  /re-inspections/my                     — applicant views own requests
 *   GET  /re-inspections/pending                — SW sees all pending requests
 *   PUT  /re-inspections/:id/approve            — SW approves → creates Inspection
 *   PUT  /re-inspections/:id/reject             — SW rejects with reason
 *   GET  /re-inspections/ref/:ref               — all requests for a reference
 */

const {
  Application, Applicant, Inspection, TaskAssignment,
  TrackingLine, TrackingNode, Notification, User,
} = require('../models');
const { Op, DataTypes } = require('sequelize');
const sequelize = require('../config/database');
const notifEvents = require('../services/notificationEvents.service');
const trackingLineService = require('../services/trackingLine.service');
const { success, created, notFound, badRequest, forbidden } = require('../utils/responseHelper');

// ── Inline model (no separate migration file needed — uses existing DB conn) ──
const ReInspectionRequest = sequelize.define('ReInspectionRequest', {
  request_id:       { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  reference_number: { type: DataTypes.STRING(50), allowNull: false },
  application_id:   { type: DataTypes.UUID, allowNull: false },
  applicant_id:     { type: DataTypes.UUID, allowNull: false },
  reason:           { type: DataTypes.TEXT, allowNull: false },
  status:           { type: DataTypes.ENUM('PENDING', 'APPROVED', 'REJECTED'), defaultValue: 'PENDING' },
  rejection_reason: { type: DataTypes.TEXT },
  // Set when SW approves — points to the newly created Inspection
  inspection_id:    { type: DataTypes.UUID },
  reviewed_by:      { type: DataTypes.UUID, comment: 'SW user_id who approved or rejected' },
  reviewed_at:      { type: DataTypes.DATE },
  requested_at:     { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, { tableName: 're_inspection_requests',
  indexes: [
    { fields: ['reference_number'] },
    { fields: ['applicant_id'] },
    { fields: ['status'] },
  ],
});

// Sync the table on first load (safe — no-op if already exists)
ReInspectionRequest.sync({ alter: false }).catch(() => {
  // Retry with create-if-not-exists
  ReInspectionRequest.sync().catch(e => console.error('[ReInspection] Table sync failed:', e.message));
});

// ── Helpers ───────────────────────────────────────────────────────────────────
const getOriginalTO = async (referenceNumber) => {
  const task = await TaskAssignment.findOne({
    where: {
      reference_number: referenceNumber,
      task_type: { [Op.in]: ['TO_INSPECTION', 'FURTHER_REVIEW_INSPECTION'] },
    },
    order: [['created_at', 'ASC']],
  });
  return task?.assigned_to || null;
};

const getSWUser = async () => {
  return User.findOne({ where: { role: 'SW', status: 'ACTIVE' }, attributes: ['user_id'] });
};

// ── VALID APPLICATION STATUSES for re-inspection request ─────────────────────
const ELIGIBLE_STATUSES = [
  'INSPECTION_DONE', 'SW_REVIEW', 'FURTHER_REVIEW',
  'EXTERNAL_APPROVAL', 'PC_REVIEW',
];

// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /re-inspections
 * Applicant submits a re-inspection request.
 */
exports.createRequest = async (req, res, next) => {
  try {
    const { reference_number, reason } = req.body;

    if (!reference_number) return badRequest(res, 'reference_number is required');
    if (!reason || reason.trim().length < 10) {
      return badRequest(res, 'A reason of at least 10 characters is required');
    }

    const app = await Application.findOne({ where: { reference_number } });
    if (!app) return notFound(res, 'Application not found');

    // Verify the applicant owns this application
    if (req.user.role === 'APPLICANT') {
      const applicant = await Applicant.findOne({ where: { user_id: req.user.user_id } });
      if (!applicant || applicant.applicant_id !== app.applicant_id) {
        return forbidden(res, 'You do not own this application');
      }
    }

    // Application must have had at least one inspection
    if (!ELIGIBLE_STATUSES.includes(app.status)) {
      return badRequest(res,
        `Re-inspection can only be requested after an inspection has been completed. ` +
        `Current status: ${app.status}`
      );
    }

    // Prevent duplicate pending request
    const existing = await ReInspectionRequest.findOne({
      where: { application_id: app.application_id, status: 'PENDING' },
    });
    if (existing) {
      return badRequest(res, 'A re-inspection request is already pending for this application');
    }

    const applicant = await Applicant.findByPk(app.applicant_id, { attributes: ['applicant_id', 'user_id'] });

    const request = await ReInspectionRequest.create({
      reference_number:  app.reference_number,
      application_id:    app.application_id,
      applicant_id:      app.applicant_id,
      reason:            reason.trim(),
      status:            'PENDING',
      requested_at:      new Date(),
    });

    // Notify original TO and SW
    setImmediate(async () => {
      try {
        const toId = await getOriginalTO(reference_number);
        const sw   = await getSWUser();

        const notifyOfficer = async (officerId, recipientLabel) => {
          if (!officerId) return;
          await Notification.create({
            recipient_id: officerId,
            event_type:   'RE_INSPECTION_REQUESTED',
            title:        `Re-inspection Requested — ${reference_number}`,
            body:         `The applicant has requested a re-inspection for ${reference_number}. Reason: ${reason.trim().substring(0, 120)}`,
            channel:      'IN_APP',
            is_read:      false,
          });
        };

        await notifyOfficer(toId, 'TO');
        await notifyOfficer(sw?.user_id, 'SW');
      } catch (e) {
        console.error('[ReInspection] Notification failed:', e.message);
      }
    });

    return created(res, request, 'Re-inspection request submitted. The Technical Officer and SW have been notified.');
  } catch (err) { next(err); }
};

/**
 * GET /re-inspections/my
 * Applicant views their own re-inspection requests.
 */
exports.getMyRequests = async (req, res, next) => {
  try {
    const applicant = await Applicant.findOne({ where: { user_id: req.user.user_id } });
    if (!applicant) return notFound(res, 'Applicant profile not found');

    const requests = await ReInspectionRequest.findAll({
      where: { applicant_id: applicant.applicant_id },
      order: [['requested_at', 'DESC']],
    });
    return success(res, requests);
  } catch (err) { next(err); }
};

/**
 * GET /re-inspections/pending
 * SW views all pending re-inspection requests.
 */
exports.getPendingRequests = async (req, res, next) => {
  try {
    if (!['SW', 'PSO', 'ADMIN'].includes(req.user.role)) {
      return forbidden(res, 'Access denied');
    }

    const requests = await ReInspectionRequest.findAll({
      where: { status: 'PENDING' },
      order: [['requested_at', 'ASC']],
    });

    // Enrich with application details
    const enriched = await Promise.all(requests.map(async (r) => {
      const app = await Application.findByPk(r.application_id, {
        attributes: ['application_id', 'reference_number', 'status', 'sub_plan_type'],
      });
      const toId = await getOriginalTO(r.reference_number);
      let toName = null;
      if (toId) {
        const toUser = await User.findByPk(toId, { attributes: ['full_name'] });
        toName = toUser?.full_name || null;
      }
      return { ...r.toJSON(), application: app, original_to_name: toName };
    }));

    return success(res, enriched);
  } catch (err) { next(err); }
};

/**
 * PUT /re-inspections/:id/approve
 * SW approves the request → creates a new SUPPLEMENTARY Inspection record
 * assigned to the original TO, adds a tracking node.
 */
exports.approveRequest = async (req, res, next) => {
  try {
    if (!['SW', 'ADMIN'].includes(req.user.role)) {
      return forbidden(res, 'Only SW can approve re-inspection requests');
    }

    const request = await ReInspectionRequest.findByPk(req.params.id);
    if (!request) return notFound(res, 'Re-inspection request not found');
    if (request.status !== 'PENDING') {
      return badRequest(res, `Request is already ${request.status}`);
    }

    const app = await Application.findByPk(request.application_id);
    if (!app) return notFound(res, 'Application not found');

    const toId = await getOriginalTO(request.reference_number);
    if (!toId) return badRequest(res, 'Cannot find original TO for this application');

    // Create a new Inspection record (SUPPLEMENTARY type)
    const inspection = await Inspection.create({
      reference_number: request.reference_number,
      application_id:   request.application_id,
      officer_id:       toId,
      inspection_type:  'SUPPLEMENTARY',
      priority_level:   'NORMAL',
      status:           'SCHEDULED',
      location_address: app.map_place_description || null,
    });

    // Create a TaskAssignment for the TO
    await TaskAssignment.create({
      reference_number: request.reference_number,
      application_id:   request.application_id,
      assigned_to:      toId,
      assigned_by:      req.user.user_id,
      task_type:        'TO_INSPECTION',
      priority:         'NORMAL',
      notes:            `Supplementary re-inspection — applicant reason: ${request.reason.substring(0, 200)}`,
      status:           'PENDING',
    });

    // Add SUPPLEMENTARY tracking node
    const line = await TrackingLine.findOne({ where: { reference_number: request.reference_number } });
    if (line) {
      const nodeCount = await TrackingNode.count({ where: { tracking_line_id: line.tracking_line_id } });
      await TrackingNode.create({
        tracking_line_id:        line.tracking_line_id,
        reference_number:        request.reference_number,
        node_type:               'TO_INSPECTION',
        label:                   'Supplementary Inspection Scheduled',
        status:                  'ACTIVE',
        sequence_number:         nodeCount + 1,
        is_visible_to_applicant: true,
        linked_officer_id:       toId,
        linked_inspection_id:    inspection.inspection_id,
        metadata: {
          inspection_type:     'SUPPLEMENTARY',
          re_inspection_reason: request.reason,
          approved_by_sw:      req.user.user_id,
        },
        started_at: new Date(),
      });
    }

    // Update request record
    await request.update({
      status:       'APPROVED',
      inspection_id: inspection.inspection_id,
      reviewed_by:  req.user.user_id,
      reviewed_at:  new Date(),
    });

    // Notify applicant
    const applicant = await Applicant.findByPk(request.applicant_id, { attributes: ['user_id'] });
    if (applicant?.user_id) {
      await Notification.create({
        recipient_id: applicant.user_id,
        event_type:   'RE_INSPECTION_APPROVED',
        title:        `Re-inspection Approved — ${request.reference_number}`,
        body:         `Your re-inspection request for ${request.reference_number} has been approved. The Technical Officer will contact you to schedule the site visit.`,
        channel:      'IN_APP',
        is_read:      false,
      });
    }

    // Notify TO
    await Notification.create({
      recipient_id: toId,
      event_type:   'RE_INSPECTION_ASSIGNED',
      title:        `Supplementary Inspection — ${request.reference_number}`,
      body:         `A supplementary re-inspection has been approved for ${request.reference_number}. Please schedule the site visit. Applicant's reason: ${request.reason.substring(0, 150)}`,
      channel:      'IN_APP',
      is_read:      false,
    });

    return success(res, { request, inspection }, 'Re-inspection approved. New inspection record created and TO notified.');
  } catch (err) { next(err); }
};

/**
 * PUT /re-inspections/:id/reject
 * SW rejects the request with a mandatory reason. Notifies applicant.
 */
exports.rejectRequest = async (req, res, next) => {
  try {
    if (!['SW', 'ADMIN'].includes(req.user.role)) {
      return forbidden(res, 'Only SW can reject re-inspection requests');
    }

    const { rejection_reason } = req.body;
    if (!rejection_reason || rejection_reason.trim().length < 10) {
      return badRequest(res, 'A rejection reason of at least 10 characters is required');
    }

    const request = await ReInspectionRequest.findByPk(req.params.id);
    if (!request) return notFound(res, 'Re-inspection request not found');
    if (request.status !== 'PENDING') {
      return badRequest(res, `Request is already ${request.status}`);
    }

    await request.update({
      status:           'REJECTED',
      rejection_reason: rejection_reason.trim(),
      reviewed_by:      req.user.user_id,
      reviewed_at:      new Date(),
    });

    // Notify applicant
    const applicant = await Applicant.findByPk(request.applicant_id, { attributes: ['user_id'] });
    if (applicant?.user_id) {
      await Notification.create({
        recipient_id: applicant.user_id,
        event_type:   'RE_INSPECTION_REJECTED',
        title:        `Re-inspection Request Not Approved — ${request.reference_number}`,
        body:         `Your re-inspection request for ${request.reference_number} was not approved. Reason: ${rejection_reason.trim()}`,
        channel:      'IN_APP',
        is_read:      false,
      });
    }

    return success(res, request, 'Re-inspection request rejected. Applicant has been notified.');
  } catch (err) { next(err); }
};

/**
 * GET /re-inspections/ref/:ref
 * All re-inspection requests for a given reference number.
 */
exports.getByRef = async (req, res, next) => {
  try {
    const requests = await ReInspectionRequest.findAll({
      where: { reference_number: req.params.ref },
      order: [['requested_at', 'DESC']],
    });
    return success(res, requests);
  } catch (err) { next(err); }
};

// Export model for use in models/index.js if needed
exports.ReInspectionRequest = ReInspectionRequest;
