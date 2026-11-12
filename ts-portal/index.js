// Timesheet Portal API: a separate multi-company product that shares only the
// server and the Firebase login with EB Tracker. Mounted at /api/ts-portal.
// It uses its own "ts*" Firestore collections and never touches EB Tracker data.
const express = require('express');
const { authenticate, requireMember, asyncH } = require('./lib/access');
const R = require('./lib/rules');

const router = express.Router();

router.use('/internal', require('./routes/internal'));

router.use(authenticate);

// Who am I? Used by the sign-in page to decide which screen to open.
router.get('/me', asyncH(async (req, res) => {
    const m = req.membership;
    res.json({
        user: { uid: req.user.uid, email: req.user.email, superAdmin: !!req.user.superAdmin },
        membership: m ? {
            companyId: m.companyId, companyName: m.company.name, companyStatus: m.company.status, timezone: m.company.timezone,
            name: m.member.name, role: m.member.role, status: m.member.status || 'active',
            settings: R.validateSettings({}, m.company.settings || {})
        } : null
    });
}));

router.use('/platform', require('./routes/platform'));
router.use('/company', requireMember, require('./routes/company'));
router.use('/ts', requireMember, require('./routes/timesheet'));

router.use((req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
    const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 400 : 500);
    if (status >= 500) console.error('[ts-portal] error:', err);
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'The file is too large (max 2 MB)'
        : status >= 500 ? 'Something went wrong. Please try again.' : err.message;
    res.status(status).json({ error: message, details: err.details });
});

module.exports = router;
