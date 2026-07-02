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
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
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
// client math. Modeling % prefers an explicit value from the Tekla plugin,
// falling back to modeled vs planned tonnage. Drawing % = issued / total.
function computeProgress(metrics) {
    const m = metrics || {};
    let modelingPercent = null;
    if (m.modelingPercent > 0) modelingPercent = Math.min(100, num(m.modelingPercent));
    else if (num(m.plannedTonnage) > 0) modelingPercent = Math.min(100, (num(m.tonnage) / num(m.plannedTonnage)) * 100);

    let drawingPercent = null;
    if (int(m.drawingsTotal) > 0) drawingPercent = Math.min(100, (int(m.drawingsIssued) / int(m.drawingsTotal)) * 100);

    const parts = [modelingPercent, drawingPercent].filter((v) => v !== null);
    const overallPercent = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : null;

    const pending = [];
    if (num(m.plannedTonnage) > num(m.tonnage)) {
        pending.push((num(m.plannedTonnage) - num(m.tonnage)).toFixed(1) + ' T modeling remaining');
    }
    if (int(m.drawingsTotal) > int(m.drawingsIssued)) {
        pending.push((int(m.drawingsTotal) - int(m.drawingsIssued)) + ' drawings pending');
    }

    const round1 = (v) => (v === null ? null : Math.round(v * 10) / 10);
    return {
        modelingPercent: round1(modelingPercent),
        drawingPercent: round1(drawingPercent),
        overallPercent: round1(overallPercent),
        derivedPending: pending
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
            const progress = computeProgress(metrics);

            const doc = {
                projectNumber: projectNumber,
                projectName: s(b.projectName).trim(),
                modelName: modelName,
                phase: s(b.phase).trim(),
                reportType: reportType,
                metrics: metrics,
                progress: progress,
                pendingItems: pendingItems,
                rows: rows,
                rowCount: rows.length,
                notes: s(b.notes).slice(0, 2000),
                source: 'tekla-plugin',
                teklaVersion: s(b.teklaVersion),
                reportedByUid: 'machine',
                reportedByName: s(b.workstation || 'Tekla Workstation'),
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

            return res.status(201).json({ success: true, data: { id: ref.id, ...doc, createdAt: new Date().toISOString() } });
        }

        // ── GET — list + summary (portal only) ──────────────────────────────
        if (req.method === 'GET') {
            if (isMachine) return res.status(403).json({ success: false, error: 'Machine key is write-only' });
            if (!READ_ROLES.includes(role)) {
                return res.status(403).json({ success: false, error: 'Only COO and Director can view Tekla reports' });
            }

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
                        progress: data.progress || computeProgress(data.metrics),
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
                    // Recompute progress on read so legacy docs get it too
                    progress: data.progress || computeProgress(data.metrics),
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
            const completions = models
                .map((r) => r.progress && r.progress.overallPercent)
                .filter((v) => v !== null && v !== undefined);
            const pendingModels = models.filter((r) =>
                (r.progress && r.progress.overallPercent !== null && r.progress.overallPercent < 100) ||
                (r.pendingItems && r.pendingItems.length)
            ).length;
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
                pendingModels: pendingModels
            };

            return res.status(200).json({ success: true, data: { reports, models, summary } });
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
