// api/account-variations.js - Accounts-initiated variation uploads
//
// Lets users with the `accounts` role upload a variation entry containing:
//   - BDM (selected from active BDM users) — captured as bdmUid + bdmName
//   - Variation file (PDF / Word / image)
//   - Variation value + currency
//   - Optional description / reference / scope
//
// Data lives in its own `accountVariations` Firestore collection so it does
// NOT collide with the existing design-lead-driven `variations` collection.
//
// Visibility:
//   - accounts: full CRUD on entries they uploaded (and read all entries)
//   - coo / director: read all (shown in the COO Variation Tracker)
//   - bdm: read entries where `bdmUid == req.user.uid` (shown in their portal)

const admin = require('./_firebase-admin');
const { verifyToken } = require('../middleware/auth');
const util = require('util');
const multer = require('multer');

const db = admin.firestore();
const bucket = admin.storage().bucket();

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = [
            'application/pdf',
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/vnd.ms-excel',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'image/png',
            'image/jpeg',
            'image/jpg'
        ];
        if (allowed.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Only PDF, Word, Excel, or image files are allowed for variation uploads.'));
        }
    }
});

const allowCors = fn => async (req, res) => {
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST,PUT,DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');
    if (req.method === 'OPTIONS') { res.status(200).end(); return; }
    return await fn(req, res);
};

function sanitizeForFirestore(obj) {
    const sanitized = {};
    for (const [key, value] of Object.entries(obj)) {
        if (value !== undefined) sanitized[key] = value;
    }
    return sanitized;
}

