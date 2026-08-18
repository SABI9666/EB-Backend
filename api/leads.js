// api/leads.js
// BDM lead register with follow-up reminders.
//
// A BDM records prospects they are chasing — lead name, country, company,
// work profile, remarks — and can attach a follow-up (1 or 2 weeks). Leads
// whose follow-up date has arrived surface as reminders in the portal.
//
// Access:
//   - BDM: full CRUD on THEIR OWN leads only (same isolation as proposals).
//   - COO/Director: read everything, may update/delete any lead.
// Persists to Firestore collection `bdm_leads`.

const admin = require('./_firebase-admin');
const { verifyToken } = require('../middleware/auth');
const util = require('util');

const db = admin.firestore();

const allowCors = (fn) => async (req, res) => {
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization'
    );
    if (req.method === 'OPTIONS') { res.status(200).end(); return; }
    return await fn(req, res);
};

function s(v) { return (v == null) ? '' : String(v); }
function int(v) { const n = parseInt(v, 10); return isNaN(n) ? 0 : n; }

const STATUSES = ['new', 'contacted', 'in_discussion', 'quoted', 'won', 'lost'];
const WORK_PROFILES = [
    'Structural Steel Detailing', 'Rebar Detailing', 'Connection Design',
    'PEMB', 'Miscellaneous Steel', 'Precast', 'BIM Coordination',
    'Estimation Only', 'EPCM / Full Service', 'Other'
];
// Follow-up choices offered in the portal dropdown; weeks -> days.
const FOLLOW_UP_WEEKS = [0, 1, 2];

function toIso(v) {
    if (!v) return null;
    if (v.toDate) { try { return v.toDate().toISOString(); } catch (e) { return null; } }
    if (v._seconds !== undefined) return new Date(v._seconds * 1000).toISOString();
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d.toISOString();
}

// followUpWeeks 1|2 -> concrete due date; 0/other -> no reminder.
function followUpDateFor(weeks) {
    const w = int(weeks);
    if (!FOLLOW_UP_WEEKS.includes(w) || w === 0) return null;
    const d = new Date();
    d.setDate(d.getDate() + w * 7);
    return d.toISOString();
}

function isDue(iso) {
    if (!iso) return false;
    const d = new Date(iso);
    return !isNaN(d.getTime()) && d.getTime() <= Date.now();
}

// One clean lead object for responses; computes reminder state on read so
// a lead becomes "due" the moment its date passes, with no cron needed.
function shape(id, data) {
    const followUpAt = toIso(data.followUpAt);
    const closed = ['won', 'lost'].includes(s(data.status));
    return {
        id: id,
        leadName: s(data.leadName),
        country: s(data.country),
        company: s(data.company),
        workProfile: s(data.workProfile),
        remarks: s(data.remarks),
        status: STATUSES.includes(s(data.status)) ? s(data.status) : 'new',
        followUpWeeks: int(data.followUpWeeks),
        followUpAt: followUpAt,
        followUpDone: !!data.followUpDone,
        // Reminder fires only while the lead is open and not marked done.
        followUpDue: !closed && !data.followUpDone && isDue(followUpAt),
        createdByUid: s(data.createdByUid),
        createdByName: s(data.createdByName),
        createdAt: toIso(data.createdAt),
        updatedAt: toIso(data.updatedAt)
    };
}

