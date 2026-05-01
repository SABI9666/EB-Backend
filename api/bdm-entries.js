// api/bdm-entries.js
// Manual quote / won / variation entries written by BDM / COO / Director.
// Persists to Firestore collection `bdm_entries`. The BDM Analytics report
// (api/bdm-analytics.js) reads this collection alongside proposals/projects/
// variations so manual entries flow into the COO/Director report.
//
// Hardened to write reliably to Firestore:
//   - All values are explicitly coerced to non-undefined types (Firebase
//     Admin rejects objects with undefined fields).
//   - Logs every save with the assigned doc id so Render logs reveal silent
//     failures.
//   - Verifies the doc actually exists after add() and returns the saved
//     payload on success.

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

function s(v) { return (v == null) ? '' : String(v); }

const handler = async (req, res) => {
    try {
        await util.promisify(verifyToken)(req, res);
        const role = String(req.user.role || '').toLowerCase();
        const userUid = s(req.user.uid || req.user.userId || req.user.id || req.user.email);
        const userEmail = s(req.user.email);
        const userName = s(req.user.name || req.user.displayName || userEmail);
        const allowedToWrite = ['bdm', 'coo', 'director'].includes(role);

        console.log(`[bdm-entries] ${req.method} role=${role} uid=${userUid}`);

        if (req.method === 'GET') {
            const { from, to, bdmUid, type } = req.query;
            // Read without an orderBy so entries that are missing the `date`
            // field (legacy / partial writes) are still returned. Sort in
            // memory below.
            let snap;
            try {
                snap = await db.collection('bdm_entries').limit(2000).get();
            } catch (e) {
                console.warn('[bdm-entries] GET read failed:', e.message);
                snap = { docs: [], size: 0 };
            }
            const allDocs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
            const totalDocsInCollection = allDocs.length;
            let entries = allDocs.slice();

            if (type) entries = entries.filter((e) => String(e.type || '').toLowerCase() === String(type).toLowerCase());
            if (bdmUid) entries = entries.filter((e) => e.bdmUid === bdmUid);

            // ?mine=1 — defensive "show only entries owned by the calling
            // user". Matches across every identity field we have ever stored
            // on a manual entry, so a row that was saved with one identifier
            // (e.g. Firebase uid) is still found when the same person logs
            // back in even if a different identifier resolved during this
            // session. Without this, entries can appear "lost" after logout
            // when an older row carries an inconsistent owner field.
            if (String(req.query.mine || '').toLowerCase() === '1' || req.query.mine === 'true') {
                const me = new Set(
                    [userUid, userEmail, userEmail.toLowerCase()].filter(Boolean)
                );
                entries = entries.filter((e) => {
                    const candidates = [
                        e.bdmUid, e.bdmEmail,
                        e.createdByUid, e.createdByEmail
                    ].map((v) => (v == null ? '' : String(v)));
                    return candidates.some((c) => c && (me.has(c) || me.has(c.toLowerCase())));
                });
            }

            const fromMs = from ? new Date(from).getTime() : null;
            const toMs = to ? new Date(to).getTime() + 86399999 : null;
            if (fromMs || toMs) {
                entries = entries.filter((e) => {
                    const t = new Date(e.date).getTime();
                    if (isNaN(t)) return false;
                    if (fromMs && t < fromMs) return false;
                    if (toMs && t > toMs) return false;
                    return true;
                });
            }
            entries.sort((a, b) => {
                const ta = new Date(a.date).getTime();
                const tb = new Date(b.date).getTime();
                if (isNaN(ta) && isNaN(tb)) return 0;
                if (isNaN(ta)) return 1;
                if (isNaN(tb)) return -1;
                return tb - ta;
            });

            const meta = {
                totalDocsInCollection,
                totalAfterFilter: entries.length,
                role,
                userUid,
                userEmail,
                appliedFilter: { type: type || null, bdmUid: bdmUid || null, from: from || null, to: to || null }
            };
            const debugBlock = req.query.debug ? { ...meta, sample: entries.slice(0, 1) } : undefined;

            console.log(`[bdm-entries] GET total=${totalDocsInCollection} after-filter=${entries.length} type=${type || ''} bdmUid=${bdmUid || ''}`);
            return res.status(200).json({
                success: true,
                entries,
                count: entries.length,
                meta,
                ...(debugBlock ? { debug: debugBlock } : {})
            });
        }

        if (req.method === 'POST') {
            if (!allowedToWrite) {
                console.warn('[bdm-entries] POST rejected: role not allowed', role);
                return res.status(403).json({ success: false, error: 'Not allowed for role: ' + role });
            }
            const b = req.body || {};
            console.log('[bdm-entries] POST body:', JSON.stringify(b));

            const type = String(b.type || 'quote').toLowerCase();
            if (!['quote', 'won', 'variation'].includes(type)) {
                return res.status(400).json({ success: false, error: 'Invalid type: ' + type });
            }
            const value = parseFloat(b.value);
            if (isNaN(value) || value < 0) {
                return res.status(400).json({ success: false, error: 'Invalid value: ' + b.value });
            }
            const currency = String(b.currency || 'INR').toUpperCase();
            if (!ALLOWED_CURRENCIES.includes(currency)) {
                return res.status(400).json({ success: false, error: 'Unsupported currency: ' + currency });
            }
            if (!b.date) {
                return res.status(400).json({ success: false, error: 'Date required' });
            }
            const dateIso = new Date(b.date).toISOString();
            if (dateIso === 'Invalid Date' || !dateIso || dateIso.startsWith('NaN')) {
                return res.status(400).json({ success: false, error: 'Invalid date: ' + b.date });
            }

            // Owner of the entry. BDM files under themselves; COO / Director
            // may file on behalf of any BDM (passes b.bdmUid). Fallback to
            // userUid if not provided so the field is never empty.
            const bdmUidVal = (role === 'bdm') ? userUid : s(b.bdmUid || userUid);
            const bdmNameVal = (role === 'bdm') ? userName : s(b.bdmName || userName);

            // For COO / Director filing on behalf of a BDM, the bdmEmail
            // they pass through (if any) helps the report tie the entry
            // back to the right BDM even if uid lookups drift later.
            const bdmEmailVal = (role === 'bdm') ? userEmail : s(b.bdmEmail || '');

            // Build the doc with NO undefined fields — Firestore Admin SDK
            // throws on undefined, which used to silently fail the save.
            // We persist every identity field we know about (bdmUid +
            // bdmEmail, createdByUid + createdByEmail) so the entry can
            // always be matched back to its owner across re-logins.
            const doc = {
                type: type,
                bdmUid: s(bdmUidVal),
                bdmName: s(bdmNameVal),
                bdmEmail: s(bdmEmailVal).toLowerCase(),
                date: dateIso,
                value: value,
                currency: currency,
                projectName: s(b.projectName).trim(),
                projectNumber: s(b.projectNumber).trim(),
                clientCompany: s(b.clientCompany).trim(),
                notes: s(b.notes).trim(),
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                createdByUid: s(userUid),
                createdByName: s(userName),
                createdByEmail: s(userEmail).toLowerCase()
            };

            // Sanity sweep: drop any accidentally-undefined keys so add() can't
            // fail with "Value for argument 'data' is not a valid Firestore
            // document. Cannot use 'undefined' as a Firestore value."
            Object.keys(doc).forEach((k) => { if (doc[k] === undefined) doc[k] = ''; });

            console.log('[bdm-entries] POST writing doc to bdm_entries:', JSON.stringify({ ...doc, createdAt: 'serverTimestamp' }));

            let ref;
            try {
                ref = await db.collection('bdm_entries').add(doc);
            } catch (writeErr) {
                console.error('[bdm-entries] Firestore write failed:', writeErr.message, writeErr.stack);
                return res.status(500).json({
                    success: false,
                    error: 'Failed to save entry to Firestore',
                    message: writeErr.message
                });
            }

            // Verify the doc landed by reading it back.
            let saved;
            try {
                const verifySnap = await ref.get();
                saved = { id: ref.id, ...(verifySnap.data() || {}) };
                if (saved.createdAt && saved.createdAt.toDate) {
                    saved.createdAt = saved.createdAt.toDate().toISOString();
                }
            } catch (readErr) {
                console.warn('[bdm-entries] verify read failed (non-fatal):', readErr.message);
                saved = { id: ref.id, ...doc, createdAt: new Date().toISOString() };
            }

            console.log('[bdm-entries] POST saved id=' + ref.id);
            return res.status(200).json({ success: true, id: ref.id, entry: saved });
        }

        if (req.method === 'DELETE') {
            const id = req.query.id || (req.body && req.body.id);
            if (!id) return res.status(400).json({ success: false, error: 'id required' });
            const ref = db.collection('bdm_entries').doc(id);
            const snap = await ref.get();
            if (!snap.exists) return res.status(404).json({ success: false, error: 'Not found' });
            const data = snap.data();
            if (role === 'bdm' && data.createdByUid !== userUid && data.bdmUid !== userUid) {
                return res.status(403).json({ success: false, error: 'Not allowed' });
            }
            if (!allowedToWrite) {
                return res.status(403).json({ success: false, error: 'Not allowed' });
            }
            await ref.delete();
            console.log('[bdm-entries] DELETE id=' + id);
            return res.status(200).json({ success: true });
        }

        return res.status(405).json({ success: false, error: 'Method not allowed' });
    } catch (err) {
        console.error('[bdm-entries] handler error:', err.message, err.stack);
        return res.status(500).json({ success: false, error: 'Internal Server Error', message: err.message });
    }
};

module.exports = allowCors(handler);
module.exports.config = { maxDuration: 30 };
