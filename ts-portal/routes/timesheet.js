// Everyone in a company: weekly entry, approvals, team view, reports.
// Mounted at /api/ts-portal/ts behind requireMember.
const express = require('express');
const multer = require('multer');
const { asyncH, requireManager } = require('../lib/access');
const { col, db, now, docs } = require('../lib/store');
const R = require('../lib/rules');
const { nextStep } = require('../lib/workflow');
const reports = require('../lib/reports');
const { readRows } = require('../lib/upload');
const mailer = require('../lib/mailer');
const { audit } = require('../lib/audit');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1 } });

const settingsOf = req => R.validateSettings({}, req.membership.company.settings || {});
const sheetId = (uid, ws) => `${uid}_${ws}`;
const SHEET_ID_RE = /^[A-Za-z0-9]{1,128}_\d{4}-\d{2}-\d{2}$/;

async function loadMembers(cid) {
    return docs(await col(cid, 'members').get()).map(m => ({ uid: m.id, ...m }));
}
async function loadProjects(cid) {
    return new Map(docs(await col(cid, 'projects').get()).map(p => [p.id, p]));
}
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
function needWeek(ws) {
    if (!R.isWeekStart(ws)) throw new R.ValidationError('Week must be a Monday date (YYYY-MM-DD)');
    return ws;
}

function sheetView(id, sh, projects) {
    return {
        id, uid: sh.uid, memberName: sh.memberName, weekStart: sh.weekStart, status: sh.status,
        entries: (sh.entries || []).map(e => {
            const p = projects && projects.get(e.projectId);
            return { ...e, projectCode: p ? p.code : '?', projectName: p ? p.name : 'Deleted project' };
        }),
        totalHours: sh.totalHours || 0, overtimeHours: sh.overtimeHours || 0,
        submittedAt: sh.submittedAt || null, approvedAt: sh.approvedAt || null,
        currentStepType: sh.currentStepType || null, approvalSteps: sh.approvalSteps || [],
        returnComment: sh.returnComment || null, trail: sh.trail || []
    };
}

// May the caller look at this sheet?
function canView(req, sh, members, projects) {
    const uid = req.user.uid;
    if (sh.uid === uid) return true;
    if (req.role === 'company_admin' || req.role === 'gm') return true;
    if ((sh.pendingApprovers || []).includes(uid)) return true;
    if ((sh.trail || []).some(t => t.byUid === uid)) return true;
    if (req.role === 'supervisor') return members.some(m => m.uid === sh.uid && m.supervisorUid === uid);
    if (req.role === 'project_manager') return (sh.projectIds || []).some(pid => (projects.get(pid) || {}).pmUid === uid);
    return false;
}

// ---- Projects I can book to ----
router.get('/projects', asyncH(async (req, res) => {
    const projects = [...(await loadProjects(req.cid)).values()]
        .filter(p => p.active !== false && (!(p.memberUids || []).length || p.memberUids.includes(req.user.uid)))
        .map(p => ({ id: p.id, code: p.code, name: p.name }))
        .sort((a, b) => a.code.localeCompare(b.code));
    res.json({ projects });
}));

// ---- My week ----
router.get('/week', asyncH(async (req, res) => {
    const ws = needWeek(String(req.query.start || R.weekStartOf(new Date().toISOString().slice(0, 10))));
    const [snap, projects] = await Promise.all([col(req.cid, 'sheets').doc(sheetId(req.user.uid, ws)).get(), loadProjects(req.cid)]);
    const sheet = snap.exists
        ? sheetView(snap.id, snap.data(), projects)
        : { id: sheetId(req.user.uid, ws), uid: req.user.uid, weekStart: ws, status: 'new', entries: [], totalHours: 0, overtimeHours: 0, trail: [] };
    res.json({ sheet, settings: settingsOf(req), dates: R.weekDates(ws) });
}));

