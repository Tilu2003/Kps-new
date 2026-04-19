const router = require('express').Router();
const auth   = require('../middleware/auth');
const { allowRoles } = require('../middleware/roleGuard');
const ctrl   = require('../controllers/toComplaintQueue.controller');

router.use(auth);

// GET  /to-complaint-queue              — TO's full complaint queue list
router.get('/',                         allowRoles('TO', 'ADMIN'), ctrl.getMyComplaintQueue);

// GET  /to-complaint-queue/:complaintId — single complaint detail + tracking
router.get('/:complaintId',             allowRoles('TO', 'ADMIN'), ctrl.getComplaintDetail);

// PUT  /to-complaint-queue/:complaintId/acknowledge — TO marks complaint seen
router.put('/:complaintId/acknowledge', allowRoles('TO', 'ADMIN'), ctrl.acknowledgeComplaint);

module.exports = router;
