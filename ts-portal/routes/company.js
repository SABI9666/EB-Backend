// Company admin: people, projects, settings, reopening sheets.
// Mounted at /api/ts-portal/company behind requireMember.
const express = require('express');
const { asyncH, requireRole, requireManager } = require('../lib/access');
const { companyRef, col, db, now, docs } = require('../lib/store');
const { ROLES, ValidationError, validateSettings } = require('../lib/rules');
const { addMember } = require('../lib/members');
const { audit } = require('../lib/audit');

const router = express.Router();
const adminOnly = requireRole('company_admin');

const memberView = m => ({ uid: m.id, name: m.name, email: m.email, role: m.role, supervisorUid: m.supervisorUid || null, status: m.status || 'active' });

// Managers need the people list to read team views and reports.
router.get('/members', requireManager, asyncH(async (req, res) => {
    const members = docs(await col(req.cid, 'members').get()).map(memberView);
    members.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ members });
}));

async function checkSupervisor(cid, supervisorUid, selfUid) {
    if (!supervisorUid) return null;
    if (supervisorUid === selfUid) throw new ValidationError('A person cannot be their own supervisor');
    const s = await col(cid, 'members').doc(String(supervisorUid)).get();
    if (!s.exists) throw new ValidationError('Supervisor is not a member of this company');
    return String(supervisorUid);
}

router.post('/members', adminOnly, asyncH(async (req, res) => {
    const supervisorUid = await checkSupervisor(req.cid, req.body && req.body.supervisorUid, null);
    const r = await addMember(req.cid, req.membership.company, req.body || {}, { supervisorUid });
    await audit(req.cid, req, 'member.add', r.uid, { email: req.body.email, role: req.body.role || 'employee' });
    res.status(201).json(r);
}));

router.patch('/members/:uid', adminOnly, asyncH(async (req, res) => {
    const uid = req.params.uid;
    const ref = col(req.cid, 'members').doc(uid);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Member not found' });
    const b = req.body || {};
    const patch = {};
    if (b.name !== undefined) {
        patch.name = String(b.name).trim().slice(0, 120);
        if (!patch.name) throw new ValidationError('Name is required');
    }
    if (b.role !== undefined) {
        if (!ROLES.includes(b.role)) throw new ValidationError('Unknown role');
        if (uid === req.user.uid && b.role !== 'company_admin') throw new ValidationError('You cannot remove your own admin role');
        patch.role = b.role;
    }
    if (b.supervisorUid !== undefined) patch.supervisorUid = await checkSupervisor(req.cid, b.supervisorUid, uid);
    if (b.status !== undefined) {
        if (!['active', 'disabled'].includes(b.status)) throw new ValidationError('Status must be active or disabled');
        if (uid === req.user.uid && b.status === 'disabled') throw new ValidationError('You cannot disable yourself');
        patch.status = b.status;
    }
    patch.updatedAt = now();
    await ref.update(patch);
    await audit(req.cid, req, 'member.update', uid, patch);
    res.json({ ok: true });
}));

// ---- Projects ----
const projectView = p => ({ id: p.id, code: p.code, name: p.name, pmUid: p.pmUid || null, memberUids: p.memberUids || [], active: p.active !== false });

router.get('/projects', adminOnly, asyncH(async (req, res) => {
    const projects = docs(await col(req.cid, 'projects').get()).map(projectView);
    projects.sort((a, b) => a.code.localeCompare(b.code));
    res.json({ projects });
}));