router.put('/week/:ws', asyncH(async (req, res) => {
    const ws = needWeek(req.params.ws);
    const settings = settingsOf(req);
    const projects = await loadProjects(req.cid);
    const { entries, errors } = R.validateEntries((req.body || {}).entries, { weekStart: ws, settings, projects, uid: req.user.uid });
    if (errors.length) return res.status(400).json({ error: 'Please fix the highlighted rows', details: errors });
    const totals = R.computeTotals(entries, settings);
    const ref = col(req.cid, 'sheets').doc(sheetId(req.user.uid, ws));
    await db().runTransaction(async tx => {
        const snap = await tx.get(ref);
        const cur = snap.exists ? snap.data() : null;
        if (cur && !['draft', 'returned'].includes(cur.status)) throw httpError(409, `This week is ${cur.status} and can no longer be edited`);
        tx.set(ref, {
            uid: req.user.uid, memberName: req.membership.member.name, email: req.user.email, weekStart: ws,
            status: cur ? cur.status : 'draft', entries,
            totalHours: totals.totalHours, overtimeHours: totals.overtimeHours, maxDayHours: totals.maxDayHours, projectIds: totals.projectIds,
            pendingApprovers: [], trail: cur ? (cur.trail || []) : [], returnComment: cur ? (cur.returnComment || null) : null,
            createdAt: cur ? cur.createdAt : now(), updatedAt: now()
        });
    });
    res.json({ ok: true, totals });
}));

router.post('/week/:ws/submit', asyncH(async (req, res) => {
    const ws = needWeek(req.params.ws);
    const settings = settingsOf(req);
    const [projects, members] = await Promise.all([loadProjects(req.cid), loadMembers(req.cid)]);
    const ref = col(req.cid, 'sheets').doc(sheetId(req.user.uid, ws));
    let result;
    await db().runTransaction(async tx => {
        const snap = await tx.get(ref);
        if (!snap.exists) throw httpError(409, 'Save your hours before submitting');
        const sh = snap.data();
        if (!['draft', 'returned'].includes(sh.status)) throw httpError(409, `This week is already ${sh.status}`);
        const { entries, errors } = R.validateEntries(sh.entries || [], { weekStart: ws, settings, projects, uid: req.user.uid });
        if (errors.length) throw Object.assign(httpError(400, 'Please fix the highlighted rows'), { details: errors });
        if (!entries.length) throw httpError(400, 'Add some hours before submitting');
        const totals = R.computeTotals(entries, settings);
        const steps = settings.approvalSteps.slice();
        const step = nextStep(steps, 0, { submitterUid: req.user.uid, members, projects, projectIds: totals.projectIds });
        const trail = [...(sh.trail || []), { at: now(), byUid: req.user.uid, byName: req.membership.member.name, action: 'submitted' }];
        const update = {
            entries, totalHours: totals.totalHours, overtimeHours: totals.overtimeHours, maxDayHours: totals.maxDayHours,
            projectIds: totals.projectIds, approvalSteps: steps, submittedAt: now(), returnComment: null, updatedAt: now(), trail
        };
        if (step) Object.assign(update, { status: 'submitted', currentStep: step.stepIndex, currentStepType: step.stepType, pendingApprovers: step.approvers });
        else Object.assign(update, { status: 'approved', approvedAt: now(), currentStep: null, currentStepType: null, pendingApprovers: [],
            trail: [...trail, { at: now(), byUid: 'system', byName: 'System', action: 'approved', comment: 'No approval steps apply' }] });
        tx.update(ref, update);
        result = { status: update.status, approvers: step ? step.approvers : [], stepType: step ? step.stepType : null, totalHours: totals.totalHours };
    });
    if (result.approvers.length) {
        const emails = members.filter(m => result.approvers.includes(m.uid)).map(m => m.email);
        await mailer.send(emails, `Timesheet to approve: ${req.membership.member.name}, week of ${ws}`, mailer.layout(
            'A timesheet is waiting for you',
            `<p><b>${mailer.esc(req.membership.member.name)}</b> submitted <b>${result.totalHours} h</b> for the week of ${ws}.</p>`,
            { href: mailer.PORTAL_URL() + '#/approvals', label: 'Review and approve' }));
    }
    const approverNames = members.filter(m => result.approvers.includes(m.uid)).map(m => m.name);
    res.json({ status: result.status, stepType: result.stepType, approvers: approverNames });
}));

