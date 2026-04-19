const router = require('express').Router();
const auth   = require('../middleware/auth');
const { allowRoles } = require('../middleware/roleGuard');
const ctrl   = require('../controllers/pcMemberMinute.controller');

router.use(auth);

const PC_MEMBERS = ['PSO', 'SW', 'TO', 'HO', 'RDA', 'GJS', 'UDA', 'CHAIRMAN', 'ADMIN'];

// All member minutes for one application in one meeting (tracking node extraction)
router.get('/meeting/:meetingId/application/:appId',      allowRoles(...PC_MEMBERS), ctrl.getMinutesForApplicationInMeeting);

// Calling user's own minute for a specific application/meeting
router.get('/meeting/:meetingId/application/:appId/my',   allowRoles(...PC_MEMBERS), ctrl.getMyMinuteForApplication);

// All PC minutes for a reference number (across all rounds — used for appeals)
router.get('/ref/:ref',                                   allowRoles(...PC_MEMBERS), ctrl.getAllPCMinutesForRef);

module.exports = router;
