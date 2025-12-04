// api/allocation-requests.js - NEW FILE for COO → Director Allocation Change Approval
const admin = require('./_firebase-admin');
const { verifyToken } = require('../middleware/auth');
const util = require('util');
const { sendEmailNotification } = require('./email');

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
        // GET - Retrieve allocation change requests
        // ============================================
        if (req.method === 'GET') {
            const { id, status, projectId } = req.query;

            // Get single request by ID
            if (id) {
                const requestDoc = await db.collection('allocation-change-requests').doc(id).get();
                if (!requestDoc.exists) {
                    return res.status(404).json({ success: false, error: 'Request not found' });
                }
                return res.status(200).json({ 
                    success: true, 
                    data: { id: requestDoc.id, ...requestDoc.data() }
                });
            }

            // Director: Get pending requests for approval
            if (req.user.role === 'director') {
                let query = db.collection('allocation-change-requests');
                
                if (status) {
                    query = query.where('status', '==', status);
                }
                
                query = query.orderBy('createdAt', 'desc');
                const snapshot = await query.get();
                const requests = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
                
                return res.status(200).json({ success: true, data: requests });
            }

            // COO: Get their own requests
            if (req.user.role === 'coo') {
                let query = db.collection('allocation-change-requests')
                    .where('requestedByUid', '==', req.user.uid);
                
                if (status) {
                    query = query.where('status', '==', status);
                }
                
                query = query.orderBy('createdAt', 'desc');
                const snapshot = await query.get();
                const requests = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
                
                return res.status(200).json({ success: true, data: requests });
            }

            // Get requests for a specific project
            if (projectId) {
                const snapshot = await db.collection('allocation-change-requests')
                    .where('projectId', '==', projectId)
                    .orderBy('createdAt', 'desc')
                    .get();
                const requests = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
                return res.status(200).json({ success: true, data: requests });
            }

            return res.status(403).json({ success: false, error: 'Access denied' });
        }

        // ============================================
        // POST - COO creates allocation/budget change request
        // ============================================
        if (req.method === 'POST') {
            // Only COO can create allocation change requests
            if (req.user.role !== 'coo') {
                return res.status(403).json({ 
                    success: false, 
                    error: 'Only COO can create allocation change requests' 
                });
            }

            const { 
                projectId, 
                requestType,  // 'designer_hours' or 'budget_change'
                // For designer hours change:
                designerUid,
                designerName,
                designerEmail,
                currentAllocatedHours, 
                requestedNewHours, 
                // For budget change:
                currentBudget,
                requestedBudget,
                // Common:
                reason,
                projectName: providedProjectName,
                projectCode: providedProjectCode,
                clientCompany: providedClientCompany
            } = req.body;

            // Validation
            if (!projectId) {
                return res.status(400).json({ success: false, error: 'Project ID is required' });
            }
            if (!reason || reason.trim() === '') {
                return res.status(400).json({ success: false, error: 'Reason for change is mandatory' });
            }

            // Get project info
            const projectDoc = await db.collection('projects').doc(projectId).get();
            if (!projectDoc.exists) {
                return res.status(404).json({ success: false, error: 'Project not found' });
            }
            const project = projectDoc.data();

            let requestData;
            let notificationMessage;
            let activityDetails;

            // ============================================
            // BUDGET CHANGE REQUEST
            // ============================================
            if (requestType === 'budget_change') {
                if (requestedBudget === undefined || requestedBudget === null) {
                    return res.status(400).json({ success: false, error: 'Requested budget is required' });
                }

                const currentBudgetValue = parseFloat(currentBudget) || parseFloat(project.maxAllocatedHours) || 0;
                const requestedBudgetValue = parseFloat(requestedBudget);

                requestData = {
                    projectId,
                    projectName: providedProjectName || project.projectName || 'Unknown Project',
                    projectCode: providedProjectCode || project.projectCode || project.projectNumber || '',
                    clientCompany: providedClientCompany || project.clientCompany || '',
                    
                    requestType: 'budget_change',
                    
                    currentBudget: currentBudgetValue,
                    requestedBudget: requestedBudgetValue,
                    budgetDifference: requestedBudgetValue - currentBudgetValue,
                    
                    reason: reason.trim(),
                    
                    status: 'pending',
                    
                    requestedByUid: req.user.uid,
                    requestedByName: req.user.name,
                    requestedByEmail: req.user.email,
                    
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                };

                notificationMessage = `COO ${req.user.name} requests budget change for project "${requestData.projectName}" from ${currentBudgetValue}h to ${requestedBudgetValue}h. Reason: ${reason.trim().substring(0, 100)}...`;
                activityDetails = `COO ${req.user.name} requested budget change: ${currentBudgetValue}h → ${requestedBudgetValue}h`;
            }
            // ============================================
            // DESIGNER HOURS CHANGE REQUEST
            // ============================================
            else {
                if (!designerUid) {
                    return res.status(400).json({ success: false, error: 'Designer UID is required' });
                }
                if (requestedNewHours === undefined || requestedNewHours === null) {
                    return res.status(400).json({ success: false, error: 'Requested new hours is required' });
                }

                requestData = {
                    projectId,
                    projectName: project.projectName || 'Unknown Project',
                    projectCode: project.projectCode || '',
                    clientCompany: project.clientCompany || '',
                    
                    requestType: 'designer_hours',
                    
                    designerUid,
                    designerName: designerName || 'Unknown Designer',
                    designerEmail: designerEmail || '',
                    
                    currentAllocatedHours: parseFloat(currentAllocatedHours) || 0,
                    requestedNewHours: parseFloat(requestedNewHours),
                    hoursDifference: parseFloat(requestedNewHours) - (parseFloat(currentAllocatedHours) || 0),
                    
                    reason: reason.trim(),
                    
                    status: 'pending',
                    
                    requestedByUid: req.user.uid,
                    requestedByName: req.user.name,
                    requestedByEmail: req.user.email,
                    
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                };

                notificationMessage = `COO ${req.user.name} requests to change allocation for "${designerName}" on project "${project.projectName}" from ${currentAllocatedHours}h to ${requestedNewHours}h`;
                activityDetails = `COO ${req.user.name} requested allocation change for ${designerName}: ${currentAllocatedHours}h → ${requestedNewHours}h`;
            }

            const requestRef = await db.collection('allocation-change-requests').add(requestData);

            // Notify Director
            await db.collection('notifications').add({
                type: 'allocation_change_request',
                recipientRole: 'director',
                message: notificationMessage,
                requestId: requestRef.id,
                projectId,
                projectName: project.projectName,
                requestType: requestData.requestType,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                isRead: false,
                priority: 'high'
            });

            // Send email to Director
            try {
                const directorSnapshot = await db.collection('users').where('role', '==', 'director').limit(1).get();
                if (!directorSnapshot.empty) {
                    const directorEmail = directorSnapshot.docs[0].data().email;
                    await sendEmailNotification('allocation.change_request', {
                        projectName: project.projectName,
                        requestType: requestData.requestType,
                        designerName: designerName || 'N/A',
                        currentHours: currentAllocatedHours || currentBudget,
                        requestedHours: requestedNewHours || requestedBudget,
                        reason: reason,
                        requestedBy: req.user.name,
                        directorEmail: directorEmail
                    });
                }
            } catch (emailErr) {
                console.error('Email notification failed:', emailErr);
            }

            // Log activity
            await db.collection('activities').add({
                type: 'allocation_change_requested',
                details: activityDetails,
                performedByName: req.user.name,
                performedByRole: req.user.role,
                performedByUid: req.user.uid,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                projectId,
                projectName: project.projectName,
                requestId: requestRef.id
            });

            return res.status(201).json({ 
                success: true, 
                message: requestData.requestType === 'budget_change' 
                    ? 'Budget change request submitted for Director approval'
                    : 'Allocation change request submitted for Director approval',
                requestId: requestRef.id
            });
        }

        // ============================================
        // PUT - Director approves/rejects request
        // ============================================
        if (req.method === 'PUT') {
            const { id } = req.query;
            const { action, finalApprovedHours, comment } = req.body;

            if (!id) {
                return res.status(400).json({ success: false, error: 'Request ID is required' });
            }

            // Only Director can approve/reject
            if (req.user.role !== 'director') {
                return res.status(403).json({ 
                    success: false, 
                    error: 'Only Director can approve or reject allocation change requests' 
                });
            }

            const requestRef = db.collection('allocation-change-requests').doc(id);
            const requestDoc = await requestRef.get();

            if (!requestDoc.exists) {
                return res.status(404).json({ success: false, error: 'Request not found' });
            }

            const request = requestDoc.data();

            if (request.status !== 'pending') {
                return res.status(400).json({ 
                    success: false, 
                    error: `This request has already been ${request.status}` 
                });
            }

            let updateData = {
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                reviewedByUid: req.user.uid,
                reviewedByName: req.user.name,
                reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
                directorComment: comment || ''
            };

            // ============================================
            // APPROVE - Update project based on request type
            // ============================================
            if (action === 'approve') {
                updateData.status = 'approved';
                
                const projectRef = db.collection('projects').doc(request.projectId);
                const projectDoc = await projectRef.get();
                
                if (!projectDoc.exists) {
                    return res.status(404).json({ success: false, error: 'Project not found' });
                }
                
                const project = projectDoc.data();

                // ============================================
                // BUDGET CHANGE APPROVAL
                // ============================================
                if (request.requestType === 'budget_change') {
                    const approvedBudget = parseFloat(finalApprovedHours) || request.requestedBudget;
                    updateData.finalApprovedBudget = approvedBudget;

                    // Update the project's max allocated hours
                    await projectRef.update({
                        maxAllocatedHours: approvedBudget,
                        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                        lastBudgetChange: {
                            previousBudget: request.currentBudget,
                            newBudget: approvedBudget,
                            approvedBy: req.user.name,
                            approvedByUid: req.user.uid,
                            reason: request.reason,
                            approvedAt: new Date().toISOString()
                        }
                    });

                    // Notify COO
                    await db.collection('notifications').add({
                        type: 'budget_change_approved',
                        recipientUid: request.requestedByUid,
                        recipientRole: 'coo',
                        message: `Director ${req.user.name} approved your budget change request for "${request.projectName}". Budget updated from ${request.currentBudget}h to ${approvedBudget}h`,
                        requestId: id,
                        projectId: request.projectId,
                        projectName: request.projectName,
                        createdAt: admin.firestore.FieldValue.serverTimestamp(),
                        isRead: false,
                        priority: 'high'
                    });

                    // Log activity
                    await db.collection('activities').add({
                        type: 'budget_change_approved',
                        details: `Director ${req.user.name} approved budget change for "${request.projectName}": ${request.currentBudget}h → ${approvedBudget}h`,
                        performedByName: req.user.name,
                        performedByRole: req.user.role,
                        performedByUid: req.user.uid,
                        timestamp: admin.firestore.FieldValue.serverTimestamp(),
                        projectId: request.projectId,
                        projectName: request.projectName,
                        requestId: id
                    });

                    // Send email to COO
                    try {
                        await sendEmailNotification('budget.change_approved', {
                            projectName: request.projectName,
                            oldBudget: request.currentBudget,
                            newBudget: approvedBudget,
                            approvedBy: req.user.name,
                            cooEmail: request.requestedByEmail
                        });
                    } catch (emailErr) {
                        console.error('Email notification failed:', emailErr);
                    }
                }
                // ============================================
                // DESIGNER HOURS CHANGE APPROVAL
                // ============================================
                else {
                    const approvedHours = parseFloat(finalApprovedHours) || request.requestedNewHours;
                    updateData.finalApprovedHours = approvedHours;

                    let designerHours = project.designerHours || {};
                    const oldHours = designerHours[request.designerUid] || 0;
                    
                    // Calculate the difference for total allocation update
                    const hoursDiff = approvedHours - oldHours;
                    
                    // Update designer's hours
                    designerHours[request.designerUid] = approvedHours;
                    
                    // Update total allocated hours
                    const newTotalAllocated = (project.totalAllocatedHours || 0) + hoursDiff;
                    
                    await projectRef.update({
                        designerHours: designerHours,
                        totalAllocatedHours: newTotalAllocated,
                        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                        lastAllocationChange: {
                            designerUid: request.designerUid,
                            designerName: request.designerName,
                            previousHours: oldHours,
                            newHours: approvedHours,
                            approvedBy: req.user.name,
                            approvedAt: admin.firestore.FieldValue.serverTimestamp()
                        }
                    });

                    // Notify COO
                    await db.collection('notifications').add({
                        type: 'allocation_change_approved',
                        recipientUid: request.requestedByUid,
                        recipientRole: 'coo',
                        message: `Director ${req.user.name} approved your allocation change request. ${request.designerName}'s hours updated to ${approvedHours}h on "${request.projectName}"`,
                        requestId: id,
                        projectId: request.projectId,
                        projectName: request.projectName,
                        createdAt: admin.firestore.FieldValue.serverTimestamp(),
                        isRead: false,
                        priority: 'high'
                    });

                    // Notify Designer about their updated hours
                    await db.collection('notifications').add({
                        type: 'allocation_hours_updated',
                        recipientUid: request.designerUid,
                        recipientRole: 'designer',
                        message: `Your allocated hours on "${request.projectName}" have been updated from ${oldHours}h to ${approvedHours}h`,
                        projectId: request.projectId,
                        projectName: request.projectName,
                        createdAt: admin.firestore.FieldValue.serverTimestamp(),
                        isRead: false,
                        priority: 'normal'
                    });

                    // Send email notifications
                    try {
                        // Email to COO
                        await sendEmailNotification('allocation.change_approved', {
                            projectName: request.projectName,
                            designerName: request.designerName,
                            oldHours: oldHours,
                            newHours: approvedHours,
                            approvedBy: req.user.name,
                            cooEmail: request.requestedByEmail
                        });

                        // Email to Designer
                        if (request.designerEmail) {
                            await sendEmailNotification('allocation.hours_updated', {
                                projectName: request.projectName,
                                designerName: request.designerName,
                                oldHours: oldHours,
                                newHours: approvedHours,
                                designerEmail: request.designerEmail
                            });
                        }
                    } catch (emailErr) {
                        console.error('Email notification failed:', emailErr);
                    }

                    // Log activity
                    await db.collection('activities').add({
                        type: 'allocation_change_approved',
                        details: `Director ${req.user.name} approved allocation change for ${request.designerName}: ${request.currentAllocatedHours}h → ${approvedHours}h`,
                        performedByName: req.user.name,
                        performedByRole: req.user.role,
                        performedByUid: req.user.uid,
                        timestamp: admin.firestore.FieldValue.serverTimestamp(),
                        projectId: request.projectId,
                        projectName: request.projectName,
                        requestId: id
                    });
                }

            // ============================================
            // REJECT - Notify COO
            // ============================================
            } else if (action === 'reject') {
                updateData.status = 'rejected';
                updateData.rejectionReason = comment || 'No reason provided';

                // Notify COO
                await db.collection('notifications').add({
                    type: 'allocation_change_rejected',
                    recipientUid: request.requestedByUid,
                    recipientRole: 'coo',
                    message: `Director ${req.user.name} rejected your allocation change request for "${request.designerName}" on "${request.projectName}". Reason: ${comment || 'Not specified'}`,
                    requestId: id,
                    projectId: request.projectId,
                    projectName: request.projectName,
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    isRead: false,
                    priority: 'high'
                });

                // Send email to COO
                try {
                    await sendEmailNotification('allocation.change_rejected', {
                        projectName: request.projectName,
                        designerName: request.designerName,
                        requestedHours: request.requestedNewHours,
                        rejectedBy: req.user.name,
                        reason: comment || 'Not specified',
                        cooEmail: request.requestedByEmail
                    });
                } catch (emailErr) {
                    console.error('Email notification failed:', emailErr);
                }

                // Log activity
                await db.collection('activities').add({
                    type: 'allocation_change_rejected',
                    details: `Director ${req.user.name} rejected allocation change for ${request.designerName}. Reason: ${comment || 'Not specified'}`,
                    performedByName: req.user.name,
                    performedByRole: req.user.role,
                    performedByUid: req.user.uid,
                    timestamp: admin.firestore.FieldValue.serverTimestamp(),
                    projectId: request.projectId,
                    projectName: request.projectName,
                    requestId: id
                });

            } else {
                return res.status(400).json({ success: false, error: 'Invalid action. Use "approve" or "reject"' });
            }

            // Update the request
            await requestRef.update(updateData);

            return res.status(200).json({ 
                success: true, 
                message: `Allocation change request ${action}d successfully`
            });
        }

        // ============================================
        // DELETE - Cancel pending request (COO only)
        // ============================================
        if (req.method === 'DELETE') {
            const { id } = req.query;

            if (!id) {
                return res.status(400).json({ success: false, error: 'Request ID is required' });
            }

            const requestRef = db.collection('allocation-change-requests').doc(id);
            const requestDoc = await requestRef.get();

            if (!requestDoc.exists) {
                return res.status(404).json({ success: false, error: 'Request not found' });
            }

            const request = requestDoc.data();

            // Only COO who created it can cancel, or Director
            if (request.requestedByUid !== req.user.uid && req.user.role !== 'director') {
                return res.status(403).json({ 
                    success: false, 
                    error: 'You can only cancel your own requests' 
                });
            }

            if (request.status !== 'pending') {
                return res.status(400).json({ 
                    success: false, 
                    error: 'Only pending requests can be cancelled' 
                });
            }

            await requestRef.update({
                status: 'cancelled',
                cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
                cancelledByUid: req.user.uid,
                cancelledByName: req.user.name
            });

            return res.status(200).json({ 
                success: true, 
                message: 'Request cancelled successfully' 
            });
        }

        return res.status(405).json({ success: false, error: 'Method not allowed' });

    } catch (error) {
        console.error('Error in allocation-requests handler:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
};

module.exports = allowCors(handler);
