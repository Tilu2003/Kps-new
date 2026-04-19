const router = require('express').Router();
const auth   = require('../middleware/auth');
const { allowRoles } = require('../middleware/roleGuard');
const ctrl   = require('../controllers/udaDashboard.controller');

router.use(auth);

const UDA_ROLES = ['UDA', 'ADMIN'];

// Dashboard summary — next meeting, unread count, recent meetings
router.get('/dashboard',                                                     allowRoles(...UDA_ROLES), ctrl.getUDADashboard);

// PC meetings list
router.get('/pc-meetings',                                                   allowRoles(...UDA_ROLES), ctrl.listPCMeetings);

// Single PC meeting with full agenda + tracking lines
router.get('/pc-meetings/:meetingId',                                        allowRoles(...UDA_ROLES), ctrl.getPCMeetingDetail);

// Submit UDA compliance minute on a specific application in a meeting
router.post('/pc-meetings/:meetingId/applications/:appId/minute',           allowRoles(...UDA_ROLES), ctrl.submitUDAMinute);

// Notifications list (marks as read on fetch)
router.get('/notifications',                                                 allowRoles(...UDA_ROLES), ctrl.getNotifications);

module.exports = router;