const handler = async (req, res) => {
    try {
        if (req.method === 'POST') {
            return upload.single('variationFile')(req, res, async (multerErr) => {
                if (multerErr) {
                    return res.status(400).json({ success: false, error: multerErr.message });
                }
                try {
                    await util.promisify(verifyToken)(req, res);
                } catch (authErr) {
                    return res.status(401).json({ success: false, error: 'Authentication failed.' });
                }
                if (!['accounts', 'coo', 'director'].includes(req.user.role)) {
                    return res.status(403).json({ success: false, error: 'Only Accounts users can upload account variations.' });
                }
                const { bdmUid, bdmName, bdmEmail, variationValue, currency, description, referenceCode, projectName } = req.body;
                if (!bdmUid || !bdmName) {
                    return res.status(400).json({ success: false, error: 'BDM (bdmUid + bdmName) is required.' });
                }
                if (variationValue === undefined || variationValue === null || variationValue === '') {
                    return res.status(400).json({ success: false, error: 'Variation value is required.' });
                }
                const parsedValue = parseFloat(variationValue);
                if (isNaN(parsedValue) || parsedValue < 0) {
                    return res.status(400).json({ success: false, error: 'Variation value must be a non-negative number.' });
                }
                const bdmDoc = await db.collection('users').doc(bdmUid).get();
                if (!bdmDoc.exists) {
                    return res.status(404).json({ success: false, error: 'Selected BDM not found.' });
                }
                const bdmData = bdmDoc.data();
                if (bdmData.role !== 'bdm') {
                    return res.status(400).json({ success: false, error: 'Selected user is not a BDM.' });
                }
                let fileUrl = null, fileOriginalName = null, fileStoragePath = null, fileContentType = null, fileSize = null;
                if (req.file) {
                    const file = req.file;
                    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
                    const storagePath = `account-variations/${bdmUid}/${Date.now()}-${safeName}`;
                    const fileRef = bucket.file(storagePath);
                    await fileRef.save(file.buffer, { contentType: file.mimetype, metadata: { contentType: file.mimetype } });
                    await fileRef.makePublic().catch(e => console.log('Note: Could not make account-variation file public:', e.message));
                    fileUrl = `https://storage.googleapis.com/${bucket.name}/${storagePath}`;
                    fileOriginalName = file.originalname;
                    fileStoragePath = storagePath;
                    fileContentType = file.mimetype;
                    fileSize = file.size;
                }
                const docData = sanitizeForFirestore({
                    bdmUid, bdmName, bdmEmail: bdmEmail || bdmData.email || null,
                    variationValue: parsedValue,
                    currency: (currency || 'INR').toString().toUpperCase(),
                    description: description || null,
                    referenceCode: referenceCode || null,
                    projectName: projectName || null,
                    fileUrl, fileOriginalName, fileStoragePath, fileContentType, fileSize,
                    status: 'submitted', source: 'accounts',
                    uploadedByUid: req.user.uid,
                    uploadedByName: req.user.name,
                    uploadedByRole: req.user.role,
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
                const ref = await db.collection('accountVariations').add(docData);
                await db.collection('activities').add({
                    type: 'account_variation_uploaded',
                    details: `Accounts uploaded a variation for ${bdmName} — ${(currency || 'INR').toUpperCase()} ${parsedValue}`,
                    performedByName: req.user.name,
                    performedByRole: req.user.role,
                    performedByUid: req.user.uid,
                    timestamp: admin.firestore.FieldValue.serverTimestamp(),
                    accountVariationId: ref.id, bdmUid, bdmName
                }).catch(e => console.warn('activity log failed:', e.message));
                await db.collection('notifications').add({
                    type: 'account_variation_uploaded',
                    recipientUid: bdmUid, recipientRole: 'bdm',
                    message: `Accounts uploaded a new variation for you (${(currency || 'INR').toUpperCase()} ${parsedValue}).`,
                    accountVariationId: ref.id, priority: 'normal',
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    isRead: false
                }).catch(e => console.warn('BDM notification failed:', e.message));
                try {
                    const cooSnap = await db.collection('users').where('role', '==', 'coo').get();
                    const promises = [];
                    cooSnap.forEach(d => {
                        promises.push(db.collection('notifications').add({
                            type: 'account_variation_uploaded',
                            recipientUid: d.id, recipientRole: 'coo',
                            message: `New accounts variation for ${bdmName}: ${(currency || 'INR').toUpperCase()} ${parsedValue}.`,
                            accountVariationId: ref.id, priority: 'normal',
                            createdAt: admin.firestore.FieldValue.serverTimestamp(),
                            isRead: false
                        }));
                    });
                    await Promise.all(promises);
                } catch (e) { console.warn('COO notification failed:', e.message); }
                return res.status(200).json({ success: true, message: 'Account variation uploaded successfully.', id: ref.id });
            });
        }
        await util.promisify(verifyToken)(req, res);
        if ((req.method === 'PUT' || req.method === 'DELETE') &&
            (req.headers['content-type'] || '').includes('application/json')) {
            if (!req.body || Object.keys(req.body).length === 0) {
                await new Promise((resolve) => {
                    const chunks = [];
                    req.on('data', c => chunks.push(c));
                    req.on('end', () => {
                        try {
                            const buf = Buffer.concat(chunks);
                            req.body = buf.length > 0 ? JSON.parse(buf.toString()) : {};
                        } catch (e) { req.body = {}; }
                        resolve();
                    });
                });
            }
        }
        if (req.method === 'GET') {
            const { id, bdmUid } = req.query;
            const role = req.user.role;
            if (!['accounts', 'coo', 'director', 'bdm'].includes(role)) {
                return res.status(403).json({ success: false, error: 'Permission denied.' });
            }
            if (id) {
                const doc = await db.collection('accountVariations').doc(id).get();
                if (!doc.exists) return res.status(404).json({ success: false, error: 'Account variation not found.' });
                const data = doc.data();
                if (role === 'bdm' && data.bdmUid !== req.user.uid) {
                    return res.status(403).json({ success: false, error: 'Permission denied.' });
                }
                return res.status(200).json({ success: true, data: { id: doc.id, ...data } });
            }
            let query = db.collection('accountVariations');
            if (role === 'bdm') query = query.where('bdmUid', '==', req.user.uid);
            else if (bdmUid) query = query.where('bdmUid', '==', bdmUid);
            let snapshot;
            try { snapshot = await query.orderBy('createdAt', 'desc').get(); }
            catch (e) { snapshot = await query.get(); }
            const list = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
            list.sort((a, b) => {
                const ta = a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : 0;
                const tb = b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : 0;
                return tb - ta;
            });
            return res.status(200).json({ success: true, data: list });
        }
        if (req.method === 'PUT') {
            const { id } = req.query;
            if (!id) return res.status(400).json({ success: false, error: 'id is required.' });
            if (!['accounts', 'coo', 'director'].includes(req.user.role)) {
                return res.status(403).json({ success: false, error: 'Permission denied.' });
            }
            const ref = db.collection('accountVariations').doc(id);
            const snap = await ref.get();
            if (!snap.exists) return res.status(404).json({ success: false, error: 'Account variation not found.' });
            const body = req.body || {};
            const updates = sanitizeForFirestore({
                variationValue: body.variationValue !== undefined ? parseFloat(body.variationValue) : undefined,
                currency: body.currency !== undefined ? String(body.currency).toUpperCase() : undefined,
                description: body.description !== undefined ? (body.description || null) : undefined,
                referenceCode: body.referenceCode !== undefined ? (body.referenceCode || null) : undefined,
                projectName: body.projectName !== undefined ? (body.projectName || null) : undefined,
                status: body.status !== undefined ? body.status : undefined,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedByUid: req.user.uid,
                updatedByName: req.user.name
            });
            await ref.update(updates);
            return res.status(200).json({ success: true, message: 'Account variation updated.' });
        }
        if (req.method === 'DELETE') {
            const { id } = req.query;
            if (!id) return res.status(400).json({ success: false, error: 'id is required.' });
            if (!['accounts', 'coo', 'director'].includes(req.user.role)) {
                return res.status(403).json({ success: false, error: 'Permission denied.' });
            }
            const ref = db.collection('accountVariations').doc(id);
            const snap = await ref.get();
            if (!snap.exists) return res.status(404).json({ success: false, error: 'Account variation not found.' });
            const data = snap.data();
            if (data.fileStoragePath) {
                try { await bucket.file(data.fileStoragePath).delete(); }
                catch (e) { console.warn('Could not delete storage object:', e.message); }
            }
            await ref.delete();
            return res.status(200).json({ success: true, message: 'Account variation deleted.' });
        }
        return res.status(405).json({ success: false, error: 'Method not allowed' });
    } catch (error) {
        console.error('account-variations API error:', error);
        return res.status(500).json({ success: false, error: 'Internal Server Error', message: error.message });
    }
};

module.exports = allowCors(handler);
