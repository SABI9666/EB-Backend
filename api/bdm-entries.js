// api/bdm-entries.js
// Manual quote / won / variation entries written by BDM / COO / Director.
// Persisted in `bdm_entries`, surfaced in BDM Analytics alongside COO portal
// data. Designed to need NO composite Firestore index — only the auto-built
// single-field index on `date` is used.
//
// Schema (bdm_entries doc):
//   { type: 'quote'|'won'|'variation', bdmUid, bdmName, date (ISO string),
//     value (number), currency, projectName, projectNumber, clientCompany,
//     notes, createdAt, createdByUid, createdByName }

const admin = require('./_firebase-admin');
const { verifyToken } = require('../middleware/auth');
const util = require('util');

const db = admin.firestore();

const allowCors = (fn) => async (req, res) => {
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization'
    );
    if (req.method === 'OPTIONS') { res.status(200).end(); return; }
    return await fn(req, res);
};

const ALLOWED_CURRENCIES = ['INR', 'USD', 'AUD', 'NZD', 'EUR', 'GBP', 'SGD', 'AED', 'CAD', 'JPY'];

const handler = async (req, res) => {
    try {
        await util.promisify(verifyToken)(req, res);
        const role = String(req.user.role || '').toLowerCase();
        const allowedToWrite = ['bdm', 'coo', 'director'].includes(role);

        if (req.method === 'GET') {
            const { from, to, bdmUid, type } = req.query;
            // Only `orderBy('date')` against the database — no `.where()` here
            // so Firestore never needs a composite index. We then filter the
            // resulting docs in memory. This is what fixes the silent empty
            // list you saw on the BDM upload page.
            let snap;
            try {
                snap = await db.collection('bdm_entries').orderBy('date', 'desc').limit(2000).get();
            } catch (e) {
                // If `date` field is missing on legacy docs (or any other read
                // error), fall back to an unsorted scan so the API still
                // responds — better than a 500 that breaks the page.
                console.warn('bdm-entries: orderBy(date) failed, falling back:', e.message);
                snap = await db.collection('bdm_entries').limit(2000).get();
            }

            let entries = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

            // BDM can only see their own entries. COO / Director see all.
            // (Director portal needs the global view to audit submissions.)
            if (role === 'bdm') {
                entries = entries.filter((e) => e.createdByUid === req.user.uid || e.bdmUid === req.user.uid);
            }

            if (type) entries = entries.filter((e) => String(e.type || '').toLowerCase() === String(type).toLowerCase());
            if (bdmUid) entries = entries.filter((e) => e.bdmUid === bdmUid);

            const fromMs = from ? new Date(from).getTime() : null;
            const toMs = to ? new Date(to).getTime() + 86399999 : null;
            if (fromMs || toMs) {
                entries = entries.filter((e) => {
                    const t = new Date(e.date).getTime();
                    if (fromMs && t < fromMs) return false;
                    if (toMs && t > toMs) return false;
                    return true;
                });
            }

            // Stable date-desc ordering — covers the fallback unsorted path.
            entries.sort((a, b) => new Date(b.date) - new Date(a.date));

            return res.status(200).json({ success: true, entries, count: entries.length });
        }

        if (req.method === 'POST') {
            if (!allowedToWrite) {
                return res.status(403).json({ success: false, error: 'Not allowed' });
            }
            const b = req.body || {};
            const type = String(b.type || 'quote').toLowerCase();
            if (!['quote', 'won', 'variation'].includes(type)) {
                return res.status(400).json({ success: false, error: 'Invalid type' });
            }
            const value = parseFloat(b.value);
            if (isNaN(value) || value < 0) {
                return res.status(400).json({ success: false, error: 'Invalid value' });
            }
            const currency = String(b.currency || 'INR').toUpperCase();
            if (!ALLOWED_CURRENCIES.includes(currency)) {
                return res.status(400).json({ success: false, error: 'Unsupported currency' });
            }
            if (!b.date) {
                return res.status(400).json({ success: false, error: 'Date required' });
            }

            // BDMs can only file under themselves; COO / Director may pick a BDM.
            const bdmUid = (role === 'bdm') ? req.user.uid : (b.bdmUid || req.user.uid);
            const bdmName = (role === 'bdm')
                ? (req.user.name || req.user.email || '')
                : (b.bdmName || req.user.name || '');

            const doc = {
                type,
                bdmUid,
                bdmName: bdmName || '',
                date: new Date(b.date).toISOString(),
                value,
                currency,
                projectName: String(b.projectName || '').trim(),
                projectNumber: String(b.projectNumber || '').trim(),
                clientCompany: String(b.clientCompany || '').trim(),
                notes: String(b.notes || '').trim(),
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                createdByUid: req.user.uid,
                createdByName: req.user.name || req.user.email || ''
            };
            const ref = await db.collection('bdm_entries').add(doc);
            return res.status(200).json({ success: true, id: ref.id, entry: { id: ref.id, ...doc, createdAt: new Date().toISOString() } });
        }

        if (req.method === 'DELETE') {
            const id = req.query.id || (req.body && req.body.id);
            if (!id) return res.status(400).json({ success: false, error: 'id required' });
            const ref = db.collection('bdm_entries').doc(id);
            const snap = await ref.get();
            if (!snap.exists) return res.status(404).json({ success: false, error: 'Not found' });
            const data = snap.data();
            // BDM can delete only their own; COO / Director can delete any.
            if (role === 'bdm' && data.createdByUid !== req.user.uid && data.bdmUid !== req.user.uid) {
                return res.status(403).json({ success: false, error: 'Not allowed' });
            }
            if (!['bdm', 'coo', 'director'].includes(role)) {
                return res.status(403).json({ success: false, error: 'Not allowed' });
            }
            await ref.delete();
            return res.status(200).json({ success: true });
        }

        return res.status(405).json({ success: false, error: 'Method not allowed' });
    } catch (err) {
        console.error('bdm-entries error:', err);
        return res.status(500).json({ success: false, error: 'Internal Server Error', message: err.message });
    }
};

module.exports = allowCors(handler);
module.exports.config = { maxDuration: 30 };
