const { col, now } = require('./store');

async function audit(cid, req, action, target, details) {
    try {
        await col(cid, 'auditLog').add({
            at: now(),
            byUid: req.user ? req.user.uid : 'system',
            byEmail: req.user ? req.user.email : 'system',
            bySuperAdmin: !!(req.user && req.user.superAdmin && (!req.membership || req.membership.companyId !== cid)),
            action, target: target || null, details: details || null
        });
    } catch (e) {
        console.error('[ts-portal] audit write failed:', e && e.message);
    }
}
module.exports = { audit };
