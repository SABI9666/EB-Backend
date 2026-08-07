// api/tekla-reports.js
// Tekla Structures model-report ingestion + COO/Director reporting.
//
// Two ways data gets in:
//   1. MACHINE PUSH — a Tekla Open API plugin / PowerShell watcher running on
//      a detailing workstation POSTs JSON with header `X-Tekla-Api-Key`
//      matching process.env.TEKLA_API_KEY. No Firebase login needed, so the
//      desktop side stays simple. See TEKLA_INTEGRATION.md.
//   2. PORTAL ENTRY — a designer / design lead / COO / Director logged into
//      the web app posts a report (manual form or CSV import) with their
//      normal Bearer token.
//
// Reports persist to Firestore collection `tekla_reports`. GET returns the
// raw list (newest first) plus a per-model summary (latest report per
// project+model) that the COO/Director "Tekla Reports" view renders.

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
        'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization, X-Tekla-Api-Key'
    );
    if (req.method === 'OPTIONS') { res.status(200).end(); return; }
    return await fn(req, res);
};

function s(v) { return (v == null) ? '' : String(v); }
function num(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }
function int(v) { const n = parseInt(v, 10); return isNaN(n) ? 0 : n; }

const REPORT_TYPES = ['model_summary', 'drawing_status', 'material_list', 'phase_report', 'other'];
// Viewing is restricted to management ONLY.
const READ_ROLES = ['coo', 'director'];
const MAX_ROWS = 500;
const MAX_PENDING_ITEMS = 50;

// Completion percentages, computed server-side so the portal never trusts
// client math. Targets come from a management-set PLAN (tekla_plans, set by
// COO/Director in the portal) with model-supplied values as fallback only —
// the plan deliberately wins, so a designer editing model attributes cannot
// inflate completion. Modeling % = modeled vs planned tonnage; drawing % =
// issued vs target/total drawings.
function computeProgress(metrics, plan, activities) {
    const m = metrics || {};
    const p = plan || {};

    const plannedTonnage = num(p.plannedTonnage) > 0 ? num(p.plannedTonnage) : num(m.plannedTonnage);
    const drawingsTotal = int(p.targetDrawings) > 0 ? int(p.targetDrawings) : int(m.drawingsTotal);
    const drawingsIssued = int(m.drawingsIssued);

    let modelingPercent = null;
    if (plannedTonnage > 0) modelingPercent = Math.min(100, (num(m.tonnage) / plannedTonnage) * 100);
    else if (m.modelingPercent > 0) modelingPercent = Math.min(100, num(m.modelingPercent));

    let drawingPercent = null;
    if (drawingsTotal > 0) drawingPercent = Math.min(100, (drawingsIssued / drawingsTotal) * 100);

    // Activity-reported percentages refine the derived ones. A workstation
    // that reports 'modeling' / 'drafting' explicitly overrides the value
    // inferred from tonnage / drawing counts.
    const acts = activities || {};
    if (acts.modeling && acts.modeling.percent !== null && acts.modeling.percent !== undefined) {
        modelingPercent = acts.modeling.percent;
    }
    if (acts.drafting && acts.drafting.percent !== null && acts.drafting.percent !== undefined) {
        drawingPercent = acts.drafting.percent;
    }

    // Overall = mean of every activity that reported a percentage, falling
    // back to the two derived figures when no activities were sent.
    const actPcts = Object.keys(acts)
        .map((k) => acts[k] && acts[k].percent)
        .filter((v) => v !== null && v !== undefined);
    const parts = actPcts.length ? actPcts : [modelingPercent, drawingPercent].filter((v) => v !== null);
    const overallPercent = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : null;

    const pending = [];
    if (plannedTonnage > num(m.tonnage)) {
        pending.push((plannedTonnage - num(m.tonnage)).toFixed(1) + ' T modeling remaining');
    }
    if (drawingsTotal > drawingsIssued) {
        pending.push((drawingsTotal - drawingsIssued) + ' drawings pending');
    }
    Object.keys(acts).forEach((k) => {
        const a = acts[k];
        if (!a) return;
        if (a.percent !== null && a.percent !== undefined && a.percent < 100) {
            const left = (a.total > 0 && a.done >= 0 && a.total > a.done)
                ? ' (' + (a.total - a.done) + ' ' + (a.unit || 'items') + ' left)' : '';
            pending.push(k + ' at ' + a.percent + '%' + left);
        }
    });

    const round1 = (v) => (v === null ? null : Math.round(v * 10) / 10);
    return {
        modelingPercent: round1(modelingPercent),
        drawingPercent: round1(drawingPercent),
        overallPercent: round1(overallPercent),
        plannedTonnage: plannedTonnage || null,
        targetDrawings: drawingsTotal || null,
        derivedPending: pending
    };
}