const handler = async (req, res) => {
    try {
        await util.promisify(verifyToken)(req, res);
        const role = String(req.user.role || '').toLowerCase();
        const uid = s(req.user.uid);
        const name = s(req.user.name || req.user.email);
        const isMgmt = ['coo', 'director'].includes(role);
        const isBdm = role === 'bdm';

        if (!isBdm && !isMgmt) {
            return res.status(403).json({ success: false, error: 'Leads are visible to BDM, COO and Director only' });
        }

        // ── GET — list (BDM: own; management: all) ──────────────────────
        if (req.method === 'GET') {
            let snap;
            try {
                snap = await db.collection('bdm_leads').limit(2000).get();
            } catch (e) {
                console.warn('[leads] read failed:', e.message);
                snap = { docs: [] };
            }
            let leads = snap.docs
                .map((d) => shape(d.id, d.data()))
                .filter((l) => isMgmt || l.createdByUid === uid);

            // Newest first; due reminders bubble to the top of the response
            leads.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
            const due = leads.filter((l) => l.followUpDue);

            return res.status(200).json({
                success: true,
                data: {
                    leads: leads,
                    dueFollowUps: due,
                    summary: {
                        total: leads.length,
                        due: due.length,
                        open: leads.filter((l) => !['won', 'lost'].includes(l.status)).length,
                        won: leads.filter((l) => l.status === 'won').length
                    },
                    workProfiles: WORK_PROFILES,
                    statuses: STATUSES
                }
            });
        }

        // ── POST — create (BDM only; management observes, not owns) ─────
        if (req.method === 'POST') {
            if (!isBdm) {
                return res.status(403).json({ success: false, error: 'Only BDM can add leads' });
            }
            const b = req.body || {};
            const leadName = s(b.leadName).trim().slice(0, 160);
            if (!leadName) return res.status(400).json({ success: false, error: 'Lead name is required' });

            const weeks = FOLLOW_UP_WEEKS.includes(int(b.followUpWeeks)) ? int(b.followUpWeeks) : 0;
            const doc = {
                leadName: leadName,
                country: s(b.country).trim().slice(0, 80),
                company: s(b.company).trim().slice(0, 160),
                workProfile: WORK_PROFILES.includes(s(b.workProfile)) ? s(b.workProfile) : s(b.workProfile).trim().slice(0, 80),
                remarks: s(b.remarks).trim().slice(0, 2000),
                status: 'new',
                followUpWeeks: weeks,
                followUpAt: followUpDateFor(weeks),
                followUpDone: false,
                createdByUid: uid,
                createdByName: name,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            };
            const ref = await db.collection('bdm_leads').add(doc);
            console.log(`[leads] created ${ref.id} "${leadName}" by ${name} followUpWeeks=${weeks}`);
            return res.status(201).json({ success: true, data: shape(ref.id, { ...doc, createdAt: new Date(), updatedAt: new Date() }) });
        }

        // ── PUT — update fields / status / follow-up ────────────────────
        if (req.method === 'PUT') {
            const id = s(req.query.id || (req.body && req.body.id));
            if (!id) return res.status(400).json({ success: false, error: 'id is required' });
            const ref = db.collection('bdm_leads').doc(id);
            const snap = await ref.get();
            if (!snap.exists) return res.status(404).json({ success: false, error: 'Lead not found' });
            if (!isMgmt && snap.data().createdByUid !== uid) {
                return res.status(403).json({ success: false, error: 'You can only edit your own leads' });
            }

            const b = req.body || {};
            const up = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
            if (b.leadName !== undefined) {
                const ln = s(b.leadName).trim().slice(0, 160);
                if (!ln) return res.status(400).json({ success: false, error: 'Lead name cannot be empty' });
                up.leadName = ln;
            }
            if (b.country !== undefined) up.country = s(b.country).trim().slice(0, 80);
            if (b.company !== undefined) up.company = s(b.company).trim().slice(0, 160);
            if (b.workProfile !== undefined) up.workProfile = s(b.workProfile).trim().slice(0, 80);
            if (b.remarks !== undefined) up.remarks = s(b.remarks).trim().slice(0, 2000);
            if (b.status !== undefined && STATUSES.includes(s(b.status))) up.status = s(b.status);

            // Setting a new follow-up restarts the clock from today and
            // re-arms the reminder; explicitly done silences it.
            if (b.followUpWeeks !== undefined) {
                const weeks = FOLLOW_UP_WEEKS.includes(int(b.followUpWeeks)) ? int(b.followUpWeeks) : 0;
                up.followUpWeeks = weeks;
                up.followUpAt = followUpDateFor(weeks);
                up.followUpDone = false;
            }
            if (b.followUpDone !== undefined) up.followUpDone = !!b.followUpDone;

            await ref.set(up, { merge: true });
            const fresh = await ref.get();
            console.log(`[leads] updated ${id} by ${name}`);
            return res.status(200).json({ success: true, data: shape(id, fresh.data()) });
        }

        // ── DELETE ──────────────────────────────────────────────────────
        if (req.method === 'DELETE') {
            const id = s(req.query.id);
            if (!id) return res.status(400).json({ success: false, error: 'id is required' });
            const ref = db.collection('bdm_leads').doc(id);
            const snap = await ref.get();
            if (!snap.exists) return res.status(404).json({ success: false, error: 'Lead not found' });
            if (!isMgmt && snap.data().createdByUid !== uid) {
                return res.status(403).json({ success: false, error: 'You can only delete your own leads' });
            }
            await ref.delete();
            console.log(`[leads] deleted ${id} by ${name}`);
            return res.status(200).json({ success: true });
        }

        return res.status(405).json({ success: false, error: 'Method not allowed' });
    } catch (error) {
        console.error('[leads] error:', error);
        if (!res.headersSent) {
            return res.status(500).json({ success: false, error: error.message });
        }
    }
};

module.exports = allowCors(handler);
