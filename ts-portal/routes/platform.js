// Super Admin: create and manage companies. Mounted at /api/ts-portal/platform.
const express = require('express');
const { asyncH, requireSuperAdmin } = require('../lib/access');
const { companiesCol, companyRef, col, now, docs } = require('../lib/store');
const { DEFAULT_SETTINGS, ValidationError, isMonth, validateSettings } = require('../lib/rules');
const { addMember } = require('../lib/members');
const { audit } = require('../lib/audit');
const reports = require('../lib/reports');

const router = express.Router();
router.use(requireSuperAdmin);

const CODE_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
const STATUSES = ['active', 'suspended'];

function validTimezone(tz) {
    try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch (e) { return false; }
}

router.get('/companies', asyncH(async (req, res) => {
    const list = docs(await companiesCol().get());
    const withCounts = await Promise.all(list.map(async c => {
        const members = docs(await col(c.id, 'members').get());
        return {
            id: c.id, name: c.name, status: c.status, timezone: c.timezone, createdAt: c.createdAt,
            memberCount: members.filter(m => m.status !== 'disabled').length,
            admins: members.filter(m => m.role === 'company_admin').map(m => ({ name: m.name, email: m.email }))
        };
    }));
    withCounts.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ companies: withCounts });
}));

router.post('/companies', asyncH(async (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim().slice(0, 120);
    const code = String(b.code || '').trim().toLowerCase();
    const timezone = String(b.timezone || 'Asia/Kolkata');
    if (!name) throw new ValidationError('Company name is required');
    if (!CODE_RE.test(code)) throw new ValidationError('Company code: 2-40 characters, lowercase letters, numbers and dashes');
    if (!validTimezone(timezone)) throw new ValidationError('Unknown time zone');
    if (!b.adminEmail || !b.adminName) throw new ValidationError('First company admin name and email are required');

    const ref = companyRef(code);
    if ((await ref.get()).exists) { const e = new Error('A company with this code already exists'); e.status = 409; throw e; }
    const company = { name, status: 'active', timezone, settings: { ...DEFAULT_SETTINGS }, createdAt: now(), createdBy: req.user.uid };
    await ref.set(company);
    await audit(code, req, 'company.create', code, { name, timezone });
    let admin;
    try {
        admin = await addMember(code, company, { name: b.adminName, email: b.adminEmail, role: 'company_admin' });
    } catch (e) {
        // Leave the company in place (it can be retried from the console) but tell the caller.
        e.message = `Company created, but the admin could not be added: ${e.message}`;
        throw e;
    }
    await audit(code, req, 'member.add', admin.uid, { email: b.adminEmail, role: 'company_admin' });
    res.status(201).json({ id: code, admin });
}));

router.patch('/companies/:cid', asyncH(async (req, res) => {
    const ref = companyRef(req.params.cid);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Company not found' });
    const b = req.body || {};
    const patch = {};
    if (b.name !== undefined) {
        patch.name = String(b.name).trim().slice(0, 120);
        if (!patch.name) throw new ValidationError('Company name is required');
    }
    if (b.status !== undefined) {
        if (!STATUSES.includes(b.status)) throw new ValidationError('Status must be active or suspended');
        patch.status = b.status;
    }
    if (b.timezone !== undefined) {
        if (!validTimezone(b.timezone)) throw new ValidationError('Unknown time zone');
        patch.timezone = b.timezone;
    }
    if (b.settings !== undefined) patch.settings = validateSettings(b.settings, snap.data().settings);
    patch.updatedAt = now();
    await ref.update(patch);
    await audit(req.params.cid, req, 'company.update', req.params.cid, patch);
    res.json({ ok: true });
}));

router.post('/companies/:cid/members', asyncH(async (req, res) => {
    const snap = await companyRef(req.params.cid).get();
    if (!snap.exists) return res.status(404).json({ error: 'Company not found' });
    const role = (req.body && req.body.role) || 'company_admin';
    const r = await addMember(req.params.cid, snap.data(), { ...req.body, role });
    await audit(req.params.cid, req, 'member.add', r.uid, { email: req.body.email, role });
    res.status(201).json(r);
}));

router.get('/companies/:cid/members', asyncH(async (req, res) => {
    const snap = await companyRef(req.params.cid).get();
    if (!snap.exists) return res.status(404).json({ error: 'Company not found' });
    const members = docs(await col(req.params.cid, 'members').get()).map(m => ({ uid: m.id, ...m }));
    members.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ members });
}));

router.get('/companies/:cid/audit', asyncH(async (req, res) => {
    const list = docs(await col(req.params.cid, 'auditLog').get());
    list.sort((a, b) => b.at.localeCompare(a.at));
    res.json({ audit: list.slice(0, 200) });
}));

// Cross-company overview: approved hours and pending sheets per company for a month.
router.get('/summary', asyncH(async (req, res) => {
    const month = String(req.query.month || new Date().toISOString().slice(0, 7));
    if (!isMonth(month)) throw new ValidationError('month must be YYYY-MM');
    const companies = docs(await companiesCol().get());
    const out = await Promise.all(companies.map(async c => {
        const [sheets, members, projects] = await Promise.all([
            reports.loadMonthSheets(c.id, month),
            col(c.id, 'members').get().then(docs),
            col(c.id, 'projects').get().then(s => new Map(docs(s).map(p => [p.id, p])))
        ]);
        const r = reports.aggregate({ month, sheets, members: members.map(m => ({ uid: m.id, ...m })), projects, scope: { all: true }, settings: c.settings });
        return { id: c.id, name: c.name, status: c.status, members: members.filter(m => m.status !== 'disabled').length,
            totalHours: r.totalHours, overtimeHours: r.overtimeHours, sheets: r.sheets };
    }));
    out.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ month, companies: out });
}));

module.exports = router;
