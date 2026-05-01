// api/bdm-quote-sync.js
// New endpoint that accepts manual BDM quote/won/variation entries from the
// "Upload Quote / Won" form, converts the entered value to INR server-side
// using a fixed rate table, and writes the normalized record to the same
// `bdm_entries` Firestore collection that BDM Analytics already reads.
//
// Why a separate file:
//   - The user wants the rupee value LOCKED IN at save time (so historical
//     reports do not drift when FX rates move) without touching
//     api/bdm-analytics.js or api/bdm-entries.js.
//   - Because the saved record carries currency='INR' and value=<converted>,
//     the existing analytics pass (which calls toInr again) sees a 1:1
//     multiplier and the figure stays exactly as locked-in here.
//
// GET  /api/bdm-quote-sync          -> { fxRates }   (used by the form preview)
// POST /api/bdm-quote-sync   { type, date, value, currency, projectName,
//                              projectNumber, clientCompany, notes,
//                              bdmUid?, bdmName? }   (COO/Director may file
//                              on behalf of any BDM)

const admin = require('./_firebase-admin');
const { verifyToken } = require('../middleware/auth');
const util = require('util');

const db = admin.firestore();

const allowCors = (fn) => async (req, res) => {
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization'
    );
    if (req.method === 'OPTIONS') { res.status(200).end(); return; }
    return await fn(req, res);
};

// Mirrors the table in api/bdm-analytics.js. Kept in this file on purpose so
// the two endpoints can evolve independently (e.g. live-rate fetch later).
const CURRENCY_TO_INR = {
    INR: 1, USD: 83.5, AUD: 55.0, NZD: 51.0, EUR: 90.0,
    GBP: 105.0, SGD: 62.0, AED: 22.7, CAD: 61.0, JPY: 0.55
};

const ALLOWED_CURRENCIES = Object.keys(CURRENCY_TO_INR);
const ALLOWED_TYPES = ['quote', 'won', 'variation'];

function s(v) { return v == null ? '' : String(v); }
function num(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }
function toInr(value, currency) {
    const v = num(value);
    if (!v) return 0;
    const c = String(currency || '').trim().toUpperCase();
    const rate = CURRENCY_TO_INR[c];
    return rate != null ? v * rate : v;
}

const handler = async (req, res) => {
    try {
        await util.promisify(verifyToken)(req, res);
        const role = String(req.user.role || '').toLowerCase();

        if (req.method === 'GET') {
            // Surface FX rates so the form's INR preview matches what the
            // server will lock in.
            return res.status(200).json({ success: true, fxRates: CURRENCY_TO_INR });
        }

        if (req.method !== 'POST') {
            return res.status(405).json({ success: false, error: 'Method not allowed' });
        }

        if (!['bdm', 'coo', 'director'].includes(role)) {
            return res.status(403).json({ success: false, error: 'Not allowed for role: ' + role });
        }

        const userUid = s(req.user.uid || req.user.userId || req.user.id || req.user.email);
        const userEmail = s(req.user.email);
        const userName = s(req.user.name || req.user.displayName || userEmail);

        const b = req.body || {};
        const type = String(b.type || 'quote').toLowerCase();
        if (!ALLOWED_TYPES.includes(type)) {
            return res.status(400).json({ success: false, error: 'Invalid type: ' + type });
        }
        const enteredValue = parseFloat(b.value);
        if (isNaN(enteredValue) || enteredValue < 0) {
            return res.status(400).json({ success: false, error: 'Invalid value: ' + b.value });
        }
        const enteredCurrency = String(b.currency || 'INR').toUpperCase();
        if (!ALLOWED_CURRENCIES.includes(enteredCurrency)) {
            return res.status(400).json({ success: false, error: 'Unsupported currency: ' + enteredCurrency });
        }
        if (!b.date) {
            return res.status(400).json({ success: false, error: 'Date required' });
        }
        const parsedDate = new Date(b.date);
        if (isNaN(parsedDate.getTime())) {
            return res.status(400).json({ success: false, error: 'Invalid date: ' + b.date });
        }
        const dateIso = parsedDate.toISOString();

        const fxRateApplied = CURRENCY_TO_INR[enteredCurrency];
        const valueInr = toInr(enteredValue, enteredCurrency);

        // BDM files under self; COO / Director may file on behalf of a BDM.
        const bdmUidVal = role === 'bdm' ? userUid : s(b.bdmUid || userUid);
        const bdmNameVal = role === 'bdm' ? userName : s(b.bdmName || userName);
        const bdmEmailVal = role === 'bdm' ? userEmail : s(b.bdmEmail || '');

        // Normalized record: currency='INR' and value=<converted>. The
        // existing bdm-analytics.js calls toInr again -- with currency='INR'
        // its rate is 1, so the rupee figure persists unchanged.
        // Persist bdmEmail + createdByEmail alongside the uid fields so the
        // entry can always be tied back to its owner across re-logins, even
        // if the uid resolution shifts.
        const doc = {
            type: type,
            bdmUid: s(bdmUidVal),
            bdmName: s(bdmNameVal),
            bdmEmail: s(bdmEmailVal).toLowerCase(),
            date: dateIso,
            value: valueInr,
            currency: 'INR',
            originalValue: enteredValue,
            originalCurrency: enteredCurrency,
            fxRateApplied: fxRateApplied,
            convertedAt: new Date().toISOString(),
            projectName: s(b.projectName).trim(),
            projectNumber: s(b.projectNumber).trim(),
            clientCompany: s(b.clientCompany).trim(),
            notes: s(b.notes).trim(),
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            createdByUid: s(userUid),
            createdByName: s(userName),
            createdByEmail: s(userEmail).toLowerCase(),
            sourceModule: 'bdm-quote-sync'
        };
        Object.keys(doc).forEach((k) => { if (doc[k] === undefined) doc[k] = ''; });

        let ref;
        try {
            ref = await db.collection('bdm_entries').add(doc);
        } catch (writeErr) {
            console.error('[bdm-quote-sync] Firestore write failed:', writeErr.message, writeErr.stack);
            return res.status(500).json({
                success: false,
                error: 'Failed to save entry to Firestore',
                message: writeErr.message
            });
        }

        let saved;
        try {
            const snap = await ref.get();
            saved = { id: ref.id, ...(snap.data() || {}) };
            if (saved.createdAt && saved.createdAt.toDate) {
                saved.createdAt = saved.createdAt.toDate().toISOString();
            }
        } catch (readErr) {
            console.warn('[bdm-quote-sync] verify read failed (non-fatal):', readErr.message);
            saved = { id: ref.id, ...doc, createdAt: new Date().toISOString() };
        }

        console.log('[bdm-quote-sync] saved id=' + ref.id + ' type=' + type +
            ' ' + enteredCurrency + ' ' + enteredValue + ' -> INR ' + valueInr +
            ' (rate=' + fxRateApplied + ')');

        return res.status(200).json({
            success: true,
            id: ref.id,
            entry: saved,
            conversion: {
                originalValue: enteredValue,
                originalCurrency: enteredCurrency,
                fxRateApplied: fxRateApplied,
                valueInr: valueInr
            }
        });
    } catch (err) {
        console.error('[bdm-quote-sync] handler error:', err.message, err.stack);
        return res.status(500).json({ success: false, error: 'Internal Server Error', message: err.message });
    }
};

module.exports = allowCors(handler);
module.exports.config = { maxDuration: 30 };