// Who would approve if I submitted now (shown before submitting).
router.get('/week/:ws/route', asyncH(async (req, res) => {
    const ws = needWeek(req.params.ws);
    const settings = settingsOf(req);
    const [projects, members, snap] = await Promise.all([loadProjects(req.cid), loadMembers(req.cid), col(req.cid, 'sheets').doc(sheetId(req.user.uid, ws)).get()]);
    const projectIds = snap.exists ? (snap.data().projectIds || []) : [];
    const names = uids => members.filter(m => uids.includes(m.uid)).map(m => m.name);
    const ctx = { submitterUid: req.user.uid, members, projects, projectIds };
    const route = [];
    let i = 0, step;
    while ((step = nextStep(settings.approvalSteps, i, ctx))) {
        route.push({ step: step.stepType, approvers: names(step.approvers) });
        i = step.stepIndex + 1;
    }
    res.json({ route });
}));

// Upload an Excel/CSV file: returns rows to load into the grid. Nothing is saved.
router.post('/week/:ws/upload', upload.single('file'), asyncH(async (req, res) => {
    const ws = needWeek(req.params.ws);
    if (!req.file) throw new R.ValidationError('Choose a .xlsx or .csv file');
    const rows = await readRows(req.file);
    const projects = await loadProjects(req.cid);
    const byCode = new Map([...projects.values()].map(p => [String(p.code).toUpperCase(), p]));
    const errors = [];
    const mapped = [];
    rows.forEach((r, i) => {
        const p = byCode.get(r.projectCode.toUpperCase());
        if (!p) { errors.push({ row: i + 2, error: `Unknown project code "${r.projectCode}"` }); return; }
        mapped.push({ row: i + 2, projectId: p.id, date: r.date, hours: r.hours, note: r.note });
    });
    const { entries, errors: vErrors } = R.validateEntries(mapped, { weekStart: ws, settings: settingsOf(req), projects, uid: req.user.uid });
    vErrors.forEach(e => errors.push({ row: e.row == null ? null : mapped[e.row].row, error: e.error }));
    errors.sort((a, b) => (a.row || 0) - (b.row || 0));
    res.json({ entries: errors.length ? [] : entries, errors, rowCount: rows.length });
}));

router.get('/history', asyncH(async (req, res) => {
    const list = docs(await col(req.cid, 'sheets').where('uid', '==', req.user.uid).get());
    list.sort((a, b) => b.weekStart.localeCompare(a.weekStart));
    res.json({ sheets: list.slice(0, 104).map(s => ({ id: s.id, weekStart: s.weekStart, status: s.status, totalHours: s.totalHours || 0,
        overtimeHours: s.overtimeHours || 0, currentStepType: s.currentStepType || null, returnComment: s.returnComment || null })) });
}));

// ---- Approvals ----
router.get('/approvals', asyncH(async (req, res) => {
    const list = docs(await col(req.cid, 'sheets').where('pendingApprovers', 'array-contains', req.user.uid).get())
        .filter(s => s.status === 'submitted');
    list.sort((a, b) => String(a.submittedAt).localeCompare(String(b.submittedAt)));
    res.json({ approvals: list.map(s => ({ id: s.id, memberName: s.memberName, weekStart: s.weekStart, totalHours: s.totalHours,
        overtimeHours: s.overtimeHours, submittedAt: s.submittedAt, stepType: s.currentStepType })) });
}));

