// api/sample-projects.js
// Sample project showcase pages, uploaded by BDM as HTML files.
//
// A BDM uploads a self-contained .html page (a sample project / portfolio
// piece to show prospects). Everyone in BDM + COO/Director sees the shared
// gallery; COO/Director view any sample rendered full-page from their
// portal. Files live in Firebase Storage under sample-projects/<uid>/ and
// are served from storage.googleapis.com — a different origin from the
// portal, so an uploaded page can never reach portal cookies or tokens,
// and the portal additionally renders it inside a sandboxed iframe.
//
// Access:
//   - BDM: upload; delete their OWN samples.
//   - COO/Director: view all; delete any.
// Persists to Firestore collection `sample_projects`.

const admin = require('./_firebase-admin');
const { verifyToken } = require('../middleware/auth');
const util = require('util');
const multer = require('multer');

const db = admin.firestore();
const bucket = admin.storage().bucket();

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const okType = ['text/html', 'application/xhtml+xml'].includes(file.mimetype);
        const okExt = /\.html?$/i.test(file.originalname || '');
        if (okType || okExt) cb(null, true);
        else cb(new Error('Only HTML files (.html / .htm) are allowed'));
    }
});

function s(v) { return (v == null) ? '' : String(v); }
function int(v) { const n = parseInt(v, 10); return isNaN(n) ? 0 : n; }

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

const WORK_PROFILES = [
    'Structural Steel Detailing', 'Rebar Detailing', 'Connection Design',
    'PEMB', 'Miscellaneous Steel', 'Precast', 'BIM Coordination',
    'Estimation Only', 'EPCM / Full Service', 'Other'
];

function toIso(v) {
    if (!v) return null;
    if (v.toDate) { try { return v.toDate().toISOString(); } catch (e) { return null; } }
    if (v._seconds !== undefined) return new Date(v._seconds * 1000).toISOString();
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d.toISOString();
}

function shape(id, data) {
    return {
        id: id,
        title: s(data.title),
        description: s(data.description),
        workProfile: s(data.workProfile),
        fileUrl: s(data.fileUrl),
        fileName: s(data.fileName),
        fileSize: int(data.fileSize),
        createdByUid: s(data.createdByUid),
        createdByName: s(data.createdByName),
        createdAt: toIso(data.createdAt)
    };
}

const inner = async (req, res) => {
    try {
        await util.promisify(verifyToken)(req, res);
        const role = String(req.user.role || '').toLowerCase();
        const uid = s(req.user.uid);
        const name = s(req.user.name || req.user.email);
        const isMgmt = ['coo', 'director'].includes(role);
        const isBdm = role === 'bdm';

        if (!isBdm && !isMgmt) {
            return res.status(403).json({ success: false, error: 'Sample Projects are visible to BDM, COO and Director only' });
        }

        // ── GET — shared gallery, newest first ──────────────────────────
        if (req.method === 'GET') {
            let snap;
            try {
                snap = await db.collection('sample_projects').limit(500).get();
            } catch (e) {
                console.warn('[sample-projects] read failed:', e.message);
                snap = { docs: [] };
            }
            const samples = snap.docs
                .map((d) => shape(d.id, d.data()))
                .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
            return res.status(200).json({
                success: true,
                data: { samples: samples, workProfiles: WORK_PROFILES }
            });
        }

        // ── POST — upload (BDM only) ────────────────────────────────────
        if (req.method === 'POST') {
            if (!isBdm) {
                return res.status(403).json({ success: false, error: 'Only BDM can upload sample projects' });
            }
            const b = req.body || {};
            const title = s(b.title).trim().slice(0, 160);
            if (!title) return res.status(400).json({ success: false, error: 'Title is required' });
            if (!req.file) return res.status(400).json({ success: false, error: 'An HTML file is required' });

            const safe = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
            const path = `sample-projects/${uid}/${Date.now()}-${safe}`;
            const fileRef = bucket.file(path);
            // Force text/html so the stored page renders in the browser
            // instead of downloading.
            await fileRef.save(req.file.buffer, { contentType: 'text/html', metadata: { contentType: 'text/html' } });
            await fileRef.makePublic().catch((e) => console.log('[sample-projects] file not public:', e.message));

            const doc = {
                title: title,
                description: s(b.description).trim().slice(0, 500),
                workProfile: WORK_PROFILES.includes(s(b.workProfile)) ? s(b.workProfile) : s(b.workProfile).trim().slice(0, 80),
                fileUrl: `https://storage.googleapis.com/${bucket.name}/${path}`,
                fileName: req.file.originalname.slice(0, 200),
                fileStoragePath: path,
                fileSize: req.file.size,
                createdByUid: uid,
                createdByName: name,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            };
            const ref = await db.collection('sample_projects').add(doc);
            console.log(`[sample-projects] uploaded ${ref.id} "${title}" by ${name} (${req.file.size} bytes)`);
            return res.status(201).json({ success: true, data: shape(ref.id, { ...doc, createdAt: new Date() }) });
        }

        // ── DELETE — owner or management ────────────────────────────────
        if (req.method === 'DELETE') {
            const id = s(req.query.id);
            if (!id) return res.status(400).json({ success: false, error: 'id is required' });
            const ref = db.collection('sample_projects').doc(id);
            const snap = await ref.get();
            if (!snap.exists) return res.status(404).json({ success: false, error: 'Sample not found' });
            if (!isMgmt && snap.data().createdByUid !== uid) {
                return res.status(403).json({ success: false, error: 'You can only delete your own samples' });
            }
            const path = s(snap.data().fileStoragePath);
            if (path) { try { await bucket.file(path).delete(); } catch (e) { /* already gone */ } }
            await ref.delete();
            console.log(`[sample-projects] deleted ${id} by ${name}`);
            return res.status(200).json({ success: true });
        }

        return res.status(405).json({ success: false, error: 'Method not allowed' });
    } catch (error) {
        console.error('[sample-projects] error:', error);
        if (!res.headersSent) {
            return res.status(500).json({ success: false, error: error.message });
        }
    }
};

const handler = (req, res) => {
    const ct = s(req.headers['content-type']);
    if (req.method === 'POST' && ct.indexOf('multipart/form-data') !== -1) {
        return upload.single('htmlFile')(req, res, (err) => {
            if (err) return res.status(400).json({ success: false, error: err.message });
            return inner(req, res);
        });
    }
    return inner(req, res);
};

module.exports = allowCors(handler);