// ── Per-activity progress ──────────────────────────────────────────────
// Detailing, drafting, checking etc. are tracked SEPARATELY from raw model
// metrics so each process reports its own status. The Tekla workstation
// pushes these; the portal renders one row per activity.
const ACTIVITY_KEYS = [
    'modeling', 'connection', 'detailing', 'drafting',
    'checking', 'revisions', 'nc', 'ifc', 'bbs'
];
const WORK_TYPES = ['steel', 'rebar'];

// Advertised to the portal on every GET. Without this the portal cannot
// tell "the deployed API is too old to store per-process figures" apart
// from "this particular report was pushed before the API was updated" —
// two problems with completely different fixes.
const CAPABILITIES = {
    apiVersion: 3,
    activities: true,      // per-process percent / done / total accepted
    activitySource: true,  // auto (computed by macro) vs manual (typed)
    designerRollup: true   // per-designer push tracking in the summary
};

// Accepts either { detailing: {...}, drafting: {...} } or
// [ { key:'detailing', ... }, ... ]. Unknown keys are ignored.
function normalizeActivities(input) {
    const out = {};
    if (!input) return out;
    const entries = Array.isArray(input)
        ? input.map((a) => [s(a && a.key).toLowerCase(), a])
        : Object.keys(input).map((k) => [s(k).toLowerCase(), input[k]]);

    entries.forEach(([key, a]) => {
        if (!key || !ACTIVITY_KEYS.includes(key) || !a || typeof a !== 'object') return;
        const done = int(a.done);
        const total = int(a.total);
        // Explicit percent wins; otherwise derive from done/total.
        let pct = null;
        if (a.percent !== undefined && a.percent !== null && a.percent !== '') {
            pct = Math.max(0, Math.min(100, num(a.percent)));
        } else if (total > 0) {
            pct = Math.max(0, Math.min(100, (done / total) * 100));
        }
        out[key] = {
            percent: pct === null ? null : Math.round(pct * 10) / 10,
            done: done,
            total: total,
            unit: s(a.unit).slice(0, 20),
            note: s(a.note).slice(0, 300),
            // 'auto'   = computed by the macro from the model itself
            // 'manual' = typed by the designer
            source: s(a.source).toLowerCase() === 'auto' ? 'auto' : 'manual',
            updatedAt: new Date().toISOString()
        };
    });
    return out;
}

function isToday(iso) {
    if (!iso) return false;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return false;
    const n = new Date();
    return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}

// One entry per designer: how many reports they pushed, their latest push
// and which projects they touched. Newest pusher first.
function designerRollup(reports) {
    const by = {};
    (reports || []).forEach((r) => {
        const name = s(r.designerName || r.reportedByName || r.workstation || 'Unknown').trim();
        if (!by[name]) {
            by[name] = { name: name, email: s(r.designerEmail), reports: 0, lastPush: null, projects: [], pushedToday: false };
        }
        const e = by[name];
        e.reports += 1;
        if (!e.lastPush || (r.createdAt && r.createdAt > e.lastPush)) e.lastPush = r.createdAt || e.lastPush;
        if (isToday(r.createdAt)) e.pushedToday = true;
        const pn = s(r.projectNumber);
        if (pn && e.projects.indexOf(pn) === -1) e.projects.push(pn);
    });
    return Object.keys(by)
        .map((k) => by[k])
        .sort((a, b) => String(b.lastPush || '').localeCompare(String(a.lastPush || '')));
}

