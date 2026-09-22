// Purchase staff maintain entries; COO and Director approve submitted requests.
const express = require('express');
const multer = require('multer');
const os = require('os');
const fs = require('fs/promises');
const { randomUUID } = require('crypto');
const admin = require('./_firebase-admin');
const { verifyToken, requireRole } = require('../middleware/auth');
const router = express.Router();
const STAGES = ['rfq', 'quote', 'compare', 'approval', 'po', 'delivery', 'match', 'payment', 'closed'];
const TYPES = ['requirement', 'quotation', 'comparison', 'approval', 'po', 'delivery', 'invoice', 'receipt', 'other'];
const db = () => admin.firestore();
const collection = () => db().collection('purchases');
const fail = (status, message) => Object.assign(new Error(message), { status });
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const actor = req => ({ uid: req.user.uid, name: req.user.name || req.user.email || req.user.uid, role: req.user.role });
function event(tx, ref, req, action, details) {
    tx.set(ref.collection('activities').doc(), { action, details, actor: actor(req), at: new Date().toISOString() });
}
function text(value, name, max, required = false) {
    if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim())) throw fail(400, `Invalid ${name}`);
    return value.trim();
}
function fields(body) {
    const out = {};
    for (const key of ['project', 'item', 'qty']) out[key] = text(body[key], key, 200, true);
    for (const key of ['vendor', 'reference', 'specification', 'paymentReference']) out[key] = text(body[key] ?? '', key, key === 'specification' ? 4000 : 200);
    out.currency = text(body.currency, 'currency', 3, true).toUpperCase();
    if (!['INR', 'USD', 'CAD', 'AUD', 'GBP', 'EUR'].includes(out.currency)) throw fail(400, 'Unsupported currency');
    if (typeof body.amount !== 'number' || !Number.isFinite(body.amount) || body.amount < 0 || body.amount > 1e12) throw fail(400, 'Invalid amount');
    out.amount = Math.round(body.amount * 100) / 100;
    out.requiredBy = text(body.requiredBy ?? '', 'required date', 10);
    if (out.requiredBy && (!/^\d{4}-\d{2}-\d{2}$/.test(out.requiredBy) || !Number.isFinite(Date.parse(out.requiredBy)) || new Date(out.requiredBy).toISOString().slice(0, 10) !== out.requiredBy)) throw fail(400, 'Invalid required date');
    if (!['normal', 'urgent'].includes(body.priority)) throw fail(400, 'Invalid priority');
    out.priority = body.priority;
    return out;
}
// The live record is unchanged while a proposed operation awaits a decision.
function checkRecord(snap, version) {
    if (!snap.exists || snap.data().deletedAt) throw fail(404, 'Purchase not found');
    const record = snap.data();
    if (version !== record.version) throw fail(409, 'This purchase changed. Refresh and try again.');
    return record;
}
function queueChange(tx, ref, record, req, change) {
    if (record.approval?.status === 'pending') throw fail(409, 'An operation is already awaiting approval.');
    const at = new Date().toISOString();
    tx.update(ref, {
        pendingChange: { ...change, previousApproval: record.approval || { status: 'draft' } },
        approval: { status: 'pending', kind: change.kind, submittedBy: actor(req), submittedAt: at },
        version: record.version + 1, updatedAt: at
    });
    event(tx, ref, req, 'submitted_' + change.kind, change.note || 'Submitted to COO / Director for approval');
}
router.use(verifyToken, requireRole(['purchase', 'coo', 'director']));
router.param('id', (req, res, next, id) => /^[A-Za-z0-9_-]{1,128}$/.test(id) ? next() : next(fail(400, 'Invalid purchase ID')));
router.get('/', wrap(async (req, res) => {
    // Cursor pagination avoids silently dropping older purchases.
    let query = collection().orderBy(admin.firestore.FieldPath.documentId()).limit(100);
    if (req.query.after) query = query.startAfter(text(req.query.after, 'cursor', 128, true));
    const snap = await query.get();
    res.json({ success: true, data: snap.docs.filter(d => !d.data().deletedAt).map(d => ({ ...d.data(), id: d.id })), next: snap.size === 100 ? snap.docs[snap.size - 1].id : null, role: req.user.role });
}));
router.post('/', requireRole('purchase'), wrap(async (req, res) => {
    const data = fields(req.body);
    const ref = collection().doc();
    const now = new Date().toISOString();
    const record = { ...data, stage: 'rfq', approval: { status: 'pending', kind: 'initial', submittedBy: actor(req), submittedAt: now }, pendingChange: { kind: 'initial', previousApproval: { status: 'draft' } }, version: 1, createdAt: now, updatedAt: now, createdBy: actor(req) };
    const batch = db().batch();
    batch.set(ref, record);
    event(batch, ref, req, 'created', 'Purchase created and submitted to COO / Director for initial approval');
    await batch.commit();
    res.status(201).json({ success: true, data: { ...record, id: ref.id } });
}));
router.get('/:id', wrap(async (req, res) => {
    const ref = collection().doc(req.params.id);
    const record = await ref.get();
    if (!record.exists) throw fail(404, 'Purchase not found');
    const [activities, documents] = await Promise.all([ref.collection('activities').orderBy('at', 'desc').get(), ref.collection('documents').orderBy('at', 'desc').get()]);
    res.json({ success: true, data: { ...record.data(), id: record.id }, activities: activities.docs.map(d => ({ ...d.data(), id: d.id })), documents: documents.docs.map(d => { const { storagePath, ...data } = d.data(); return { ...data, id: d.id }; }) });
}));
router.put('/:id', requireRole('purchase'), wrap(async (req, res) => {
    const data = fields(req.body);
    if (!STAGES.includes(req.body.stage) || req.body.stage === 'approval') throw fail(400, 'Invalid stage');
    const note = text(req.body.note ?? '', 'reason for change', 2000, true);
    const ref = collection().doc(req.params.id);
    await db().runTransaction(async tx => {
        const record = checkRecord(await tx.get(ref), req.body.version);
        if (record.stage === 'closed') throw fail(409, 'Closed purchases cannot be edited');
        if (STAGES.indexOf(req.body.stage) >= STAGES.indexOf('po') && record.approval?.status !== 'approved') throw fail(409, 'Initial approval is required before later process stages.');
        if (req.body.stage === 'closed' && !data.paymentReference) throw fail(400, 'Payment / closure reference is required to close');
        if (Object.keys(data).every(k => data[k] === record[k]) && req.body.stage === record.stage) throw fail(400, 'No changes to submit');
        queueChange(tx, ref, record, req, { kind: 'edit', data, stage: req.body.stage, note });
    });
    res.json({ success: true });
}));
router.post('/:id/delete-request', requireRole('purchase'), wrap(async (req, res) => {
    const note = text(req.body.note ?? '', 'reason for deletion', 2000, true);
    const ref = collection().doc(req.params.id);
    await db().runTransaction(async tx => {
        const record = checkRecord(await tx.get(ref), req.body.version);
        queueChange(tx, ref, record, req, { kind: 'delete', note });
    });
    res.json({ success: true });
}));
// Older saved drafts can be submitted from the register without reopening a form.
router.post('/:id/submit', requireRole('purchase'), wrap(async (req, res) => {
    const ref = collection().doc(req.params.id);
    await db().runTransaction(async tx => {
        const record = checkRecord(await tx.get(ref), req.body.version);
        if (record.stage === 'closed' || record.approval?.status === 'approved') throw fail(409, 'This purchase cannot be submitted now.');
        queueChange(tx, ref, record, req, { kind: 'initial' });
    });
    res.json({ success: true });
}));
router.post('/:id/withdraw', requireRole('purchase'), wrap(async (req, res) => {
    const ref = collection().doc(req.params.id);
    await db().runTransaction(async tx => {
        const record = checkRecord(await tx.get(ref), req.body.version);
        if (record.approval?.status !== 'pending') throw fail(409, 'No pending request to withdraw');
        const change = record.pendingChange || { kind: 'initial', previousApproval: { status: 'draft' } };
        const at = new Date().toISOString();
        if (change.documentId) tx.update(ref.collection('documents').doc(change.documentId), { status: 'withdrawn' });
        tx.update(ref, { pendingChange: null, approval: change.previousApproval, stage: record.stage === 'approval' ? 'rfq' : record.stage, version: record.version + 1, updatedAt: at });
        event(tx, ref, req, 'withdrawn_' + change.kind, 'Pending operation withdrawn; existing entry preserved');
    });
    res.json({ success: true });
}));
router.post('/:id/decision', requireRole(['coo', 'director']), wrap(async (req, res) => {
    if (!['approved', 'rejected'].includes(req.body.decision)) throw fail(400, 'Choose approve or reject');
    const note = text(req.body.note ?? '', 'decision note', 2000, req.body.decision === 'rejected');
    const ref = collection().doc(req.params.id);
    await db().runTransaction(async tx => {
        const record = checkRecord(await tx.get(ref), req.body.version);
        // Let management review legacy drafts shown in the existing register too.
        if (!['pending', 'draft'].includes(record.approval?.status || 'draft')) throw fail(409, 'This request was already decided. Refresh it.');
        const change = record.pendingChange || { kind: 'initial', previousApproval: { status: 'draft' } };
        if ((record.approval?.submittedBy || record.createdBy)?.uid === req.user.uid) throw fail(403, 'You cannot approve your own submission');
        const at = new Date().toISOString(), approved = req.body.decision === 'approved';
        const decision = { ...record.approval, status: req.body.decision, kind: change.kind, decidedBy: actor(req), decidedAt: at, note };
        const updates = { pendingChange: null, lastDecision: decision, updatedAt: at, version: record.version + 1,
            approval: approved || change.kind === 'initial' ? decision : change.previousApproval,
            stage: record.stage === 'approval' ? 'rfq' : record.stage };
        if (approved && change.kind === 'edit') Object.assign(updates, change.data, { stage: change.stage });
        if (approved && change.kind === 'document') updates.stage = change.stage;
        if (approved && change.kind === 'delete') Object.assign(updates, { deletedAt: at, deletedBy: actor(req) });
        if (change.documentId) tx.update(ref.collection('documents').doc(change.documentId), { status: req.body.decision, decidedBy: actor(req), decidedAt: at, note });
        tx.update(ref, updates);
        event(tx, ref, req, req.body.decision + '_' + change.kind, {
            from: record.stage, to: updates.stage, note: [change.note, note].filter(Boolean).join(' — '),
            changed: change.data ? Object.keys(change.data).filter(k => change.data[k] !== record[k]).map(field => ({ field, before: record[field] ?? '', after: change.data[field] })) : [],
            documentId: change.documentId || null
        });
    });
    res.json({ success: true });
}));
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 2, fieldSize: 100, parts: 4 } }).single('file');
router.post('/:id/documents', requireRole('purchase'), (req, res, next) => upload(req, res, error => error ? next(fail(400, error.code === 'LIMIT_FILE_SIZE' ? 'Maximum file size is 10 MB' : 'Invalid upload')) : next()), wrap(async (req, res) => {
    let stored;
    let committed = false;
    try {
        if (!req.file) throw fail(400, 'Select a PDF, PNG or JPEG file');
        if (!TYPES.includes(req.body.type)) throw fail(400, 'Invalid document category');
        const filename = text(req.file.originalname, 'filename', 200, true).replace(/[\r\n"\\/]/g, '_');
        const buffer = await fs.readFile(req.file.path);
        const ext = filename.split('.').pop().toLowerCase();
        let contentType;
        if (ext === 'pdf' && buffer.subarray(0, 5).toString() === '%PDF-') contentType = 'application/pdf';
        if (ext === 'png' && buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) contentType = 'image/png';
        if (['jpg', 'jpeg'].includes(ext) && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) contentType = 'image/jpeg';
        if (!contentType) throw fail(400, 'File content must match a PDF, PNG or JPEG extension');
        const ref = collection().doc(req.params.id);
        if (!(await ref.get()).exists) throw fail(404, 'Purchase not found');
        const doc = ref.collection('documents').doc();
        const storagePath = `purchase-documents/${ref.id}/${randomUUID()}`;
        stored = admin.storage().bucket().file(storagePath);
        await stored.save(buffer, { resumable: false, metadata: { contentType, cacheControl: 'private, no-store' } });
        await db().runTransaction(async tx => {
            const snap = await tx.get(ref);
            if (!snap.exists) throw fail(404, 'Purchase not found');
            const record = checkRecord(snap, Number(req.body.version));
            if (record.approval?.status !== 'approved') throw fail(409, 'Approve the current request before adding another process document.');
            if (record.stage === 'closed') throw fail(409, 'Closed purchases cannot receive uploads');
            const at = new Date().toISOString();
            const stageByType = { requirement: 'rfq', quotation: 'quote', comparison: 'compare', approval: 'compare', po: 'po', delivery: 'delivery', invoice: 'match', receipt: 'payment' };
            const proposedStage = stageByType[req.body.type] || record.stage;
            // Supporting files never move a later approved process backwards.
            const stage = STAGES.indexOf(proposedStage) > STAGES.indexOf(record.stage) ? proposedStage : record.stage;
            tx.set(doc, { filename, contentType, size: buffer.length, type: req.body.type, storagePath, actor: actor(req), at, status: 'pending' });
            queueChange(tx, ref, record, req, { kind: 'document', documentId: doc.id, documentType: req.body.type, filename, stage, note: req.body.type + ': ' + filename });

        });
        committed = true;
        res.status(201).json({ success: true });
    } finally {
        if (req.file) await fs.unlink(req.file.path).catch(() => {});
        if (stored && !committed) await stored.delete().catch(error => console.error('Purchase upload cleanup failed', error.code));
    }
}));
router.get('/:id/documents/:documentId', wrap(async (req, res) => {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(req.params.documentId)) throw fail(400, 'Invalid document ID');
    const doc = await collection().doc(req.params.id).collection('documents').doc(req.params.documentId).get();
    if (!doc.exists) throw fail(404, 'Document not found');
    const data = doc.data();
    res.set({ 'Content-Type': data.contentType, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(data.filename)}`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    const stream = admin.storage().bucket().file(data.storagePath).createReadStream();
    stream.on('error', () => { if (!res.headersSent) res.status(502).json({ success: false, error: 'Unable to download document' }); else res.destroy(); });
    res.on('close', () => stream.destroy());
    stream.pipe(res);
}));
router.use((error, req, res, next) => {
    console.error('Purchase API:', error.message);
    if (res.headersSent) return next(error);
    res.status(error.status || 500).json({ success: false, error: error.status ? error.message : 'Purchase operation failed. Please retry.' });
});
module.exports = router;
