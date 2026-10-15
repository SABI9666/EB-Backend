// Purchase project register: project number, contract value and daily site
// cost logs (material, manpower, machinery). Purchase staff record; COO and
// Director approve the project header and review project-wise reports.
// Only the approved header snapshot (`sales`) feeds the sales monitor.
const express = require('express');
const admin = require('./_firebase-admin');
const { verifyToken, requireRole } = require('../middleware/auth');
const router = express.Router();
const CURRENCIES = ['INR', 'USD', 'CAD', 'AUD', 'GBP', 'EUR'];
const STATUSES = ['active', 'on_hold', 'completed', 'cancelled'];
const ENTRY_TYPES = ['material', 'manpower', 'machinery'];
const db = () => admin.firestore();
const collection = () => db().collection('purchase_projects');
const numbers = () => db().collection('purchase_project_numbers');
const fail = (status, message) => Object.assign(new Error(message), { status });
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const actor = req => ({ uid: req.user.uid, name: req.user.name || req.user.email || req.user.uid, role: req.user.role });
const round = value => Math.round(value * 100) / 100;
const emptyTotals = () => ({ material: 0, manpower: 0, machinery: 0, manDays: 0, manHours: 0, machineHours: 0, entries: 0 });
function event(tx, ref, req, action, details) {
    tx.set(ref.collection('activities').doc(), { action, details, actor: actor(req), at: new Date().toISOString() });
}
function text(value, name, max, required = false) {
    if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim())) throw fail(400, `Invalid ${name}`);
    return value.trim();
}
function isoDate(value, name, required = false) {
    const out = text(value ?? '', name, 10, required);
    if (out && (!/^\d{4}-\d{2}-\d{2}$/.test(out) || !Number.isFinite(Date.parse(out)) || new Date(out).toISOString().slice(0, 10) !== out)) throw fail(400, `Invalid ${name}`);
    return out;
}
function number(value, name, { max = 1e12, integer = false, required = true } = {}) {
    if ((value === '' || value === null || value === undefined) && !required) return 0;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max || (integer && !Number.isInteger(value))) throw fail(400, `Invalid ${name}`);
    return round(value);
}
function projectFields(body) {
    const out = {};
    out.name = text(body.name, 'project name', 200, true);
    for (const key of ['client', 'location', 'manager']) out[key] = text(body[key] ?? '', key, 200);
    out.description = text(body.description ?? '', 'description', 4000);
    out.projectValue = number(body.projectValue, 'project value');
    out.currency = text(body.currency, 'currency', 3, true).toUpperCase();
    if (!CURRENCIES.includes(out.currency)) throw fail(400, 'Unsupported currency');
    out.awardDate = isoDate(body.awardDate, 'award / PO date', true);
    out.startDate = isoDate(body.startDate, 'start date');
    out.endDate = isoDate(body.endDate, 'planned completion date');
    if (out.startDate && out.endDate && out.endDate < out.startDate) throw fail(400, 'Planned completion must be on or after the start date');
    if (!STATUSES.includes(body.status)) throw fail(400, 'Invalid project status');
    out.status = body.status;
    out.actualCompletion = isoDate(body.actualCompletion, 'actual completion date');
    if (out.status === 'completed' && !out.actualCompletion) throw fail(400, 'Enter the actual completion date for a completed project');
    if (out.actualCompletion && out.startDate && out.actualCompletion < out.startDate) throw fail(400, 'Actual completion must be on or after the start date');
    if (typeof body.includeInSales !== 'boolean') throw fail(400, 'Choose whether the project value counts in sales');
    out.includeInSales = body.includeInSales;
    return out;
}
// Project numbers are references on purchases and reports, so they are fixed once created.
function projectNumber(value) {
    const out = text(value, 'project number', 40, true).toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9/_.-]*$/.test(out)) throw fail(400, 'Project number may use letters, digits, / _ . and -');
    return out;
}
function entryFields(body) {
    if (!ENTRY_TYPES.includes(body.type)) throw fail(400, 'Invalid entry type');
    const out = { type: body.type, date: isoDate(body.date, 'entry date', true), remarks: text(body.remarks ?? '', 'remarks', 1000) };
    if (out.date > new Date().toISOString().slice(0, 10)) throw fail(400, 'Entry date cannot be in the future');
    if (body.type === 'material') {
        out.description = text(body.description, 'material', 200, true);
        out.unit = text(body.unit ?? '', 'unit', 20);
        out.quantity = number(body.quantity, 'quantity', { max: 1e9 });
        out.rate = number(body.rate, 'rate');
        out.supplier = text(body.supplier ?? '', 'supplier', 200);
        out.reference = text(body.reference ?? '', 'DC / invoice reference', 100);
        out.amount = round(out.quantity * out.rate);
    } else if (body.type === 'manpower') {
        out.description = text(body.description, 'trade / category', 100, true);
        out.workers = number(body.workers, 'number of workers', { max: 10000, integer: true });
        out.hours = number(body.hours, 'hours per worker', { max: 24 });
        out.rate = number(body.rate, 'rate per man-day');
        out.supplier = text(body.supplier ?? '', 'contractor', 200);
        out.amount = round(out.workers * out.rate);
    } else {
        out.description = text(body.description, 'machinery / equipment', 200, true);
        out.units = number(body.units, 'number of units', { max: 1000, integer: true });
        out.hours = number(body.hours, 'working hours', { max: 24 });
        out.rate = number(body.rate, 'rate per hour');
        out.supplier = text(body.supplier ?? '', 'owner / supplier', 200);
        out.amount = round(out.units * out.hours * out.rate);
    }
    if (body.type !== 'material' && (body.type === 'manpower' ? !out.workers : !out.units)) throw fail(400, 'Enter at least one ' + (body.type === 'manpower' ? 'worker' : 'unit'));
    return out;
}
function applyTotals(totals, entry, sign) {
    const t = { ...emptyTotals(), ...totals };
    t[entry.type] = round(t[entry.type] + sign * entry.amount);
    if (entry.type === 'manpower') { t.manDays = round(t.manDays + sign * entry.workers); t.manHours = round(t.manHours + sign * entry.workers * entry.hours); }
    if (entry.type === 'machinery') t.machineHours = round(t.machineHours + sign * entry.units * entry.hours);
    t.entries += sign;
    return t;
}
function checkRecord(snap, version) {
    if (!snap.exists) throw fail(404, 'Project not found');
    const record = snap.data();
    if (version !== record.version) throw fail(409, 'This project changed. Refresh and try again.');
    return record;
}
// The sales portal shows the initial sales value: the value and award date approved
// the first time. Later approvals only change whether the project still counts.
function salesUpdate(record, req, at) {
    const initialSales = record.initialSales || { value: record.projectValue, currency: record.currency, date: record.awardDate, approvedAt: at, approvedBy: actor(req) };
    return { initialSales, sales: { include: record.includeInSales && record.status !== 'cancelled', value: initialSales.value, currency: initialSales.currency, date: initialSales.date } };
}