async function cleanProject(cid, b, existingId) {
    const out = {};
    if (b.code !== undefined) {
        out.code = String(b.code).trim().toUpperCase().slice(0, 30);
        if (!/^[A-Z0-9][A-Z0-9._/-]*$/.test(out.code)) throw new ValidationError('Project code: letters, numbers, . _ / -');
        const dup = await col(cid, 'projects').where('code', '==', out.code).get();
        if (dup.docs.some(d => d.id !== existingId)) throw new ValidationError('Another project already uses this code');
    }
    if (b.name !== undefined) {
        out.name = String(b.name).trim().slice(0, 160);
        if (!out.name) throw new ValidationError('Project name is required');
    }
    const members = new Set(docs(await col(cid, 'members').get()).map(m => m.id));
    if (b.pmUid !== undefined) {
        out.pmUid = b.pmUid ? String(b.pmUid) : null;
        if (out.pmUid && !members.has(out.pmUid)) throw new ValidationError('Project manager is not a member of this company');
    }
    if (b.memberUids !== undefined) {
        if (!Array.isArray(b.memberUids)) throw new ValidationError('memberUids must be a list');
        out.memberUids = [...new Set(b.memberUids.map(String))];
        if (out.memberUids.some(u => !members.has(u))) throw new ValidationError('Some assigned people are not members of this company');
    }
    if (b.active !== undefined) out.active = !!b.active;
    return out;
}

router.post('/projects', adminOnly, asyncH(async (req, res) => {
    const b = req.body || {};
    if (!b.code || !b.name) throw new ValidationError('Project code and name are required');
    const p = await cleanProject(req.cid, { pmUid: null, memberUids: [], active: true, ...b });
    const ref = await col(req.cid, 'projects').add({ ...p, createdAt: now() });
    await audit(req.cid, req, 'project.create', ref.id, p);
    res.status(201).json({ id: ref.id });
}));

router.patch('/projects/:pid', adminOnly, asyncH(async (req, res) => {
    const ref = col(req.cid, 'projects').doc(req.params.pid);
    if (!(await ref.get()).exists) return res.status(404).json({ error: 'Project not found' });
    const p = await cleanProject(req.cid, req.body || {}, req.params.pid);
    p.updatedAt = now();
    await ref.update(p);
    await audit(req.cid, req, 'project.update', req.params.pid, p);
    res.json({ ok: true });
}));

// ---- Settings ----
router.get('/settings', adminOnly, asyncH(async (req, res) => {
    res.json({ settings: validateSettings({}, req.membership.company.settings || {}), timezone: req.membership.company.timezone });
}));

router.put('/settings', adminOnly, asyncH(async (req, res) => {
    const settings = validateSettings(req.body || {}, req.membership.company.settings || {});
    await companyRef(req.cid).update({ settings, updatedAt: now() });
    await audit(req.cid, req, 'settings.update', 'timesheet', settings);
    res.json({ settings });
}));

// ---- Corrections: reopen a submitted or approved week so the employee can fix it ----
router.post('/sheets/:sheetId/reopen', adminOnly, asyncH(async (req, res) => {
    const reason = String((req.body && req.body.reason) || '').trim().slice(0, 500);
    if (!reason) throw new ValidationError('A reason is required');
    const ref = col(req.cid, 'sheets').doc(req.params.sheetId);
    await db().runTransaction(async tx => {
        const snap = await tx.get(ref);
        if (!snap.exists) { const e = new Error('Timesheet not found'); e.status = 404; throw e; }
        const sh = snap.data();
        if (!['submitted', 'approved'].includes(sh.status)) { const e = new Error('Only submitted or approved weeks can be reopened'); e.status = 409; throw e; }
        tx.update(ref, {
            status: 'returned', pendingApprovers: [], currentStep: null, currentStepType: null,
            returnComment: `Reopened by admin: ${reason}`, approvedAt: null, updatedAt: now(),
            trail: [...(sh.trail || []), { at: now(), byUid: req.user.uid, byName: req.membership.member.name, action: 'reopened', comment: reason }]
        });
    });
    await audit(req.cid, req, 'sheet.reopen', req.params.sheetId, { reason });
    res.json({ ok: true });
}));

router.get('/audit', adminOnly, asyncH(async (req, res) => {
    const list = docs(await col(req.cid, 'auditLog').get());
    list.sort((a, b) => b.at.localeCompare(a.at));
    res.json({ audit: list.slice(0, 200) });
}));

module.exports = router;
