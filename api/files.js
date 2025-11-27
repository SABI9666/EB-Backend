// api/files.js - FIXED: Merged working upload with proper null handling
const admin = require('./_firebase-admin');
const { verifyToken } = require('../middleware/auth');
const util = require('util');
const multer = require('multer');

const db = admin.firestore();
const bucket = admin.storage().bucket();

// Configure multer for memory storage (for PDF uploads through backend)
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { 
        fileSize: 3 * 1024 * 1024 * 1024 // 3GB limit
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

// --- HELPER FUNCTIONS ---

async function canAccessFile(file, userRole, userUid, proposalId = null) {
    // Management & Estimators see everything
    if (['coo', 'director', 'estimator'].includes(userRole)) return true;

    let proposal = null;
    const pId = file.proposalId || proposalId;

    if (pId) {
        const proposalDoc = await db.collection('proposals').doc(pId).get();
        if (proposalDoc.exists) proposal = proposalDoc.data();
    }
    
    // BDM Access: Can only see their own proposals
    if (userRole === 'bdm') {
        if (proposal) return proposal.createdByUid === userUid;
        return file.uploadedByUid === userUid;
    }

    // Designer/Lead Access
    if (['design_lead', 'designer'].includes(userRole)) {
        if (!file.fileType || ['project', 'drawing', 'specification', 'link'].includes(file.fileType)) {
            return true; 
        }
        return false;
    }

    return false;
}

async function filterFilesForUser(files, userRole, userUid) {
    const filteredFiles = [];
    for (const file of files) {
        if (await canAccessFile(file, userRole, userUid)) {
            filteredFiles.push({
                ...file,
                canView: true,
                canDownload: true,
                canDelete: file.uploadedByUid === userUid || userRole === 'director'
            });
        }
    }
    return filteredFiles;
}

async function checkUploadPermissions(user, proposalId, fileType) {
    if (user.role === 'bdm' && proposalId) {
        const proposalDoc = await db.collection('proposals').doc(proposalId).get();
        if (!proposalDoc.exists || proposalDoc.data().createdByUid !== user.uid) {
            throw new Error('Access denied: You can only add files to your own proposals.');
        }
    }
    if (fileType === 'estimation' && user.role !== 'estimator') {
        throw new Error('Access denied: Only estimators can upload estimation files.');
    }
    return true;
}

// --- MAIN HANDLER ---

const handler = async (req, res) => {
    try {
        // ============================================
        // POST - PDF/FILE UPLOAD THROUGH BACKEND
        // ============================================
        if (req.method === 'POST' && req.url && req.url.includes('upload-file')) {
            return upload.single('file')(req, res, async (err) => {
                if (err) {
                    console.error('❌ Multer error:', err);
                    return res.status(400).json({ 
                        success: false, 
                        error: err.message 
                    });
                }
                
                // Verify authentication after multer processes the file
                try {
                    await util.promisify(verifyToken)(req, res);
                } catch (authError) {
                    console.error('❌ Auth error:', authError);
                    return res.status(401).json({ 
                        success: false, 
                        error: 'Authentication failed' 
                    });
                }
                
                const file = req.file;
                if (!file) {
                    return res.status(400).json({ 
                        success: false, 
                        error: 'No file uploaded' 
                    });
                }
                
                try {
                    // CRITICAL: Use null instead of undefined for Firestore
                    const proposalId = req.body.proposalId && req.body.proposalId !== 'null' && req.body.proposalId !== '' 
                        ? req.body.proposalId 
                        : null;
                    const fileType = req.body.fileType || 'project';
                    
                    console.log(`📤 Backend upload: ${file.originalname} (${(file.size / 1024 / 1024).toFixed(2)} MB)`);
                    console.log(`   ProposalId: ${proposalId}, FileType: ${fileType}`);
                    
                    // Check permissions
                    await checkUploadPermissions(req.user, proposalId, fileType);
                    
                    // Upload to Firebase Storage
                    const folder = proposalId || 'general';
                    const storagePath = `${folder}/${Date.now()}-${file.originalname}`;
                    const fileRef = bucket.file(storagePath);
                    
                    await fileRef.save(file.buffer, {
                        contentType: file.mimetype,
                        metadata: {
                            contentType: file.mimetype
                        }
                    });
                    
                    // Make public
                    await fileRef.makePublic().catch(e => console.log('Note: Could not make public:', e.message));
                    const publicUrl = `https://storage.googleapis.com/${bucket.name}/${storagePath}`;
                    
                    console.log(`✅ Uploaded to storage: ${storagePath}`);
                    
                    // Save to Firestore - NO undefined values!
                    const fileData = {
                        fileName: storagePath,
                        originalName: file.originalname,
                        url: publicUrl,
                        fileUrl: publicUrl,
                        mimeType: file.mimetype,
                        fileSize: file.size,
                        proposalId: proposalId,  // null is OK, undefined is NOT
                        fileType: fileType,
                        uploadedAt: admin.firestore.FieldValue.serverTimestamp(),
                        uploadedByUid: req.user.uid,
                        uploadedByName: req.user.name,
                        uploadedByRole: req.user.role
                    };
                    
                    const docRef = await db.collection('files').add(fileData);
                    
                    // Log activity
                    await db.collection('activities').add({
                        type: 'file_uploaded',
                        details: `File uploaded: ${file.originalname}`,
                        performedByName: req.user.name,
                        performedByRole: req.user.role,
                        performedByUid: req.user.uid,
                        timestamp: admin.firestore.FieldValue.serverTimestamp(),
                        proposalId: proposalId,
                        fileId: docRef.id
                    });
                    
                    console.log(`✅ File record saved: ${docRef.id}`);
                    
                    return res.status(201).json({ 
                        success: true, 
                        data: { 
                            id: docRef.id, 
                            ...fileData 
                        } 
                    });
                    
                } catch (error) {
                    console.error('❌ Upload error:', error);
                    return res.status(500).json({ 
                        success: false, 
                        error: error.message 
                    });
                }
            });
        }
        
        // ============================================
        // AUTHENTICATE FOR ALL OTHER ENDPOINTS
        // ============================================
        await util.promisify(verifyToken)(req, res);

        // ============================================
        // GET - RETRIEVE FILES
        // ============================================
        if (req.method === 'GET') {
            const { proposalId, projectId, fileId, id } = req.query;
            
            // Single file by ID
            if (fileId || id) {
                const docId = fileId || id;
                const fileDoc = await db.collection('files').doc(docId).get();
                if (!fileDoc.exists) return res.status(404).json({ success: false, error: 'File not found' });
                
                const fileData = fileDoc.data();
                if (!await canAccessFile(fileData, req.user.role, req.user.uid)) {
                    return res.status(403).json({ success: false, error: 'Access denied.' });
                }
                return res.status(200).json({ 
                    success: true, 
                    data: { 
                        ...fileData, 
                        id: fileDoc.id, 
                        canView: true, 
                        canDownload: true, 
                        canDelete: fileData.uploadedByUid === req.user.uid || req.user.role === 'director' 
                    } 
                });
            }
            
            // List files
            let query = db.collection('files').orderBy('uploadedAt', 'desc');
            
            if (proposalId) {
                if (req.user.role === 'bdm') {
                    const proposalDoc = await db.collection('proposals').doc(proposalId).get();
                    if (!proposalDoc.exists || proposalDoc.data().createdByUid !== req.user.uid) {
                        return res.status(403).json({ success: false, error: 'Access denied to this proposal.' });
                    }
                }
                query = query.where('proposalId', '==', proposalId);
            } else if (projectId) {
                query = query.where('projectId', '==', projectId);
            } else if (req.user.role === 'bdm') {
                // BDM can only see files from their own proposals
                const proposalsSnapshot = await db.collection('proposals').where('createdByUid', '==', req.user.uid).get();
                const proposalIds = proposalsSnapshot.docs.map(doc => doc.id);
                if (proposalIds.length === 0) return res.status(200).json({ success: true, data: [] });
                // Firestore 'in' query limit is 10, so we may need to batch
                if (proposalIds.length <= 10) {
                    query = query.where('proposalId', 'in', proposalIds);
                }
            }
            
            const snapshot = await query.get();
            const allFiles = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            const filteredFiles = await filterFilesForUser(allFiles, req.user.role, req.user.uid);
            return res.status(200).json({ success: true, data: filteredFiles });
        }

        // ============================================
        // POST - UPLOAD LINKS (URLs)
        // ============================================
        if (req.method === 'POST') {
            // Parse body if needed
            if (typeof req.body !== 'object' || Object.keys(req.body).length === 0) { 
                try {
                    const chunks = [];
                    await new Promise((resolve) => {
                        req.on('data', (chunk) => chunks.push(chunk));
                        req.on('end', () => {
                            try {
                                req.body = JSON.parse(Buffer.concat(chunks).toString());
                            } catch (e) {
                                req.body = {};
                            }
                            resolve();
                        });
                    });
                } catch (e) {
                    console.error('Failed to parse body:', e);
                }
            }

            const { links, proposalId, projectId, fileType = 'project' } = req.body;

            // Upload Links
            if (links && Array.isArray(links)) {
                try {
                    await checkUploadPermissions(req.user, proposalId, 'link');
                    const uploadedLinks = [];
                    
                    console.log(`📎 Uploading ${links.length} link(s)`);
                    
                    for (const link of links) {
                        const linkData = {
                            originalName: link.title || link.url,
                            fileName: link.title || link.url,
                            url: link.url,
                            fileUrl: link.url,
                            mimeType: 'text/url',
                            fileSize: 0,
                            proposalId: proposalId || null,
                            projectId: projectId || null,
                            fileType: 'link',
                            linkDescription: link.description || '',
                            uploadedAt: admin.firestore.FieldValue.serverTimestamp(),
                            uploadedByUid: req.user.uid,
                            uploadedByName: req.user.name,
                            uploadedByRole: req.user.role
                        };
                        const docRef = await db.collection('files').add(linkData);
                        uploadedLinks.push({ id: docRef.id, ...linkData });
                        
                        console.log(`✅ Link saved: ${link.title || link.url}`);
                    }
                    
                    // Log activity
                    await db.collection('activities').add({
                        type: 'links_added',
                        details: `Added ${links.length} link(s)`,
                        performedByName: req.user.name,
                        performedByRole: req.user.role,
                        performedByUid: req.user.uid,
                        timestamp: admin.firestore.FieldValue.serverTimestamp(),
                        proposalId: proposalId || null
                    });
                    
                    return res.status(201).json({ success: true, data: uploadedLinks });
                } catch (error) {
                    console.error('❌ Link upload error:', error);
                    return res.status(403).json({ success: false, error: error.message });
                }
            }
            
            return res.status(400).json({ 
                success: false, 
                error: 'Invalid request. Use /upload-file for PDFs or provide links array for URLs.' 
            });
        }

        // ============================================
        // DELETE - REMOVE FILE
        // ============================================
        if (req.method === 'DELETE') {
            const { id } = req.query;
            if (!id) return res.status(400).json({ success: false, error: 'File ID required' });

            const fileDoc = await db.collection('files').doc(id).get();
            if (!fileDoc.exists) return res.status(404).json({ success: false, error: 'File not found' });

            const fileData = fileDoc.data();
            if (fileData.uploadedByUid !== req.user.uid && req.user.role !== 'director') {
                return res.status(403).json({ success: false, error: 'Permission denied' });
            }

            // Delete from storage (if it's a file, not a link)
            if (fileData.fileType !== 'link' && fileData.fileName) {
                try { 
                    await bucket.file(fileData.fileName).delete(); 
                    console.log('✅ Deleted from storage:', fileData.fileName);
                } 
                catch (e) { 
                    console.warn('⚠️ Storage delete failed:', e.message); 
                }
            }

            // Delete from Firestore
            await fileDoc.ref.delete();
            console.log('✅ Deleted from Firestore:', id);
            
            // Log activity
            await db.collection('activities').add({
                type: 'file_deleted',
                details: `File deleted: ${fileData.originalName}`,
                performedByName: req.user.name,
                performedByRole: req.user.role,
                performedByUid: req.user.uid,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                proposalId: fileData.proposalId || null
            });
            
            return res.status(200).json({ success: true, message: 'Deleted successfully' });
        }

        return res.status(405).json({ success: false, error: 'Method not allowed' });
        
    } catch (error) {
        console.error('❌ Files API error:', error);
        return res.status(500).json({ 
            success: false, 
            error: 'Internal Server Error', 
            message: error.message 
        });
    }
};

module.exports = allowCors(handler);