router.use(verifyToken, requireRole(['purchase', 'coo', 'director']));
router.param('id', (req, res, next, id) => /^[A-Za-z0-9_-]{1,128}$/.test(id) ? next() : next(fail(400, 'Invalid project ID')));
router.get('/', wrap(async (req, res) => {
    const rows = [];
    let last;
    for (;;) {
        let query = collection().orderBy(admin.firestore.FieldPath.documentId()).limit(500);
        if (last) query = query.startAfter(last);
        const page = await query.get();
        rows.push(...page.docs.map(d => ({ ...d.data(), id: d.id })));
        if (page.size < 500 || rows.length >= 5000) break;
        last = page.docs[page.docs.length - 1].id;
    }
    res.set('Cache-Control', 'no-store').json({ success: true, data: rows, role: req.user.role });
}));
router.post('/', requireRole('purchase'), wrap(async (req, res) => {
    const data = projectFields(req.body);
    data.projectNumber = projectNumber(req.body.projectNumber);
    const ref = collection().doc();
    const lock = numbers().doc(encodeURIComponent(data.projectNumber).replace(/\./g, '%2E'));
    const now = new Date().toISOString();
    const record = { ...data, totals: emptyTotals(), sales: null, version: 1, createdAt: now, updatedAt: now, createdBy: actor(req),
        approval: { status: 'pending', kind: 'initial', submittedBy: actor(req), submittedAt: now } };
    await db().runTransaction(async tx => {
        if ((await tx.get(lock)).exists) throw fail(409, `Project number ${data.projectNumber} already exists`);
        tx.set(lock, { projectId: ref.id, at: now });
        tx.set(ref, record);
        event(tx, ref, req, 'created', 'Project created and submitted to COO / Director for approval');
    });
    res.status(201).json({ success: true, data: { ...record, id: ref.id } });
}));
router.get('/:id', wrap(async (req, res) => {
    const ref = collection().doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) throw fail(404, 'Project not found');
    const [entries, activities] = await Promise.all([ref.collection('entries').orderBy('date', 'desc').get(), ref.collection('activities').orderBy('at', 'desc').get()]);
    res.set('Cache-Control', 'no-store').json({ success: true, data: { ...snap.data(), id: snap.id },
        entries: entries.docs.map(d => ({ ...d.data(), id: d.id })), activities: activities.docs.map(d => ({ ...d.data(), id: d.id })) });
}));
// Header edits apply at once but go back to management; sales keep the initial approved value.
router.put('/:id', requireRole('purchase'), wrap(async (req, res) => {
    const data = projectFields(req.body);
    const note = text(req.body.note ?? '', 'reason for change', 2000, true);
    const ref = collection().doc(req.params.id);
    await db().runTransaction(async tx => {
        const record = checkRecord(await tx.get(ref), req.body.version);
        const changed = Object.keys(data).filter(k => data[k] !== record[k]);
        if (!changed.length) throw fail(400, 'No changes to submit');
        const at = new Date().toISOString();
        tx.update(ref, { ...data, version: record.version + 1, updatedAt: at, approval: { status: 'pending', kind: 'edit', submittedBy: actor(req), submittedAt: at } });
        event(tx, ref, req, 'submitted_edit', { note, changed: changed.map(field => ({ field, before: record[field] ?? '', after: data[field] })) });
    });
    res.json({ success: true });
}));
router.post('/:id/decision', requireRole(['coo', 'director']), wrap(async (req, res) => {
    if (!['approved', 'rejected'].includes(req.body.decision)) throw fail(400, 'Choose approve or reject');
    const note = text(req.body.note ?? '', 'decision note', 2000, req.body.decision === 'rejected');
    const ref = collection().doc(req.params.id);
    await db().runTransaction(async tx => {
        const record = checkRecord(await tx.get(ref), req.body.version);
        if (record.approval?.status !== 'pending') throw fail(409, 'This project was already decided. Refresh it.');
        const at = new Date().toISOString(), approved = req.body.decision === 'approved';
        const approval = { ...record.approval, status: req.body.decision, decidedBy: actor(req), decidedAt: at, note };
        tx.update(ref, { approval, version: record.version + 1, updatedAt: at, ...(approved ? { ...salesUpdate(record, req, at), approvedAt: at } : {}) });
        event(tx, ref, req, req.body.decision + '_' + (record.approval.kind || 'initial'), note || (approved ? 'Approved' : 'Rejected'));
    });
    res.json({ success: true });
}));
// Daily site logs are recorded directly and kept on the project for the reports.
router.post('/:id/entries', requireRole('purchase'), wrap(async (req, res) => {
    const data = entryFields(req.body);
    const ref = collection().doc(req.params.id);
    const entry = ref.collection('entries').doc();
    await db().runTransaction(async tx => {
        const snap = await tx.get(ref);
        if (!snap.exists) throw fail(404, 'Project not found');
        const record = snap.data();
        if (['completed', 'cancelled'].includes(record.status)) throw fail(409, 'Completed or cancelled projects cannot receive new entries');
        const at = new Date().toISOString();
        tx.set(entry, { ...data, currency: record.currency, createdBy: actor(req), at });
        tx.update(ref, { totals: applyTotals(record.totals, data, 1), lastEntryDate: [record.lastEntryDate || '', data.date].sort()[1], updatedAt: at });
        event(tx, ref, req, 'added_' + data.type, `${data.date}: ${data.description} · ${record.currency} ${data.amount.toFixed(2)}`);
    });
    res.status(201).json({ success: true, data: { id: entry.id } });
}));
router.post('/:id/entries/:entryId/delete', requireRole('purchase'), wrap(async (req, res) => {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(req.params.entryId)) throw fail(400, 'Invalid entry ID');
    const reason = text(req.body.reason ?? '', 'reason for removal', 1000, true);
    const ref = collection().doc(req.params.id);
    const entryRef = ref.collection('entries').doc(req.params.entryId);
    await db().runTransaction(async tx => {
        const [snap, entrySnap] = [await tx.get(ref), await tx.get(entryRef)];
        if (!snap.exists || !entrySnap.exists) throw fail(404, 'Entry not found');
        const entry = entrySnap.data();
        if (entry.deletedAt) throw fail(409, 'This entry was already removed');
        const at = new Date().toISOString();
        tx.update(entryRef, { deletedAt: at, deletedBy: actor(req), deleteReason: reason });
        tx.update(ref, { totals: applyTotals(snap.data().totals, entry, -1), updatedAt: at });
        event(tx, ref, req, 'removed_' + entry.type, `${entry.date}: ${entry.description} — ${reason}`);
    });
    res.json({ success: true });
}));
router.use((error, req, res, next) => {
    console.error('Purchase projects API:', error.message);
    if (res.headersSent) return next(error);
    res.status(error.status || 500).json({ success: false, error: error.status ? error.message : 'Project operation failed. Please retry.' });
});
module.exports = router;
