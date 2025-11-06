// api/deliverables.js - Designer file uploads with version notes
const admin = require('./_firebase-admin');
const { verifyToken } = require('../middleware/auth');
const util = require('util');
const multer = require('multer');

const db = admin.firestore();
const bucket = admin.storage().bucket();

// Configure multer for file uploads
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 100 * 1024 * 1024, // 100MB limit for design files
    },
    fileFilter: (req, file, cb) => {
        // Allow PDFs, images, DWG, and common design file formats
        const allowedTypes = [
            'application/pdf',
            'image/jpeg',
            'image/png',
            'image/jpg',
            'image/tiff',
            'application/dwg',
            'application/dxf',
            'application/zip'
        ];
        
        if (allowedTypes.includes(file.mimetype) || 
            file.originalname.match(/\.(pdf|jpg|jpeg|png|tiff|dwg|dxf|zip)$/i)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Allowed: PDF, JPG, PNG, TIFF, DWG, DXF, ZIP'));
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

const handler = async (req, res) => {
    try {
        await util.promisify(verifyToken)(req, res);

        // ============================================
        // GET - Retrieve deliverables
        // ============================================
        if (req.method === 'GET') {
            const { projectId, taskId, designerUid } = req.query;
            
            let query = db.collection('deliverables').orderBy('uploadedAt', 'desc');
            
            // Filter by project
            if (projectId) {
                query = query.where('projectId', '==', projectId);
            }
            
            // Filter by task
            if (taskId) {
                query = query.where('taskId', '==', taskId);
            }
            
            // Filter by designer
            if (designerUid) {
                query = query.where('designerUid', '==', designerUid);
            }
            
            // Designers only see their own deliverables
            if (req.user.role === 'designer' && !designerUid) {
                query = query.where('designerUid', '==', req.user.uid);
            }
            
            const snapshot = await query.get();
            const deliverables = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            
            return res.status(200).json({ success: true, data: deliverables });
        }

        // ============================================
        // POST - Upload deliverables
        // ============================================
        if (req.method === 'POST') {
            // Check if this is a link upload or file upload
            const contentType = req.headers['content-type'];
            
            // Handle link uploads
            if (contentType && contentType.includes('application/json')) {
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
                
                const { projectId, taskId, links, uploadNotes, versionNumber } = req.body;
                
                // Verify user is assigned to this project
                const projectDoc = await db.collection('projects').doc(projectId).get();
                if (!projectDoc.exists) {
                    return res.status(404).json({ success: false, error: 'Project not found' });
                }
                
                const project = projectDoc.data();
                
                // Check if user is assigned (for designers) or has access (for design leads)
                if (req.user.role === 'designer') {
                    if (!project.assignedDesigners || !project.assignedDesigners.includes(req.user.uid)) {
                        return res.status(403).json({ 
                            success: false, 
                            error: 'You are not assigned to this project' 
                        });
                    }
                }
                
                if (!links || !Array.isArray(links) || links.length === 0) {
                    return res.status(400).json({ success: false, error: 'No links provided' });
                }
                
                const uploadedLinks = [];
                
                for (const link of links) {
                    const deliverableData = {
                        projectId,
                        projectCode: project.projectCode,
                        projectName: project.projectName,
                        taskId: taskId || null,
                        
                        // File info
                        deliverableType: 'link',
                        url: link.url,
                        fileName: null,
                        originalName: link.title || link.url,
                        mimeType: 'text/url',
                        fileSize: 0,
                        
                        // Version and notes
                        versionNumber: versionNumber || '1.0',
                        uploadNotes: uploadNotes || '',
                        linkDescription: link.description || '',
                        
                        // Designer info
                        designerUid: req.user.uid,
                        designerName: req.user.name,
                        
                        // Status
                        reviewStatus: 'pending', // pending, approved, revision_required
                        reviewedBy: null,
                        reviewedAt: null,
                        reviewComments: '',
                        
                        // Timestamps
                        uploadedAt: admin.firestore.FieldValue.serverTimestamp(),
                        updatedAt: admin.firestore.FieldValue.serverTimestamp()
                    };
                    
                    const docRef = await db.collection('deliverables').add(deliverableData);
                    uploadedLinks.push({ id: docRef.id, ...deliverableData });
                    
                    // Log activity
                    await db.collection('activities').add({
                        type: 'deliverable_uploaded',
                        details: `Designer uploaded link: ${link.title || link.url}`,
                        performedByName: req.user.name,
                        performedByRole: req.user.role,
                        performedByUid: req.user.uid,
                        timestamp: admin.firestore.FieldValue.serverTimestamp(),
                        projectId: projectId,
                        deliverableId: docRef.id
                    });
                }
                
                // Notify Design Lead and COO about upload
                await db.collection('notifications').add({
                    type: 'deliverable_uploaded',
                    recipientUid: project.designLeadUid,
                    recipientRole: 'design_lead',
                    message: `${req.user.name} uploaded ${uploadedLinks.length} link(s) for ${project.projectName}`,
                    projectId: projectId,
                    priority: 'normal',
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    isRead: false
                });
                
                return res.status(201).json({ 
                    success: true, 
                    data: uploadedLinks,
                    message: `${uploadedLinks.length} link(s) uploaded successfully` 
                });
                
            } else {
                // Handle file upload with multer
                return new Promise((resolve, reject) => {
                    upload.array('files', 20)(req, res, async (err) => {
                        if (err) {
                            console.error('Multer error:', err);
                            return res.status(400).json({ 
                                success: false, 
                                error: 'File upload error: ' + err.message 
                            });
                        }

                        try {
                            if (!req.files || req.files.length === 0) {
                                return res.status(400).json({ 
                                    success: false, 
                                    error: 'No files provided' 
                                });
                            }

                            const { projectId, taskId, uploadNotes, versionNumber } = req.body;
                            
                            // Verify project exists and user has access
                            const projectDoc = await db.collection('projects').doc(projectId).get();
                            if (!projectDoc.exists) {
                                return res.status(404).json({ 
                                    success: false, 
                                    error: 'Project not found' 
                                });
                            }
                            
                            const project = projectDoc.data();
                            
                            // Check if designer is assigned to project
                            if (req.user.role === 'designer') {
                                if (!project.assignedDesigners || !project.assignedDesigners.includes(req.user.uid)) {
                                    return res.status(403).json({ 
                                        success: false, 
                                        error: 'You are not assigned to this project' 
                                    });
                                }
                            }

                            const uploadedFiles = [];

                            for (const file of req.files) {
                                // Create unique filename
                                const fileName = `deliverables/${projectId}/${Date.now()}-${file.originalname}`;
                                const fileRef = bucket.file(fileName);
                                
                                // Upload to Firebase Storage
                                await fileRef.save(file.buffer, {
                                    metadata: {
                                        contentType: file.mimetype,
                                        metadata: {
                                            uploadedBy: req.user.name,
                                            projectId: projectId,
                                            versionNumber: versionNumber || '1.0'
                                        }
                                    },
                                });

                                // Make file publicly accessible
                                await fileRef.makePublic();
                                
                                const publicUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`;

                                // Save deliverable metadata to Firestore
                                const deliverableData = {
                                    projectId,
                                    projectCode: project.projectCode,
                                    projectName: project.projectName,
                                    taskId: taskId || null,
                                    
                                    // File info
                                    deliverableType: 'file',
                                    fileName,
                                    originalName: file.originalname,
                                    url: publicUrl,
                                    mimeType: file.mimetype,
                                    fileSize: file.size,
                                    
                                    // Version and notes
                                    versionNumber: versionNumber || '1.0',
                                    uploadNotes: uploadNotes || '',
                                    
                                    // Designer info
                                    designerUid: req.user.uid,
                                    designerName: req.user.name,
                                    
                                    // Status
                                    reviewStatus: 'pending', // pending, approved, revision_required
                                    reviewedBy: null,
                                    reviewedAt: null,
                                    reviewComments: '',
                                    
                                    // Timestamps
                                    uploadedAt: admin.firestore.FieldValue.serverTimestamp(),
                                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                                };

                                const docRef = await db.collection('deliverables').add(deliverableData);
                                uploadedFiles.push({ id: docRef.id, ...deliverableData });

                                // Log activity
                                await db.collection('activities').add({
                                    type: 'deliverable_uploaded',
                                    details: `Designer uploaded file: ${file.originalname}`,
                                    performedByName: req.user.name,
                                    performedByRole: req.user.role,
                                    performedByUid: req.user.uid,
                                    timestamp: admin.firestore.FieldValue.serverTimestamp(),
                                    projectId: projectId,
                                    deliverableId: docRef.id
                                });
                            }
                            
                            // Update project design status if needed
                            if (project.designStatus === 'not_started') {
                                await db.collection('projects').doc(projectId).update({
                                    designStatus: 'in_progress',
                                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                                });
                            }

                            // Notify Design Lead about upload
                            await db.collection('notifications').add({
                                type: 'deliverable_uploaded',
                                recipientUid: project.designLeadUid,
                                recipientRole: 'design_lead',
                                message: `${req.user.name} uploaded ${uploadedFiles.length} file(s) for ${project.projectName}${uploadNotes ? ` - ${uploadNotes}` : ''}`,
                                projectId: projectId,
                                priority: 'normal',
                                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                                isRead: false
                            });
                            
                            // Also notify COO
                            await db.collection('notifications').add({
                                type: 'deliverable_uploaded',
                                recipientRole: 'coo',
                                message: `New deliverables uploaded for ${project.projectName} by ${req.user.name}`,
                                projectId: projectId,
                                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                                isRead: false
                            });

                            return res.status(201).json({ 
                                success: true, 
                                data: uploadedFiles,
                                message: `${uploadedFiles.length} file(s) uploaded successfully` 
                            });

                        } catch (error) {
                            console.error('File upload error:', error);
                            return res.status(500).json({ 
                                success: false, 
                                error: 'Internal Server Error', 
                                message: error.message 
                            });
                        }
                    });
                });
            }
        }

        // ============================================
        // PUT - Update deliverable (review status)
        // ============================================
        if (req.method === 'PUT') {
            const { id } = req.query;
            const { action, data } = req.body;
            
            if (!id) {
                return res.status(400).json({ 
                    success: false, 
                    error: 'Deliverable ID required' 
                });
            }
            
            const deliverableRef = db.collection('deliverables').doc(id);
            const deliverableDoc = await deliverableRef.get();
            
            if (!deliverableDoc.exists) {
                return res.status(404).json({ 
                    success: false, 
                    error: 'Deliverable not found' 
                });
            }
            
            const deliverable = deliverableDoc.data();
            let updates = {};
            let activityDetail = '';
            
            if (action === 'review') {
                // Only Design Lead, COO, or Director can review
                if (!['design_lead', 'coo', 'director'].includes(req.user.role)) {
                    return res.status(403).json({ 
                        success: false, 
                        error: 'Insufficient permissions to review deliverables' 
                    });
                }
                
                updates = {
                    reviewStatus: data.reviewStatus, // approved or revision_required
                    reviewedBy: req.user.name,
                    reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
                    reviewComments: data.reviewComments || ''
                };
                
                activityDetail = `Deliverable ${data.reviewStatus}: ${deliverable.originalName}`;
                
                // Notify designer about review
                await db.collection('notifications').add({
                    type: 'deliverable_reviewed',
                    recipientUid: deliverable.designerUid,
                    recipientRole: 'designer',
                    message: `Your deliverable "${deliverable.originalName}" has been ${data.reviewStatus}${data.reviewComments ? ': ' + data.reviewComments : ''}`,
                    projectId: deliverable.projectId,
                    deliverableId: id,
                    priority: data.reviewStatus === 'revision_required' ? 'high' : 'normal',
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    isRead: false
                });
            }
            
            updates.updatedAt = admin.firestore.FieldValue.serverTimestamp();
            await deliverableRef.update(updates);
            
            // Log activity
            await db.collection('activities').add({
                type: 'deliverable_reviewed',
                details: activityDetail,
                performedByName: req.user.name,
                performedByRole: req.user.role,
                performedByUid: req.user.uid,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                projectId: deliverable.projectId,
                deliverableId: id
            });
            
            return res.status(200).json({ 
                success: true, 
                message: 'Deliverable updated successfully' 
            });
        }

        // ============================================
        // DELETE - Delete deliverable
        // ============================================
        if (req.method === 'DELETE') {
            const { id } = req.query;
            
            if (!id) {
                return res.status(400).json({ 
                    success: false, 
                    error: 'Deliverable ID required' 
                });
            }

            const deliverableDoc = await db.collection('deliverables').doc(id).get();
            
            if (!deliverableDoc.exists) {
                return res.status(404).json({ 
                    success: false, 
                    error: 'Deliverable not found' 
                });
            }

            const deliverable = deliverableDoc.data();

            // Only the uploader or Design Lead/COO/Director can delete
            if (deliverable.designerUid !== req.user.uid && 
                !['design_lead', 'coo', 'director'].includes(req.user.role)) {
                return res.status(403).json({ 
                    success: false, 
                    error: 'You can only delete your own deliverables' 
                });
            }

            // Delete from storage if it's a file
            if (deliverable.deliverableType === 'file' && deliverable.fileName) {
                try {
                    await bucket.file(deliverable.fileName).delete();
                } catch (storageError) {
                    console.warn('File not found in storage, continuing with database deletion');
                }
            }

            // Delete from Firestore
            await deliverableDoc.ref.delete();

            // Log activity
            await db.collection('activities').add({
                type: 'deliverable_deleted',
                details: `Deliverable deleted: ${deliverable.originalName}`,
                performedByName: req.user.name,
                performedByRole: req.user.role,
                performedByUid: req.user.uid,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                projectId: deliverable.projectId
            });

            return res.status(200).json({ 
                success: true, 
                message: 'Deliverable deleted successfully' 
            });
        }

        return res.status(405).json({ success: false, error: 'Method not allowed' });
        
    } catch (error) {
        console.error('Deliverables API error:', error);
        return res.status(500).json({ 
            success: false, 
            error: 'Internal Server Error', 
            message: error.message 
        });
    }
};

module.exports = allowCors(handler);
