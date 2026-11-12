// Who is calling, which company they belong to, and what they may do.
//
// The company ALWAYS comes from the server-side link tsUsers/{uid}, never from
// the request body or URL, so a user of company A can never reach company B.
// Roles are read from Firestore on every request (no token claims), so a role
// change or a disabled member takes effect immediately and EB Tracker sessions
// on the same Firebase project are never signed out or changed.
const { auth, platformRef, userLinkRef, companyRef, col } = require('./store');
const { MANAGER_ROLES } = require('./rules');

const asyncH = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

async function authenticate(req, res, next) {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Bearer ')) return res.status(401).json({ error: 'Please sign in' });
    let token;
    try {
        token = await auth().verifyIdToken(h.slice(7));
    } catch (e) {
        return res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
    }
    try {
        const uid = token.uid;
        req.user = { uid, email: String(token.email || '').toLowerCase(), name: token.name || '' };
        const [cfg, link] = await Promise.all([platformRef().get(), userLinkRef(uid).get()]);
        req.user.superAdmin = cfg.exists && (cfg.data().superAdminUids || []).includes(uid);
        req.membership = null;
        if (link.exists && link.data().companyId) {
            const cid = link.data().companyId;
            const [c, m] = await Promise.all([companyRef(cid).get(), col(cid, 'members').doc(uid).get()]);
            if (c.exists && m.exists) {
                req.membership = {
                    companyId: cid,
                    company: { id: cid, ...c.data() },
                    member: { uid, ...m.data() }
                };
            }
        }
        next();
    } catch (e) { next(e); }
}

function requireSuperAdmin(req, res, next) {
    if (!req.user || !req.user.superAdmin) return res.status(403).json({ error: 'Super Admin access only' });
    next();
}

function requireMember(req, res, next) {
    const m = req.membership;
    if (!m) return res.status(403).json({ error: 'You are not a member of any company in the Timesheet Portal' });
    if (m.company.status !== 'active') return res.status(403).json({ error: `Your company is ${m.company.status || 'not active'}. Contact the portal administrator.` });
    if (m.member.status === 'disabled') return res.status(403).json({ error: 'Your account has been disabled by your company admin' });
    req.cid = m.companyId;
    req.role = m.member.role;
    next();
}

const requireRole = (...roles) => (req, res, next) =>
    roles.includes(req.role) ? next() : res.status(403).json({ error: 'You do not have permission for this' });
const requireManager = requireRole(...MANAGER_ROLES);

module.exports = { asyncH, authenticate, requireSuperAdmin, requireMember, requireRole, requireManager };
