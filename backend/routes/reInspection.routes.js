const router = require('express').Router();
const auth   = require('../middleware/auth');
const { allowRoles } = require('../middleware/roleGuard');
const ctrl   = require('../controllers/reInspection.controller');

router.use(auth);

// Applicant submits a re-inspection request
router.post('/',            allowRoles('APPLICANT', 'PSO', 'ADMIN'), ctrl.createRequest);

// Applicant views their own requests
router.get('/my',           allowRoles('APPLICANT', 'ADMIN'), ctrl.getMyRequests);

// SW views all pending requests
router.get('/pending',      allowRoles('SW', 'PSO', 'ADMIN'), ctrl.getPendingRequests);

// SW approves → creates Inspection + TaskAssignment + TrackingNode
router.put('/:id/approve',  allowRoles('SW', 'ADMIN'), ctrl.approveRequest);

// SW rejects with reason
router.put('/:id/reject',   allowRoles('SW', 'ADMIN'), ctrl.rejectRequest);

// All requests for a reference number (officers / applicant)
router.get('/ref/:ref',     ctrl.getByRef);

module.exports = router;
