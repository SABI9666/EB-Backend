// api/variations.js - Handles creation, fetching, and approval of variations (with file upload support)
const admin = require('./_firebase-admin');
const { verifyToken } = require('../middleware/auth');
const util = require('util');
const multer = require('multer');

const db = admin.firestore();
const bucket = admin.storage().bucket();

// Multer: memory storage for variation document uploads (PDF/Word)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB limit for variation docs
    fileFilter: (req, file, cb) => {
        const allowed = [
            'application/pdf',
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        ];
        if (allowed.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Only PDF and Word documents (.pdf, .doc, .docx) are allowed.'));
        }
    }
});

const allowCors = fn => async (req, res) => {
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST,PUT,DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }
    return await fn(req, res);
};

// Helper function to remove undefined values from objects before Firestore
function sanitizeForFirestore(obj) {
    const sanitized = {};
    for (const [key, value] of Object.entries(obj)) {
        if (value !== undefined) {
            sanitized[key] = value;
        }
    }
    return sanitized;
}

const handler = async (req, res) => {
    try {

        // ============================================
        // POST - Create a new variation (multipart/form-data with optional file)
        // ============================================
        if (req.method === 'POST') {
            return upload.single('variationDocument')(req, res, async (multerErr) => {
                if (multerErr) {
                    return res.status(400).json({ success: false, error: multerErr.message });
                }

                // Authenticate after multer processes the request
                try {
                    await util.promisify(verifyToken)(req, res);
                } catch (authErr) {
                    return res.status(401).json({ success: false, error: 'Authentication failed.' });
                }

                // Only Design Leads can create variations
                if (req.user.role !== 'design_lead') {
                    return res.status(403).json({ success: false, error: 'Only Design Leads can submit variations.' });
                }

                const {
                    parentProjectId,
                    variationCode,
                    estimatedHours,
                    scopeDescription,
                    // New fields
                    clientName,
                    clientEmail,
                    amount,
                    currency,
                    accountsDetails
                } = req.body;

                // --- Validation ---
                if (!parentProjectId || !variationCode || !estimatedHours || !scopeDescription) {
                    return res.status(400).json({ success: false, error: 'Missing required fields: parentProjectId, variationCode, estimatedHours, scopeDescription.' });
                }

                // Get parent project for context
                const projectDoc = await db.collection('projects').doc(parentProjectId).get();
                if (!projectDoc.exists) {
                    return res.status(404).json({ success: false, error: 'Parent project not found.' });
                }
                const project = projectDoc.data();

                // Check for duplicate variation code
                const existingVariation = await db.collection('variations')
                    .where('parentProjectId', '==', parentProjectId)
                    .where('variationCode', '==', variationCode)
                    .get();

                if (!existingVariation.empty) {
                    return res.status(400).json({ success: false, error: 'This Variation Code already exists for this project.' });
                }

                // --- Upload variation document to Firebase Storage (if provided) ---
                let documentUrl = null;
                let documentOriginalName = null;
                let documentStoragePath = null;

                if (req.file) {
                    const file = req.file;
                    const storagePath = `variations/${parentProjectId}/${Date.now()}-${file.originalname}`;
                    const fileRef = bucket.file(storagePath);

                    await fileRef.save(file.buffer, {
                        contentType: file.mimetype,
                        metadata: { contentType: file.mimetype }
                    });

                    await fileRef.makePublic().catch(e =>
                        console.log('Note: Could not make variation doc public:', e.message)
                    );

                    documentUrl = `https://storage.googleapis.com/${bucket.name}/${storagePath}`;
                    documentOriginalName = file.originalname;
                    documentStoragePath = storagePath;

                    console.log(`✅ Variation document uploaded: ${storagePath}`);
                }

                // --- Create Variation Document ---
                const variationData = {
                    parentProjectId: parentProjectId,
                    parentProjectName: project.projectName,
                    parentProjectCode: project.projectCode,
                    clientCompany: project.clientCompany,

                    variationCode: variationCode,
                    estimatedHours: parseFloat(estimatedHours),
                    scopeDescription: scopeDescription,

                    // Client details
                    clientName: clientName || null,
                    clientEmail: clientEmail || null,

                    // Financial details
                    amount: amount ? parseFloat(amount) : null,
                    currency: currency || null,

                    // Accounts details
                    accountsDetails: accountsDetails || null,

                    // Variation document
                    documentUrl: documentUrl,
                    documentOriginalName: documentOriginalName,
                    documentStoragePath: documentStoragePath,

                    status: 'pending_coo_approval',

                    createdByUid: req.user.uid,
                    createdByName: req.user.name,
                    createdByRole: req.user.role,
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                };

                const variationRef = await db.collection('variations').add(sanitizeForFirestore(variationData));

                // --- Log Activity ---
                await db.collection('activities').add({
                    type: 'variation_created',
                    details: `Variation "${variationCode}" (${estimatedHours}h${amount ? `, ${currency || ''} ${amount}` : ''}) submitted for approval by ${req.user.name}`,
                    performedByName: req.user.name,
                    performedByRole: req.user.role,
                    performedByUid: req.user.uid,
                    timestamp: admin.firestore.FieldValue.serverTimestamp(),
                    projectId: parentProjectId,
                    variationId: variationRef.id
                });

                // --- Notify all COOs ---
                const cooSnapshot = await db.collection('users').where('role', '==', 'coo').get();
                const notifications = [];

                cooSnapshot.forEach(doc => {
                    notifications.push(db.collection('notifications').add({
                        type: 'variation_pending_approval',
                        recipientUid: doc.id,
                        recipientRole: 'coo',
                        message: `New variation "${variationCode}" for ${project.projectName} requires approval.${amount ? ` Amount: ${currency || ''} ${amount}` : ''}`,
                        projectId: parentProjectId,
                        variationId: variationRef.id,
                        estimatedHours: parseFloat(estimatedHours),
                        submittedBy: req.user.name,
                        priority: 'high',
                        createdAt: admin.firestore.FieldValue.serverTimestamp(),
                        isRead: false
                    }));
                });

                await Promise.all(notifications);

                return res.status(200).json({
                    success: true,
                    message: 'Variation submitted for approval.',
                    variationId: variationRef.id
                });
            });
        }

        // For all other methods, parse auth first
        await util.promisify(verifyToken)(req, res);

        // Parse JSON body for PUT
        if (req.method === 'PUT' && req.headers['content-type'] === 'application/json') {
            if (!req.body || Object.keys(req.body).length === 0) {
                await new Promise((resolve) => {
                    const chunks = [];
                    req.on('data', (chunk) => chunks.push(chunk));
                    req.on('end', () => {
                        try {
                            const bodyBuffer = Buffer.concat(chunks);
                            req.body = bodyBuffer.length > 0 ? JSON.parse(bodyBuffer.toString()) : {};
                        } catch (e) {
                            console.error("Error parsing JSON body:", e);
                            req.body = {};
                        }
                        resolve();
                    });
                });
            }
        }

        // ============================================
        // GET - Fetch variations
        // ============================================
        if (req.method === 'GET') {
            const { id, status, parentProjectId } = req.query;

            // --- Get a single variation by ID ---
            if (id) {
                if (!['coo', 'director', 'accounts', 'design_lead'].includes(req.user.role)) {
                    return res.status(403).json({ success: false, error: 'Permission denied.' });
                }
                const doc = await db.collection('variations').doc(id).get();
                if (!doc.exists) {
                    return res.status(404).json({ success: false, error: 'Variation not found.' });
                }
                // Design leads can only see their own
                const data = doc.data();
                if (req.user.role === 'design_lead' && data.createdByUid !== req.user.uid) {
                    return res.status(403).json({ success: false, error: 'Permission denied.' });
                }
                return res.status(200).json({ success: true, data: { id: doc.id, ...data } });
            }

            // --- Get variations based on filters ---
            let query = db.collection('variations');

            if (req.user.role === 'coo' || req.user.role === 'director' || req.user.role === 'accounts') {
                if (status) {
                    query = query.where('status', '==', status);
                }
            } else if (req.user.role === 'design_lead') {
                query = query.where('createdByUid', '==', req.user.uid);
            } else {
                return res.status(403).json({ success: false, error: 'You do not have permission to view variations.' });
            }

            if (parentProjectId) {
                query = query.where('parentProjectId', '==', parentProjectId);
            }

            const snapshot = await query.orderBy('createdAt', 'desc').get();
            const variations = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

            return res.status(200).json({ success: true, data: variations });
        }

        // ============================================
        // PUT - Approve or Reject a variation
        // ============================================
        if (req.method === 'PUT') {
            const { id } = req.query;
            const { action, data } = req.body;

            if (!id) {
                return res.status(400).json({ success: false, error: 'Variation ID is required.' });
            }

            if (req.user.role !== 'coo' && req.user.role !== 'director') {
                return res.status(403).json({ success: false, error: 'Only COO or Director can approve variations.' });
            }

            if (action === 'review_variation') {
                const { status, notes, parentProjectId, approvedHours } = data;

                if (!status || (status !== 'approved' && status !== 'rejected')) {
                    return res.status(400).json({ success: false, error: 'Invalid status. Must be "approved" or "rejected".' });
                }

                if (status === 'rejected' && !notes) {
                    return res.status(400).json({ success: false, error: 'Rejection notes are required.' });
                }

                const variationRef = db.collection('variations').doc(id);
                const variationDoc = await variationRef.get();
                if (!variationDoc.exists) {
                    return res.status(404).json({ success: false, error: 'Variation not found.' });
                }
                const variation = variationDoc.data();

                // --- Start a transaction ---
                await db.runTransaction(async (transaction) => {
                    const variationUpdates = {
                        status: status,
                        approvalNotes: notes || '',
                        approvedByUid: req.user.uid,
                        approvedByName: req.user.name,
                        approvedAt: admin.firestore.FieldValue.serverTimestamp(),
                        updatedAt: admin.firestore.FieldValue.serverTimestamp()
                    };
                    transaction.update(variationRef, variationUpdates);

                    if (status === 'approved') {
                        if (!parentProjectId || !approvedHours) {
                            throw new Error('Parent Project ID and Approved Hours are required for approval.');
                        }
                        const projectRef = db.collection('projects').doc(parentProjectId);
                        transaction.update(projectRef, {
                            additionalHours: admin.firestore.FieldValue.increment(parseFloat(approvedHours)),
                            updatedAt: admin.firestore.FieldValue.serverTimestamp()
                        });
                    }
                });

                // --- Log Activity ---
                await db.collection('activities').add({
                    type: `variation_${status}`,
                    details: `Variation "${variation.variationCode}" was ${status} by ${req.user.name}.`,
                    performedByName: req.user.name,
                    performedByRole: req.user.role,
                    performedByUid: req.user.uid,
                    timestamp: admin.firestore.FieldValue.serverTimestamp(),
                    projectId: variation.parentProjectId,
                    variationId: id
                });

                // --- Notify Design Manager ---
                await db.collection('notifications').add({
                    type: `variation_${status}`,
                    recipientUid: variation.createdByUid,
                    recipientRole: 'design_lead',
                    message: `Your variation "${variation.variationCode}" for ${variation.parentProjectName} was ${status}.`,
                    notes: notes || 'No notes provided.',
                    projectId: variation.parentProjectId,
                    variationId: id,
                    priority: 'normal',
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    isRead: false
                });

                return res.status(200).json({ success: true, message: `Variation ${status} successfully.` });
            }

            return res.status(400).json({ success: false, error: 'Invalid PUT action.' });
        }

        return res.status(405).json({ success: false, error: 'Method not allowed' });

    } catch (error) {
        console.error('Variations API error:', error);
        return res.status(500).json({
            success: false,
            error: 'Internal Server Error',
            message: error.message
        });
    }
};

module.exports = allowCors(handler);
