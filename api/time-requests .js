// api/time-requests.js - Additional time request management
const admin = require('./_firebase-admin');
const { verifyToken } = require('../middleware/auth');
const util = require('util');

const db = admin.firestore();

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

        // Parse JSON body for POST/PUT
        if ((req.method === 'POST' || req.method === 'PUT') && req.headers['content-type'] === 'application/json') {
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
        // GET - Retrieve time requests
        // ============================================
        if (req.method === 'GET') {
            const { id, status, projectId } = req.query;
            
            // Get single time request
            if (id) {
                const doc = await db.collection('timeRequests').doc(id).get();
                if (!doc.exists) {
                    return res.status(404).json({ success: false, error: 'Time request not found' });
                }
                // --- FIX: Add project details to single request ---
                const requestData = doc.data();
                const projectDoc = await db.collection('projects').doc(requestData.projectId).get();
                const projectData = projectDoc.exists ? projectDoc.data() : {};

                return res.status(200).json({ 
                    success: true, 
                    data: { 
                        id: doc.id, 
                        ...requestData,
                        projectName: projectData.projectName || requestData.projectName,
                        projectCode: projectData.projectCode || requestData.projectCode,
                        clientCompany: projectData.clientCompany || requestData.clientCompany,
                        designLeadName: projectData.designLeadName || requestData.designLeadName,
                        currentAllocatedHours: projectData.allocatedHours || requestData.currentAllocatedHours || 0,
                        currentHoursLogged: projectData.hoursLogged || requestData.currentHoursLogged || 0,
                        additionalHours: projectData.additionalHours || 0 // <-- ADD THIS
                    } 
                });
            }
            
            // Build query based on role
            let query = db.collection('timeRequests').orderBy('createdAt', 'desc');
            
            // COO/Director sees all pending requests
            if (['coo', 'director'].includes(req.user.role)) {
                if (status) {
                    query = query.where('status', '==', status);
                } else {
                    query = query.where('status', '==', 'pending');
                }
            } 
            // Designers see only their own requests
            else if (req.user.role === 'designer') {
                query = query.where('designerUid', '==', req.user.uid);
            }
            // Design Leads see requests for their projects
            else if (req.user.role === 'design_lead') {
                query = query.where('designLeadUid', '==', req.user.uid);
            }
            
            if (projectId) {
                query = query.where('projectId', '==', projectId);
            }
            
            const snapshot = await query.limit(50).get();
            const requests = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            
            // --- NEW: Enhance with project data ---
            const populatedRequests = await Promise.all(requests.map(async (request) => {
                const projectDoc = await db.collection('projects').doc(request.projectId).get();
                const project = projectDoc.exists ? projectDoc.data() : {};

                return {
                    ...request,
                    projectName: project.projectName || request.projectName,
                    projectCode: project.projectCode || request.projectCode,
                    clientCompany: project.clientCompany || request.clientCompany,
                    designLeadName: project.designLeadName || request.designLeadName,
                    currentAllocatedHours: project.allocatedHours || request.currentAllocatedHours || 0,
                    currentHoursLogged: project.hoursLogged || request.currentHoursLogged || 0,
                    additionalHours: project.additionalHours || 0 // <-- ADD THIS
                };
            }));
            
            return res.status(200).json({ 
                success: true, 
                data: populatedRequests, // <-- USE POPULATED
                count: populatedRequests.length // <-- USE POPULATED
            });
        }

        // ============================================
        // POST - Create time request
        // ============================================
        if (req.method === 'POST') {
            const { 
                projectId, 
                // timesheetId, // Old
                requestedHours, 
                reason, 
                attachmentUrl,
                pendingTimesheetData // <-- ADD THIS
            } = req.body;
            
            // Validation
            if (!projectId) {
                return res.status(400).json({ success: false, error: 'Project ID is required' });
            }
            
            if (!requestedHours || requestedHours <= 0) {
                return res.status(400).json({ success: false, error: 'Requested hours must be greater than 0' });
            }
            
            if (!reason || reason.trim().length === 0) {
                return res.status(400).json({ success: false, error: 'Reason is required' });
            }
            
            // Get project details
            const projectDoc = await db.collection('projects').doc(projectId).get();
            if (!projectDoc.exists) {
                return res.status(404).json({ success: false, error: 'Project not found' });
            }
            
            const project = projectDoc.data();
            
            // Check if user is assigned to project
            if (req.user.role === 'designer') {
                if (!project.assignedDesigners || !project.assignedDesigners.includes(req.user.uid)) {
                    return res.status(403).json({ 
                        success: false, 
                        error: 'You are not assigned to this project' 
                    });
                }
            }
            
            // --- FIX: Get current hours from project doc ---
            const currentHoursLogged = project.hoursLogged || 0;
            const currentAllocatedHours = project.allocatedHours || 0;
            const currentAdditionalHours = project.additionalHours || 0; // <-- ADD THIS
            
            // Create time request
            const requestData = {
                projectId,
                projectName: project.projectName,
                projectCode: project.projectCode,
                clientCompany: project.clientCompany,
                designerUid: req.user.uid,
                designerName: req.user.name,
                designerEmail: req.user.email,
                designLeadUid: project.designLeadUid,
                designLeadName: project.designLeadName,
                timesheetId: pendingTimesheetData ? 'pending' : null, // <-- USE THIS
                pendingTimesheetData: pendingTimesheetData || null, // <-- ADD THIS
                requestedHours: parseFloat(requestedHours),
                reason: reason.trim(),
                attachmentUrl: attachmentUrl || null,
                currentAllocatedHours: currentAllocatedHours, // <-- USE VARIABLE
                currentAdditionalHours: currentAdditionalHours, // <-- ADD THIS
                currentHoursLogged: currentHoursLogged,
                status: 'pending',
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            };
            
            const requestRef = await db.collection('timeRequests').add(requestData);
            
            // Log activity
            await db.collection('activities').add({
                type: 'time_request_created',
                details: `${req.user.name} requested ${requestedHours} additional hours for ${project.projectName}`,
                performedByName: req.user.name,
                performedByRole: req.user.role,
                performedByUid: req.user.uid,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                projectId: projectId,
                requestId: requestRef.id
            });
            
            // Notify COO and Design Lead
            const notifications = [
                {
                    type: 'time_request_pending',
                    recipientRole: 'coo',
                    message: `${req.user.name} requested ${requestedHours}h additional time for "${project.projectName}"`,
                    projectId: projectId,
                    projectName: project.projectName,
                    requestId: requestRef.id,
                    requestedHours: requestedHours,
                    priority: 'high'
                }
            ];
            
            if (project.designLeadUid) {
                notifications.push({
                    type: 'time_request_pending',
                    recipientUid: project.designLeadUid,
                    recipientRole: 'design_lead',
                    message: `${req.user.name} requested ${requestedHours}h additional time for "${project.projectName}"`,
                    projectId: projectId,
                    projectName: project.projectName,
                    requestId: requestRef.id,
                    requestedHours: requestedHours,
                    priority: 'normal'
                });
            }
            
            for (const notification of notifications) {
                await db.collection('notifications').add({
                    ...notification,
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    isRead: false
                });
            }
            
            return res.status(201).json({ 
                success: true, 
                message: 'Time request submitted successfully',
                requestId: requestRef.id
            });
        }

        // ============================================
        // PUT - Review/Update time request
        // ============================================
        if (req.method === 'PUT') {
            const { id } = req.query;
            const { action, approvedHours, comment, applyToTimesheet } = req.body;
            
            if (!id) {
                return res.status(400).json({ success: false, error: 'Request ID is required' });
            }
            
            // Only COO/Director can approve/reject
            if (!['coo', 'director'].includes(req.user.role)) {
                return res.status(403).json({ 
                    success: false, 
                    error: 'Only COO/Director can review time requests' 
                });
            }
            
            if (!action || !['approve', 'reject', 'request_info'].includes(action)) {
                return res.status(400).json({ 
                    success: false, 
                    error: 'Valid action is required (approve, reject, request_info)' 
                });
            }
            
            const requestRef = db.collection('timeRequests').doc(id);
            const requestDoc = await requestRef.get();
            
            if (!requestDoc.exists) {
                return res.status(404).json({ success: false, error: 'Request not found' });
            }
            
            const request = requestDoc.data();
            
            if (request.status !== 'pending' && request.status !== 'info_requested') {
                return res.status(400).json({ 
                    success: false, 
                    error: 'This request has already been processed' 
                });
            }
            
            const updates = {
                reviewedBy: req.user.name,
                reviewedByUid: req.user.uid,
                reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
                reviewComment: comment || null,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            };
            
            let activityDetails = '';
            let notificationMessage = '';
            
            // Handle different actions
            if (action === 'approve') {
                const hoursToApprove = parseFloat(approvedHours);
                if (!hoursToApprove || hoursToApprove <= 0) {
                    return res.status(400).json({ 
                        success: false, 
                        error: 'Approved hours is required for approval' 
                    });
                }
                
                updates.status = 'approved';
                updates.approvedHours = hoursToApprove;
                
                // Update project allocation
                await db.collection('projects').doc(request.projectId).update({
                    // --- FIX: Use additionalHours field ---
                    additionalHours: admin.firestore.FieldValue.increment(hoursToApprove),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
                
                // If applying to specific timesheet, update it
                // --- FIX: Check for pending timesheet data ---
                if (applyToTimesheet && request.timesheetId === 'pending' && request.pendingTimesheetData) {
                    // Create the new timesheet entry
                    const timesheetData = {
                        ...request.pendingTimesheetData,
                        projectId: request.projectId,
                        projectName: request.projectName,
                        designerUid: request.designerUid,
                        designerName: request.designerName,
                        designerEmail: request.designerEmail,
                        date: admin.firestore.Timestamp.fromDate(new Date(request.pendingTimesheetData.date)),
                        hours: parseFloat(request.pendingTimesheetData.hours),
                        status: 'approved', // Auto-approve
                        additionalTimeApproved: true,
                        additionalTimeRequestId: id,
                        createdAt: admin.firestore.FieldValue.serverTimestamp(),
                        updatedAt: admin.firestore.FieldValue.serverTimestamp()
                    };
                    
                    const timesheetRef = await db.collection('timesheets').add(timesheetData);
                    
                    // Update the project's hoursLogged
                    await db.collection('projects').doc(request.projectId).update({
                        hoursLogged: admin.firestore.FieldValue.increment(timesheetData.hours)
                    });
                    
                    // Link the timesheet to the request
                    updates.timesheetId = timesheetRef.id;
                }
                
                activityDetails = `Approved ${hoursToApprove}h additional time for ${request.projectName}`;
                notificationMessage = `Your request for ${request.requestedHours}h has been approved (${hoursToApprove}h granted)`;
                
            } else if (action === 'reject') {
                if (!comment) {
                    return res.status(400).json({ 
                        success: false, 
                        error: 'Comment is required for rejection' 
                    });
                }
                
                updates.status = 'rejected';
                activityDetails = `Rejected time request for ${request.projectName}`;
                notificationMessage = `Your request for ${request.requestedHours}h has been rejected. Reason: ${comment}`;
                
            } else if (action === 'request_info') {
                updates.status = 'info_requested';
                activityDetails = `Requested more information for time request on ${request.projectName}`;
                notificationMessage = `More information needed for your ${request.requestedHours}h request: ${comment}`;
            }
            
            await requestRef.update(updates);
            
            // Log activity
            await db.collection('activities').add({
                type: `time_request_${action}`,
                details: activityDetails,
                performedByName: req.user.name,
                performedByRole: req.user.role,
                performedByUid: req.user.uid,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                projectId: request.projectId,
                requestId: id
            });
            
            // Notify designer
            await db.collection('notifications').add({
                type: `time_request_${action}`,
                recipientUid: request.designerUid,
                recipientRole: 'designer',
                message: notificationMessage,
                projectId: request.projectId,
                projectName: request.projectName,
                requestId: id,
                priority: action === 'approve' ? 'high' : 'normal',
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                isRead: false
            });
            
            // Notify design lead if exists
            if (request.designLeadUid) {
                await db.collection('notifications').add({
                    type: `time_request_${action}`,
                    recipientUid: request.designLeadUid,
                    recipientRole: 'design_lead',
                    message: `Time request for "${request.projectName}" has been ${action}ed by ${req.user.name}`,
                    projectId: request.projectId,
                    projectName: request.projectName,
                    requestId: id,
                    priority: 'normal',
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    isRead: false
                });
            }
            
            return res.status(200).json({ 
                success: true, 
                message: `Time request ${action}ed successfully` 
            });
        }

        // ============================================
        // DELETE - Delete time request
        // ============================================
        if (req.method === 'DELETE') {
            const { id } = req.query;
            
            if (!id) {
                return res.status(400).json({ success: false, error: 'Request ID is required' });
            }
            
            const requestRef = db.collection('timeRequests').doc(id);
            const requestDoc = await requestRef.get();
            
            if (!requestDoc.exists) {
                return res.status(404).json({ success: false, error: 'Request not found' });
            }
            
            const request = requestDoc.data();
            
            // Only creator or COO/Director can delete
            if (req.user.role === 'designer' && request.designerUid !== req.user.uid) {
                return res.status(403).json({ 
                    success: false, 
                    error: 'You can only delete your own requests' 
                });
            }
            
            if (!['designer', 'coo', 'director'].includes(req.user.role)) {
                return res.status(403).json({ 
                    success: false, 
                    error: 'Permission denied' 
                });
            }
            
            // Can only delete pending or rejected requests
            if (!['pending', 'rejected', 'info_requested'].includes(request.status)) { // <-- ADD 'info_requested'
                return res.status(400).json({ 
                    success: false, 
                    error: 'Cannot delete approved or processed requests' 
                });
            }
            
            await requestRef.delete();
            
            return res.status(200).json({ 
                success: true, 
                message: 'Time request deleted successfully' 
            });
        }

        return res.status(405).json({ success: false, error: 'Method not allowed' });
        
    } catch (error) {
        console.error('Time Requests API error:', error);
        return res.status(500).json({ 
            success: false, 
            error: 'Internal Server Error', 
            message: error.message 
        });
    }
};

module.exports = allowCors(handler);