function planDocId(projectNumber) {
    return String(projectNumber || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_');
}

// ── Working hours ──────────────────────────────────────────────────────
// Hours come from the EXISTING timesheet system (collection `timesheets`),
// not from the Tekla push — designers already book time there, so this
// reports it against model progress instead of asking them to type it a
// second time (two numbers for the same day would only ever disagree).
//
// The norm below converts tonnage into a budget. 12 h/T is a common
// detailing figure; COO/Director override it per project in the plan.
const DEFAULT_HOURS_PER_TONNE = 12;
const MAX_PROJECT_LOOKUPS = 25;
const MAX_TIMESHEET_ROWS = 5000;

// Tekla writes "P-1529", the portal may hold "P1529" — compare on
// letters and digits only so the two still meet.
function matchKey(v) {
    return String(v == null ? '' : v).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function toIso(v) {
    if (!v) return null;
    if (v.toDate) { try { return v.toDate().toISOString(); } catch (e) { return null; } }
    if (v.seconds !== undefined) return new Date(v.seconds * 1000).toISOString();
    if (v._seconds !== undefined) return new Date(v._seconds * 1000).toISOString();
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d.toISOString();
}

// projectNumber (as Tekla knows it) -> portal project doc.
async function loadProjectIndex() {
    const index = {};
    const snap = await db.collection('projects').limit(1000).get();
    const add = (value, doc, id) => {
        const k = matchKey(value);
        if (!k || index[k]) return;
        index[k] = {
            id: id,
            projectName: s(doc.projectName),
            projectNumber: s(doc.projectNumber || doc.projectCode),
            allocatedHours: num(doc.allocatedHours)
        };
    };
    // Number and code first so an exact identifier always wins over a name.
    snap.docs.forEach((d) => { const p = d.data(); add(p.projectNumber, p, d.id); add(p.projectCode, p, d.id); });
    snap.docs.forEach((d) => { const p = d.data(); add(p.projectName, p, d.id); });
    return index;
}

// Booked hours for one project, with the per-designer split management
// asks for first ("who spent the time?").
async function loggedHoursFor(projectId) {
    const snap = await db.collection('timesheets')
        .where('projectId', '==', projectId)
        .limit(MAX_TIMESHEET_ROWS)
        .get();

    let total = 0;
    let lastEntry = null;
    const by = {};
    snap.docs.forEach((d) => {
        const t = d.data();
        const h = num(t.hours);
        total += h;
        const iso = toIso(t.date);
        if (iso && (!lastEntry || iso > lastEntry)) lastEntry = iso;

        const name = s(t.designerName).trim() || 'Unknown';
        if (!by[name]) by[name] = { name: name, hours: 0, entries: 0, lastEntry: null };
        by[name].hours += h;
        by[name].entries += 1;
        if (iso && (!by[name].lastEntry || iso > by[name].lastEntry)) by[name].lastEntry = iso;
    });

    const designers = Object.keys(by).map((k) => by[k]).sort((a, b) => b.hours - a.hours);
    designers.forEach((d) => { d.hours = Math.round(d.hours * 10) / 10; });

    return {
        loggedHours: Math.round(total * 10) / 10,
        entryCount: snap.size,
        truncated: snap.size >= MAX_TIMESHEET_ROWS,
        lastEntry: lastEntry,
        designers: designers
    };
}

// Earned-value view of the hours. Budget comes from tonnage; earned is
// the share of that budget the reported progress has actually delivered.
// Comparing EARNED against ACTUAL is what makes this honest — comparing
// budget against actual only says how much is left, not whether the team
// is ahead or behind for the work genuinely completed.
function hoursModel(booked, progress, metrics, plan) {
    const p = plan || {};
    const m = metrics || {};
    const pr = progress || {};

    const rate = num(p.hoursPerTonne) > 0 ? num(p.hoursPerTonne) : DEFAULT_HOURS_PER_TONNE;
    const modeledTonnage = num(m.tonnage);
    // Budget on the CONTRACT tonnage when management has set it; fall back
    // to what is modelled so far, which understates the budget early on.
    const basisTonnage = num(p.plannedTonnage) > 0 ? num(p.plannedTonnage) : modeledTonnage;
    const usingPlannedTonnage = num(p.plannedTonnage) > 0;

    const actual = num(booked && booked.loggedHours);
    const budget = basisTonnage > 0 ? basisTonnage * rate : null;
    const pct = (pr.overallPercent === null || pr.overallPercent === undefined) ? null : num(pr.overallPercent);
    const earned = (budget !== null && pct !== null) ? budget * (pct / 100) : null;

    // >100% = more progress delivered than hours spent would suggest.
    const efficiency = (earned !== null && actual > 0) ? (earned / actual) * 100 : null;
    // Hours this project will need in total if it carries on at today's rate.
    const forecast = (pct !== null && pct > 0 && actual > 0) ? (actual / (pct / 100)) : null;

    const r1 = (v) => (v === null || v === undefined ? null : Math.round(v * 10) / 10);
    return {
        hoursPerTonne: rate,
        hoursPerTonneIsDefault: !(num(p.hoursPerTonne) > 0),
        basisTonnage: r1(basisTonnage),
        usingPlannedTonnage: usingPlannedTonnage,
        budgetHours: r1(budget),
        earnedHours: r1(earned),
        actualHours: r1(actual),
        allocatedHours: r1(num(booked && booked.allocatedHours)),
        remainingHours: (budget !== null) ? r1(Math.max(0, budget - actual)) : null,
        // Positive = more hours burnt than the delivered progress earned.
        varianceHours: (earned !== null) ? r1(actual - earned) : null,
        efficiencyPercent: r1(efficiency),
        forecastHours: r1(forecast),
        // What a tonne is actually costing, vs the norm it was budgeted at.
        actualHoursPerTonne: modeledTonnage > 0 ? r1(actual / modeledTonnage) : null,
        entryCount: (booked && booked.entryCount) || 0,
        truncated: !!(booked && booked.truncated),
        lastEntry: (booked && booked.lastEntry) || null,
        designers: (booked && booked.designers) || [],
        matched: !!(booked && booked.matched),
        projectId: (booked && booked.projectId) || null
    };
}

const handler = async (req, res) => {
    try {
        // ── Auth: machine key OR logged-in user ────────────────────────────
        const machineKey = s(req.headers['x-tekla-api-key']);
        const isMachine = !!(machineKey && process.env.TEKLA_API_KEY && machineKey === process.env.TEKLA_API_KEY);

        let user = null;
        if (!isMachine) {
            await util.promisify(verifyToken)(req, res);
            user = req.user;
        }
        const role = user ? String(user.role || '').toLowerCase() : 'machine';

        // ── POST — ingest a report (MACHINE PUSH ONLY) ──────────────────────
        // Reports are accepted exclusively from Tekla workstations holding
        // the TEKLA_API_KEY. No portal/manual writes — designers cannot
        // enter or manipulate figures; everything comes from the model.
        if (req.method === 'POST') {
            if (!isMachine) {
                return res.status(403).json({
                    success: false,
                    error: 'Tekla reports can only be pushed automatically from Tekla workstations (X-Tekla-Api-Key). Manual entry is disabled.'
                });
            }

            const b = req.body || {};
            const modelName = s(b.modelName).trim();
            const projectNumber = s(b.projectNumber).trim();
            if (!modelName && !projectNumber) {
                return res.status(400).json({ success: false, error: 'modelName or projectNumber is required' });
            }

            const reportType = REPORT_TYPES.includes(s(b.reportType)) ? s(b.reportType) : 'model_summary';
            const m = b.metrics || {};

            let rows = Array.isArray(b.rows) ? b.rows.slice(0, MAX_ROWS) : [];
            // Keep rows storable: plain objects of primitives only
            rows = rows.map((r) => {
                const out = {};
                Object.keys(r || {}).slice(0, 20).forEach((k) => {
                    const v = r[k];
                    out[String(k).slice(0, 60)] = (typeof v === 'number') ? v : s(v).slice(0, 300);
                });
                return out;
            });

            // Pending-work items reported by the plugin (e.g. Tekla phases /
            // statuses still open). Strings only, capped.
            const pendingItems = (Array.isArray(b.pendingItems) ? b.pendingItems : [])
                .slice(0, MAX_PENDING_ITEMS)
                .map((p) => s(p).slice(0, 200))
                .filter(Boolean);

            const metrics = {
                tonnage: num(m.tonnage),
                plannedTonnage: num(m.plannedTonnage),
                modelingPercent: num(m.modelingPercent),
                assemblies: int(m.assemblies),
                parts: int(m.parts),
                bolts: int(m.bolts),
                drawingsTotal: int(m.drawingsTotal),
                drawingsIssued: int(m.drawingsIssued)
            };
            const workType = WORK_TYPES.includes(s(b.workType).toLowerCase())
                ? s(b.workType).toLowerCase() : 'steel';
            const activities = normalizeActivities(b.activities);
            const progress = computeProgress(metrics, null, activities);

            const doc = {
                projectNumber: projectNumber,
                projectName: s(b.projectName).trim(),
                modelName: modelName,
                phase: s(b.phase).trim(),
                reportType: reportType,
                workType: workType,
                metrics: metrics,
                activities: activities,
                progress: progress,
                pendingItems: pendingItems,
                rows: rows,
                rowCount: rows.length,
                notes: s(b.notes).slice(0, 2000),
                source: 'tekla-plugin',
                teklaVersion: s(b.teklaVersion),
                // WHO reported. The macro sends the signed-in Windows user so
                // each designer's daily push is attributed to them, not just
                // to a shared workstation name.
                designerName: s(b.designer || b.designerName).trim().slice(0, 120),
                designerEmail: s(b.designerEmail).trim().toLowerCase().slice(0, 160),
                workstation: s(b.workstation).trim().slice(0, 120),
                reportedByUid: 'machine',
                reportedByName: s(b.designer || b.designerName || b.workstation || 'Tekla Workstation'),
                reportedByRole: 'machine',
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            };

            const ref = await db.collection('tekla_reports').add(doc);
            console.log(`[tekla-reports] saved ${ref.id} model="${modelName}" project="${projectNumber}" src=${doc.source}`);

            // Activity trail so it shows in the app feed
            try {
                await db.collection('activities').add({
                    type: 'tekla_report',
                    details: `Tekla report: ${modelName || projectNumber}` +
                        (doc.metrics.tonnage ? ` — ${doc.metrics.tonnage} T` : ''),
                    performedByName: doc.reportedByName,
                    performedByRole: role,
                    performedByUid: doc.reportedByUid,
                    timestamp: admin.firestore.FieldValue.serverTimestamp()
                });
            } catch (e) { console.warn('[tekla-reports] activity log failed:', e.message); }

            // activitiesStored lets the macro confirm on screen that the
            // server actually kept the per-process figures it just sent.
            return res.status(201).json({
                success: true,
                activitiesStored: Object.keys(activities).length,
                capabilities: CAPABILITIES,
                data: { id: ref.id, ...doc, createdAt: new Date().toISOString() }
            });
        }

        // ── PUT — set project plan targets (COO/Director ONLY) ─────────────
        // Management defines the contract targets the actuals are measured
        // against: planned tonnage and target drawing count per project.
        if (req.method === 'PUT') {
            if (isMachine || !['coo', 'director'].includes(role)) {
                return res.status(403).json({ success: false, error: 'Only COO or Director can set project plans' });
            }
            const b = req.body || {};
            const projectNumber = s(b.projectNumber).trim();
            const docId = planDocId(projectNumber);
            if (!docId) return res.status(400).json({ success: false, error: 'projectNumber is required' });

            const plan = {
                projectNumber: projectNumber,
                plannedTonnage: num(b.plannedTonnage),
                targetDrawings: int(b.targetDrawings),
                // Hours the project is budgeted at per tonne of steel. 0 or
                // blank falls back to DEFAULT_HOURS_PER_TONNE on read.
                hoursPerTonne: Math.max(0, num(b.hoursPerTonne)),
                notes: s(b.notes).slice(0, 500),
                updatedBy: s(user.name || user.email),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            };
            await db.collection('tekla_plans').doc(docId).set(plan, { merge: true });
            console.log(`[tekla-reports] plan set for "${projectNumber}" by ${user.email}: ${plan.plannedTonnage} T / ${plan.targetDrawings} dwgs`);
            return res.status(200).json({ success: true, data: plan });
        }

        // ── GET — list + summary (portal only) ──────────────────────────────
        if (req.method === 'GET') {
            if (isMachine) return res.status(403).json({ success: false, error: 'Machine key is write-only' });
            if (!READ_ROLES.includes(role)) {
                return res.status(403).json({ success: false, error: 'Only COO and Director can view Tekla reports' });
            }

            // Management-set plans, keyed by normalized project number
            const plans = {};
            try {
                const planSnap = await db.collection('tekla_plans').limit(500).get();
                planSnap.docs.forEach((d) => { plans[d.id] = d.data(); });
            } catch (e) { console.warn('[tekla-reports] plans read failed:', e.message); }
            const planFor = (projectNumber) => plans[planDocId(projectNumber)] || null;

            // Single report with full detail rows
            if (req.query.id) {
                const doc = await db.collection('tekla_reports').doc(s(req.query.id)).get();
                if (!doc.exists) return res.status(404).json({ success: false, error: 'Report not found' });
                const data = doc.data();
                return res.status(200).json({
                    success: true,
                    data: {
                        id: doc.id,
                        ...data,
                        progress: computeProgress(data.metrics, planFor(data.projectNumber), data.activities),
                        createdAt: data.createdAt && data.createdAt.toDate ? data.createdAt.toDate().toISOString() : null
                    }
                });
            }

            let snap;
            try {
                snap = await db.collection('tekla_reports').orderBy('createdAt', 'desc').limit(500).get();
            } catch (e) {
                console.warn('[tekla-reports] ordered read failed, falling back:', e.message);
                snap = await db.collection('tekla_reports').limit(500).get();
            }
            let reports = snap.docs.map((d) => {
                const data = d.data();
                return {
                    id: d.id,
                    ...data,
                    // Always recompute on read so plan changes apply instantly
                    progress: computeProgress(data.metrics, planFor(data.projectNumber), data.activities),
                    // Trim heavy detail rows out of the list payload
                    rows: undefined,
                    createdAt: data.createdAt && data.createdAt.toDate ? data.createdAt.toDate().toISOString() : null
                };
            });

            const { projectNumber, reportType } = req.query;
            if (projectNumber) reports = reports.filter((r) => s(r.projectNumber).toLowerCase().includes(s(projectNumber).toLowerCase()));
            if (reportType) reports = reports.filter((r) => r.reportType === reportType);

            // Per project+model summary: metrics from the LATEST report of each
            const latestByModel = {};
            reports.forEach((r) => {
                const key = (s(r.projectNumber) + '|' + s(r.modelName)).toLowerCase();
                if (!latestByModel[key]) latestByModel[key] = r; // list is newest-first
            });
            const models = Object.values(latestByModel);

            // Latest report per PROJECT (models are per project+model) — this
            // is what the hours are measured against.
            const latestByProject = {};
            reports.forEach((r) => {
                const pn = s(r.projectNumber).trim();
                if (pn && !latestByProject[pn]) latestByProject[pn] = r;
            });

            // Working hours booked against each project, matched to the
            // portal's own timesheets. Never fatal: a failure here must not
            // take the whole report down with it.
            const hours = {};
            try {
                const wanted = Object.keys(latestByProject);
                if (wanted.length) {
                    const index = await loadProjectIndex();
                    if (wanted.length > MAX_PROJECT_LOOKUPS) {
                        console.warn(`[tekla-reports] hours limited to ${MAX_PROJECT_LOOKUPS} of ${wanted.length} projects`);
                    }
                    await Promise.all(wanted.slice(0, MAX_PROJECT_LOOKUPS).map(async (pn) => {
                        const match = index[matchKey(pn)] || null;
                        let booked = { loggedHours: 0, entryCount: 0, designers: [], matched: false };
                        if (match) {
                            booked = Object.assign({}, await loggedHoursFor(match.id), {
                                matched: true, projectId: match.id, allocatedHours: match.allocatedHours
                            });
                        }
                        const latest = latestByProject[pn];
                        const h = hoursModel(booked, latest.progress, latest.metrics, planFor(pn));
                        h.projectNumber = pn;
                        h.projectName = match ? match.projectName : s(latest.projectName);
                        hours[pn] = h;
                    }));
                }
            } catch (e) { console.warn('[tekla-reports] hours read failed:', e.message); }

            const completions = models
                .map((r) => r.progress && r.progress.overallPercent)
                .filter((v) => v !== null && v !== undefined);
            const pendingModels = models.filter((r) =>
                (r.progress && r.progress.overallPercent !== null && r.progress.overallPercent < 100) ||
                (r.pendingItems && r.pendingItems.length)
            ).length;
            const hoursTotals = (() => {
                const list = Object.keys(hours).map((k) => hours[k]);
                const sum = (f) => list.reduce((t, h) => t + (num(h[f]) || 0), 0);
                const actual = sum('actualHours');
                const earned = sum('earnedHours');
                const r1 = (v) => Math.round(v * 10) / 10;
                return {
                    actual: r1(actual),
                    budget: r1(sum('budgetHours')),
                    earned: r1(earned),
                    efficiency: actual > 0 && earned > 0 ? r1((earned / actual) * 100) : null,
                    unmatched: list.filter((h) => !h.matched).length
                };
            })();

            const summary = {
                modelCount: models.length,
                reportCount: reports.length,
                totalTonnage: models.reduce((t, r) => t + num(r.metrics && r.metrics.tonnage), 0),
                totalAssemblies: models.reduce((t, r) => t + int(r.metrics && r.metrics.assemblies), 0),
                drawingsIssued: models.reduce((t, r) => t + int(r.metrics && r.metrics.drawingsIssued), 0),
                drawingsTotal: models.reduce((t, r) => t + int(r.metrics && r.metrics.drawingsTotal), 0),
                avgCompletion: completions.length
                    ? Math.round((completions.reduce((a, b) => a + b, 0) / completions.length) * 10) / 10
                    : null,
                pendingModels: pendingModels,
                // Who pushed, and when they last did — lets management see at
                // a glance which designers reported today and which are stale.
                designers: designerRollup(reports),
                pushedToday: reports.filter((r) => isToday(r.createdAt)).length,
                // Portfolio hours across every project with Tekla data
                totalLoggedHours: hoursTotals.actual,
                totalBudgetHours: hoursTotals.budget,
                totalEarnedHours: hoursTotals.earned,
                hoursEfficiencyPercent: hoursTotals.efficiency,
                projectsWithoutTimesheetMatch: hoursTotals.unmatched
            };

            return res.status(200).json({ success: true, data: { reports, models, summary, plans, hours, capabilities: CAPABILITIES } });
        }

        // ── GET one report's detail rows via ?id= handled above by list; DELETE ──
        if (req.method === 'DELETE') {
            if (isMachine || !['coo', 'director'].includes(role)) {
                return res.status(403).json({ success: false, error: 'Only COO or Director can delete Tekla reports' });
            }
            const id = s(req.query.id);
            if (!id) return res.status(400).json({ success: false, error: 'id is required' });
            await db.collection('tekla_reports').doc(id).delete();
            console.log(`[tekla-reports] deleted ${id} by ${user.email}`);
            return res.status(200).json({ success: true });
        }

        return res.status(405).json({ success: false, error: 'Method not allowed' });
    } catch (error) {
        console.error('[tekla-reports] error:', error);
        if (!res.headersSent) {
            return res.status(500).json({ success: false, error: error.message });
        }
    }
};

module.exports = allowCors(handler);
