/**
 * toComplaintQueue.controller.js
 *
 * Provides the TO-specific complained-applications queue.
 *
 * Spec: "a queue to show applications which receive complaint after approval
 *        or after submitting his minute on that [TO's inspection]"
 *
 * An application belongs in a TO's complaint queue when ALL of:
 *  1. A Complaint record exists linked to that application's tax_number
 *     (status != 'RESOLVED' and != 'DISMISSED')
 *  2. The requesting TO is the officer who performed the inspection on the
 *     application (TaskAssignment with task_type IN_APP TO_INSPECTION | COR_INSPECTION)
 *
 * GET  /to-complaint-queue             → list for authenticated TO
 * GET  /to-complaint-queue/:id         → single entry with full complaint detail
 * PUT  /to-complaint-queue/:id/acknowledge  → TO marks it seen (does not resolve)
 */

const { Complaint, Application, TaskAssignment, TrackingLine, TrackingNode, AssessmentTaxRecord, Applicant, User } = require('../models');
const { Op } = require('sequelize');
const { success, notFound, badRequest, forbidden } = require('../utils/responseHelper');

// ── Helper: all application_ids where this TO did an inspection ───────────────
const getToApplicationIds = async (officerId) => {
  const tasks = await TaskAssignment.findAll({
    where: {
      assigned_to: officerId,
      task_type: { [Op.in]: ['TO_INSPECTION', 'COR_INSPECTION', 'FURTHER_REVIEW_INSPECTION'] },
    },
    attributes: ['application_id'],
  });
  return [...new Set(tasks.map(t => t.application_id).filter(Boolean))];
};

// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /to-complaint-queue
 * Returns every unresolved complaint whose linked application was inspected by
 * the authenticated TO, enriched with application and complaint details.
 */
exports.getMyComplaintQueue = async (req, res, next) => {
  try {
    if (!['TO', 'ADMIN'].includes(req.user.role)) {
      return forbidden(res, 'Only Technical Officers can access the TO complaint queue');
    }

    const appIds = await getToApplicationIds(req.user.user_id);
    if (!appIds.length) return success(res, []);

    // Fetch applications with their tax number so we can query complaints
    const applications = await Application.findAll({
      where: { application_id: { [Op.in]: appIds } },
      attributes: ['application_id', 'reference_number', 'tax_number', 'status', 'plan_type_id', 'sub_plan_type', 'approval_date'],
      include: [
        {
          model: AssessmentTaxRecord,
          attributes: ['tax_number', 'owner_name', 'address'],
          required: false,
        },
        {
          model: Applicant,
          attributes: ['full_name', 'phone', 'nic'],
          required: false,
        },
      ],
    });

    const taxNumbers = [...new Set(applications.map(a => a.tax_number).filter(Boolean))];
    if (!taxNumbers.length) return success(res, []);

    // Active complaints for those tax numbers
    const complaints = await Complaint.findAll({
      where: {
        tax_number: { [Op.in]: taxNumbers },
        status: { [Op.notIn]: ['RESOLVED', 'DISMISSED'] },
      },
      order: [['created_at', 'DESC']],
    });

    if (!complaints.length) return success(res, []);

    // Build a lookup: tax_number → application
    const appByTax = {};
    for (const app of applications) {
      if (app.tax_number) appByTax[app.tax_number] = app;
    }

    // Merge complaint data with its linked application
    const queue = complaints
      .map(c => {
        const linkedApp = appByTax[c.tax_number] || null;
        return {
          complaint_id:        c.complaint_id,
          tax_number:          c.tax_number,
          reference_number:    c.reference_number || linkedApp?.reference_number || null,
          complainant_name:    c.complainant_name,
          complainant_contact: c.complainant_contact,
          complaint_type:      c.complaint_type,
          description:         c.description,
          status:              c.status,
          is_post_approval:    c.is_post_approval || false,
          filed_at:            c.created_at,
          to_acknowledged_at:  c.to_acknowledged_at || null,
          application: linkedApp ? {
            application_id:  linkedApp.application_id,
            reference_number: linkedApp.reference_number,
            app_status:      linkedApp.status,
            sub_plan_type:   linkedApp.sub_plan_type,
            approval_date:   linkedApp.approval_date,
            owner_name:      linkedApp.AssessmentTaxRecord?.owner_name || linkedApp.Applicant?.full_name || null,
            address:         linkedApp.AssessmentTaxRecord?.address    || null,
          } : null,
        };
      })
      // Only keep entries that map to an application this TO actually inspected
      .filter(item => item.application?.application_id && appIds.includes(item.application.application_id));

    return success(res, queue);
  } catch (err) { next(err); }
};

/**
 * GET /to-complaint-queue/:complaintId
 * Full detail view for a single complaint + linked application tracking summary.
 */
exports.getComplaintDetail = async (req, res, next) => {
  try {
    if (!['TO', 'ADMIN'].includes(req.user.role)) {
      return forbidden(res, 'Only Technical Officers can access this endpoint');
    }

    const complaint = await Complaint.findByPk(req.params.complaintId);
    if (!complaint) return notFound(res, 'Complaint not found');

    // Verify this TO inspected the linked application
    if (complaint.tax_number) {
      const app = await Application.findOne({ where: { tax_number: complaint.tax_number } });
      if (app) {
        const task = await TaskAssignment.findOne({
          where: {
            application_id: app.application_id,
            assigned_to: req.user.user_id,
            task_type: { [Op.in]: ['TO_INSPECTION', 'COR_INSPECTION', 'FURTHER_REVIEW_INSPECTION'] },
          },
        });
        if (!task && req.user.role !== 'ADMIN') {
          return forbidden(res, 'You are not the assigned officer for this application');
        }
      }
    }

    // Pull tracking line for context
    let trackingSummary = null;
    if (complaint.reference_number) {
      const line = await TrackingLine.findOne({ where: { reference_number: complaint.reference_number } });
      if (line) {
        const nodes = await TrackingNode.findAll({
          where: { tracking_line_id: line.tracking_line_id },
          order: [['sequence_number', 'ASC']],
          attributes: ['node_type', 'label', 'status', 'completed_at', 'metadata'],
        });
        trackingSummary = { tracking_line_id: line.tracking_line_id, overall_status: line.overall_status, nodes };
      }
    }

    return success(res, { complaint, tracking: trackingSummary });
  } catch (err) { next(err); }
};

/**
 * PUT /to-complaint-queue/:complaintId/acknowledge
 * TO acknowledges they have seen the complaint.
 * Records a timestamp on the Complaint; does NOT resolve it.
 * Resolving is done via the existing complaint resolution endpoints (SW/PSO).
 */
exports.acknowledgeComplaint = async (req, res, next) => {
  try {
    if (!['TO', 'ADMIN'].includes(req.user.role)) {
      return forbidden(res, 'Only Technical Officers can acknowledge complaints');
    }

    const complaint = await Complaint.findByPk(req.params.complaintId);
    if (!complaint) return notFound(res, 'Complaint not found');

    if (['RESOLVED', 'DISMISSED'].includes(complaint.status)) {
      return badRequest(res, 'This complaint is already resolved or dismissed');
    }

    // Stamp acknowledgement without overwriting an existing one
    if (!complaint.to_acknowledged_at) {
      await complaint.update({
        to_acknowledged_at: new Date(),
        to_acknowledged_by: req.user.user_id,
      });
    }

    return success(res, {
      complaint_id:       complaint.complaint_id,
      to_acknowledged_at: complaint.to_acknowledged_at,
      to_acknowledged_by: complaint.to_acknowledged_by,
    }, 'Complaint acknowledged');
  } catch (err) { next(err); }
};
