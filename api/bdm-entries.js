// api/bdm-entries.js
// Manual quote entries written by BDM / COO / Director for the BDM analytics
// report. Lets the team record a quote (number, value, currency, project,
// date) directly when the COO pricing portal isn't the source of truth.
//
// Collection: `bdm_entries`
//   { type: 'quote', bdmUid, bdmName, date, value (number),
//     currency (e.g. 'INR','USD','AUD'), projectName, projectNumber,
//     clientCompany, notes, createdAt, createdByUid, createdByName }

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
        const role = req.user.role;
        const allowedToWrite = ['bdm', 'coo', 'director'].includes(role);

        if (req.method === 'GET') {
            // List entries. Optional ?from=&to=&bdmUid=&type=
            const { from, to, bdmUid, type } = req.query;
            let q = db.collection('bdm_entries');
            if (type) q = q.where('type', '==', type);
            if (bdmUid) q = q.where('bdmUid', '==', bdmUid);
            const snap = await q.orderBy('date', 'desc').limit(2000).get();
            const fromMs = from ? new Date(from).getTime() : null;
            const toMs = to ? new Date(to).getTime() + 86399999 : null;
            const entries = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((e) => {
                const t = new Date(e.date).getTime();
                if (fromMs && t < fromMs) return false;
                if (toMs && t > toMs) return false;
                return true;
            });
            return res.status(200).json({ success: true, entries });
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
            // BDMs can only file under themselves; COO/Director may pick a BDM.
            const bdmUid = (role === 'bdm') ? req.user.uid : (b.bdmUid || req.user.uid);
            const bdmName = (role === 'bdm') ? (req.user.name || req.user.email) : (b.bdmName || req.user.name);

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
            return res.status(200).json({ success: true, id: ref.id });
        }

        if (req.method === 'DELETE') {
            const id = req.query.id || (req.body && req.body.id);
            if (!id) return res.status(400).json({ success: false, error: 'id required' });
            const snap = await db.collection('bdm_entries').doc(id).get();
            if (!snap.exists) return res.status(404).json({ success: false, error: 'Not found' });
            const data = snap.data();
            // BDM can delete only their own; COO / Director can delete any.
            if (role === 'bdm' && data.createdByUid !== req.user.uid) {
                return res.status(403).json({ success: false, error: 'Not allowed' });
            }
            if (!['bdm', 'coo', 'director'].includes(role)) {
                return res.status(403).json({ success: false, error: 'Not allowed' });
            }
            await db.collection('bdm_entries').doc(id).delete();
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