router.get('/sheets/:id', asyncH(async (req, res) => {
    if (!SHEET_ID_RE.test(req.params.id)) return res.status(404).json({ error: 'Timesheet not found' });
    const [snap, members, projects] = await Promise.all([col(req.cid, 'sheets').doc(req.params.id).get(), loadMembers(req.cid), loadProjects(req.cid)]);
    if (!snap.exists || !canView(req, snap.data(), members, projects)) return res.status(404).json({ error: 'Timesheet not found' });
    const sh = snap.data();
    res.json({ sheet: sheetView(snap.id, sh, projects), canDecide: sh.status === 'submitted' && sh.uid !== req.user.uid
        && ((sh.pendingApprovers || []).includes(req.user.uid) || req.role === 'company_admin'), dates: R.weekDates(sh.weekStart) });
}));

router.post('/sheets/:id/decide', asyncH(async (req, res) => {
    if (!SHEET_ID_RE.test(req.params.id)) return res.status(404).json({ error: 'Timesheet not found' });
    const decision = String((req.body || {}).decision || '');
    const comment = String((req.body || {}).comment || '').trim().slice(0, 1000);
    if (!['approve', 'return'].includes(decision)) throw new R.ValidationError('decision must be approve or return');
    if (decision === 'return' && !comment) throw new R.ValidationError('Please say what needs to be fixed');
    const [members, projects] = await Promise.all([loadMembers(req.cid), loadProjects(req.cid)]);
    const ref = col(req.cid, 'sheets').doc(req.params.id);
    let out;
    await db().runTransaction(async tx => {
        const snap = await tx.get(ref);
        if (!snap.exists) throw httpError(404, 'Timesheet not found');
        const sh = snap.data();
        if (sh.status !== 'submitted') throw httpError(409, `This week is already ${sh.status}`);
        if (sh.uid === req.user.uid) throw httpError(403, 'You cannot approve your own timesheet');
        const isApprover = (sh.pendingApprovers || []).includes(req.user.uid);
        if (!isApprover && req.role !== 'company_admin') throw httpError(403, 'This timesheet is not waiting for you');
        const entry = { at: now(), byUid: req.user.uid, byName: req.membership.member.name, step: sh.currentStepType,
            action: decision === 'approve' ? 'approved' : 'returned', comment: comment || null, override: !isApprover || undefined };
        if (entry.override === undefined) delete entry.override;
        const trail = [...(sh.trail || []), entry];
        if (decision === 'return') {
            tx.update(ref, { status: 'returned', returnComment: comment, pendingApprovers: [], currentStep: null, currentStepType: null, trail, updatedAt: now() });
            out = { status: 'returned', sheet: sh };
            return;
        }
        const step = nextStep(sh.approvalSteps || [], (sh.currentStep || 0) + 1,
            { submitterUid: sh.uid, members, projects, projectIds: sh.projectIds || [] });
        if (step) {
            tx.update(ref, { currentStep: step.stepIndex, currentStepType: step.stepType, pendingApprovers: step.approvers, trail, updatedAt: now() });
            out = { status: 'submitted', nextApprovers: step.approvers, sheet: sh };
        } else {
            tx.update(ref, { status: 'approved', approvedAt: now(), currentStep: null, currentStepType: null, pendingApprovers: [], trail, updatedAt: now() });
            out = { status: 'approved', sheet: sh };
        }
    });
    await audit(req.cid, req, `sheet.${decision}`, req.params.id, { comment: comment || null });
    const sh = out.sheet;
    const owner = members.find(m => m.uid === sh.uid);
    if (out.status === 'returned') {
        await mailer.send(owner && owner.email, `Timesheet returned: week of ${sh.weekStart}`, mailer.layout('Your timesheet needs changes',
            `<p>${mailer.esc(req.membership.member.name)} returned your timesheet for the week of ${sh.weekStart}:</p><blockquote>${mailer.esc(comment)}</blockquote>`,
            { href: `${mailer.PORTAL_URL()}#/week/${sh.weekStart}`, label: 'Fix and resubmit' }));
    } else if (out.status === 'approved') {
        await mailer.send(owner && owner.email, `Timesheet approved: week of ${sh.weekStart}`, mailer.layout('Your timesheet is approved',
            `<p>Your timesheet for the week of ${sh.weekStart} (${sh.totalHours} h) has been approved.</p>`));
    } else {
        await mailer.send(members.filter(m => out.nextApprovers.includes(m.uid)).map(m => m.email),
            `Timesheet to approve: ${sh.memberName}, week of ${sh.weekStart}`, mailer.layout('A timesheet is waiting for you',
                `<p><b>${mailer.esc(sh.memberName)}</b>'s timesheet for the week of ${sh.weekStart} (${sh.totalHours} h) needs your approval.</p>`,
                { href: mailer.PORTAL_URL() + '#/approvals', label: 'Review and approve' }));
    }
    res.json({ status: out.status });
}));

