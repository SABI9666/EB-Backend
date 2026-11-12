// Adding a person to a company (used by Super Admin and company admins).
const { auth, db, userLinkRef, col, now } = require('./store');
const { ROLES, ValidationError } = require('./rules');
const mailer = require('./mailer');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function cleanMemberInput(b) {
    const email = String(b.email || '').trim().toLowerCase();
    const name = String(b.name || '').trim().slice(0, 120);
    const role = String(b.role || 'employee');
    if (!EMAIL_RE.test(email)) throw new ValidationError('A valid email is required');
    if (!name) throw new ValidationError('Name is required');
    if (!ROLES.includes(role)) throw new ValidationError('Unknown role');
    return { email, name, role };
}

// Creates the Firebase login if needed, links it to the company and emails
// the person. One login belongs to exactly one company.
async function addMember(cid, company, input, extra = {}) {
    const { email, name, role } = cleanMemberInput(input);
    let user;
    let created = false;
    try {
        user = await auth().getUserByEmail(email);
    } catch (e) {
        if (e && e.code && e.code !== 'auth/user-not-found') throw e;
        user = await auth().createUser({ email, displayName: name, emailVerified: false });
        created = true;
    }
    const linkRef = userLinkRef(user.uid);
    const memberRef = col(cid, 'members').doc(user.uid);
    await db().runTransaction(async tx => {
        const [link, existing] = await Promise.all([tx.get(linkRef), tx.get(memberRef)]);
        if (link.exists && link.data().companyId && link.data().companyId !== cid) {
            const err = new Error('This email already belongs to another company in the portal');
            err.status = 409;
            throw err;
        }
        if (existing.exists) {
            const err = new Error('This person is already a member of this company');
            err.status = 409;
            throw err;
        }
        tx.set(linkRef, { companyId: cid, email, linkedAt: now() });
        tx.set(memberRef, {
            name, email, role,
            supervisorUid: extra.supervisorUid || null,
            status: 'active',
            createdAt: now()
        });
    });

    let setPasswordLink = null;
    if (created) {
        // Only for brand-new logins: an existing account keeps its own password.
        setPasswordLink = await auth().generatePasswordResetLink(email, { url: mailer.PORTAL_URL() });
        await mailer.send(email, `You have been invited to ${company.name} timesheets`, mailer.layout(
            `Welcome to ${company.name}`,
            `<p>Hi ${mailer.esc(name)},</p><p>You have been added to the <b>${mailer.esc(company.name)}</b> Timesheet Portal. Click below to set your password, then sign in at <a href="${mailer.esc(mailer.PORTAL_URL())}">${mailer.esc(mailer.PORTAL_URL())}</a>.</p>`,
            { href: setPasswordLink, label: 'Set my password' }));
    } else {
        await mailer.send(email, `You now have access to ${company.name} timesheets`, mailer.layout(
            `Access to ${company.name}`,
            `<p>Hi ${mailer.esc(name)},</p><p>You have been added to the <b>${mailer.esc(company.name)}</b> Timesheet Portal. Sign in with your existing email and password.</p>`,
            { href: mailer.PORTAL_URL(), label: 'Open the Timesheet Portal' }));
    }
    return { uid: user.uid, created, setPasswordLink };
}

module.exports = { addMember, cleanMemberInput };