// ---- Team overview: who has submitted this week ----
router.get('/team', requireManager, asyncH(async (req, res) => {
    const ws = needWeek(String(req.query.week || R.weekStartOf(new Date().toISOString().slice(0, 10))));
    const [members, projects, sheets] = await Promise.all([loadMembers(req.cid), loadProjects(req.cid),
        col(req.cid, 'sheets').where('weekStart', '==', ws).get().then(docs)]);
    const uid = req.user.uid;
    let inScope;
    if (req.role === 'company_admin' || req.role === 'gm') inScope = () => true;
    else if (req.role === 'supervisor') inScope = m => m.supervisorUid === uid;
    else {
        const mine = [...projects.values()].filter(p => p.pmUid === uid);
        const assigned = new Set(mine.flatMap(p => p.memberUids || []));
        const booked = new Set(sheets.filter(s => (s.projectIds || []).some(pid => mine.some(p => p.id === pid))).map(s => s.uid));
        inScope = m => assigned.has(m.uid) || booked.has(m.uid);
    }
    const byUid = new Map(sheets.map(s => [s.uid, s]));
    const team = members.filter(m => m.status !== 'disabled' && m.uid !== uid && inScope(m)).map(m => {
        const s = byUid.get(m.uid);
        return { uid: m.uid, name: m.name, role: m.role, sheetId: s ? s.id : null, status: s ? s.status : 'missing',
            totalHours: s ? s.totalHours || 0 : 0, overtimeHours: s ? s.overtimeHours || 0 : 0, stepType: s ? s.currentStepType || null : null };
    }).sort((a, b) => a.name.localeCompare(b.name));
    res.json({ weekStart: ws, team });
}));

// ---- Reports for managers ----
async function buildReport(req) {
    const month = String(req.query.month || new Date().toISOString().slice(0, 7));
    if (!R.isMonth(month)) throw new R.ValidationError('month must be YYYY-MM');
    const [members, projects, sheets] = await Promise.all([loadMembers(req.cid), loadProjects(req.cid), reports.loadMonthSheets(req.cid, month)]);
    const scope = reports.scopeFor(req.role, req.user.uid, members, projects);
    return reports.aggregate({ month, sheets, members, projects, scope, settings: settingsOf(req) });
}

router.get('/reports/summary', requireManager, asyncH(async (req, res) => {
    const r = await buildReport(req);
    const scopeLabel = { gm: 'Whole company', company_admin: 'Whole company', project_manager: 'Projects you manage', supervisor: 'Your team' }[req.role];
    res.json({ ...r, rows: undefined, scope: scopeLabel });
}));

router.get('/reports/export', requireManager, asyncH(async (req, res) => {
    const r = await buildReport(req);
    const buf = await reports.buildWorkbook(r, req.membership.company.name);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="timesheets-${req.cid}-${r.month}.xlsx"`);
    res.send(Buffer.from(buf));
}));

module.exports = router;
