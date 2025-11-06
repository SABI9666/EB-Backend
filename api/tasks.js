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

        if (req.method === 'POST') {
            const { 
                projectId, 
                drawingType, 
                taskDescription, 
                designerName, 
                designerUid,
                startDate, 
                targetDate 
            } = req.body;

            // Validate required fields
            if (!projectId || !taskDescription || !designerName) {
                return res.status(400).json({ 
                    success: false, 
                    error: 'Missing required fields' 
                });
            }

            // Check if user is Design Lead or has permission
            if (!['design_lead', 'coo', 'director'].includes(req.user.role)) {
                return res.status(403).json({ 
                    success: false, 
                    error: 'Only Design Lead, COO, or Director can assign tasks' 
                });
            }

            // Verify project exists
            const projectDoc = await db.collection('projects').doc(projectId).get();
            if (!projectDoc.exists) {
                return res.status(404).json({ 
                    success: false, 
                    error: 'Project not found' 
                });
            }

            const project = projectDoc.data();

            const taskData = {
                projectId,
                projectCode: project.projectCode,
                projectName: project.projectName,
                drawingType: drawingType || 'General',
                taskDescription,
                designerName,
                designerUid: designerUid || '',
                assignedBy: req.user.name,
                assignedByUid: req.user.uid,
                startDate: startDate || admin.firestore.FieldValue.serverTimestamp(),
                targetDate: targetDate || null,
                status: 'not_started', // not_started, in_progress, submitted, revision_required, approved
                submittedDate: null,
                approvedDate: null,
                fileUrl: '',
                comments: [],
                revisionCount: 0,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            };

            const docRef = await db.collection('tasks').add(taskData);

            // Create activity
            await db.collection('activities').add({
                type: 'task_assigned',
                details: `Task assigned to ${designerName} for ${project.projectName}`,
                performedByName: req.user.name,
                performedByRole: req.user.role,
                performedByUid: req.user.uid,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                projectId: projectId,
                taskId: docRef.id
            });

            // Send notification to designer
            await db.collection('notifications').add({
                type: 'task_assigned',
                recipientUid: designerUid,
                recipientName: designerName,
                message: `New design task assigned for ${project.projectName}`,
                projectId: projectId,
                taskId: docRef.id,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                isRead: false
            });

            return res.status(201).json({ 
                success: true, 
                data: { id: docRef.id, ...taskData },
                message: 'Task assigned successfully' 
            });
        }

        if (req.method === 'GET') {
            const { projectId, designerUid, status } = req.query;
            
            let query = db.collection('tasks').orderBy('createdAt', 'desc');
            
            if (projectId) {
                query = query.where('projectId', '==', projectId);
            }
            
            if (designerUid) {
                query = query.where('designerUid', '==', designerUid);
            }
            
            if (status) {
                query = query.where('status', '==', status);
            }
            
            // Designers only see their own tasks
            if (req.user.role === 'designer') {
                query = query.where('designerUid', '==', req.user.uid);
            }
            
            const snapshot = await query.get();
            const tasks = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            
            return res.status(200).json({ success: true, data: tasks });
        }

        if (req.method === 'PUT') {
            const { id } = req.query;
            const { action, data } = req.body;
            
            if (!id || !action) {
                return res.status(400).json({ 
                    success: false, 
                    error: 'Task ID and action required' 
                });
            }
            
            const taskRef = db.collection('tasks').doc(id);
            const taskDoc = await taskRef.get();
            
            if (!taskDoc.exists) {
                return res.status(404).json({ 
                    success: false, 
                    error: 'Task not found' 
                });
            }
            
            const task = taskDoc.data();
            let updates = {};
            let activityDetail = '';
            let notificationRecipient = null;
            let notificationMessage = '';
            
            switch (action) {
                case 'update_status':
                    updates.status = data.status;
                    updates.updatedAt = admin.firestore.FieldValue.serverTimestamp();
                    
                    if (data.status === 'submitted') {
                        updates.submittedDate = admin.firestore.FieldValue.serverTimestamp();
                        updates.fileUrl = data.fileUrl || '';
                        notificationRecipient = task.assignedByUid;
                        notificationMessage = `Drawing submitted by ${task.designerName} for review`;
                    }
                    
                    activityDetail = `Task status updated to ${data.status}`;
                    break;
                    
                case 'approve':
                    if (!['design_lead', 'coo', 'director'].includes(req.user.role)) {
                        return res.status(403).json({ 
                            success: false, 
                            error: 'Insufficient permissions' 
                        });
                    }
                    
                    updates.status = 'approved';
                    updates.approvedDate = admin.firestore.FieldValue.serverTimestamp();
                    updates.approvedBy = req.user.name;
                    activityDetail = 'Task approved';
                    notificationRecipient = task.designerUid;
                    notificationMessage = `Your task for ${task.drawingType} has been approved`;
                    break;
                    
                case 'request_revision':
                    if (!['design_lead', 'coo', 'director'].includes(req.user.role)) {
                        return res.status(403).json({ 
                            success: false, 
                            error: 'Insufficient permissions' 
                        });
                    }
                    
                    updates.status = 'revision_required';
                    updates.revisionCount = admin.firestore.FieldValue.increment(1);
                    updates.comments = admin.firestore.FieldValue.arrayUnion({
                        text: data.comment,
                        by: req.user.name,
                        at: new Date().toISOString()
                    });
                    activityDetail = 'Revision requested';
                    notificationRecipient = task.designerUid;
                    notificationMessage = `Revision required for ${task.drawingType}: ${data.comment}`;
                    break;
                    
                case 'add_comment':
                    updates.comments = admin.firestore.FieldValue.arrayUnion({
                        text: data.comment,
                        by: req.user.name,
                        at: new Date().toISOString()
                    });
                    activityDetail = 'Comment added';
                    break;
                    
                default:
                    return res.status(400).json({ 
                        success: false, 
                        error: 'Invalid action' 
                    });
            }
            
            updates.updatedAt = admin.firestore.FieldValue.serverTimestamp();
            await taskRef.update(updates);
            
            // Log activity
            await db.collection('activities').add({
                type: `task_${action}`,
                details: activityDetail,
                performedByName: req.user.name,
                performedByRole: req.user.role,
                performedByUid: req.user.uid,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                projectId: task.projectId,
                taskId: id
            });
            
            // Send notification if needed
            if (notificationRecipient && notificationMessage) {
                await db.collection('notifications').add({
                    type: `task_${action}`,
                    recipientUid: notificationRecipient,
                    message: notificationMessage,
                    projectId: task.projectId,
                    taskId: id,
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    isRead: false
                });
            }
            
            return res.status(200).json({ 
                success: true, 
                message: 'Task updated successfully' 
            });
        }

        return res.status(405).json({ success: false, error: 'Method not allowed' });
        
    } catch (error) {
        console.error('Tasks API error:', error);
        return res.status(500).json({ 
            success: false, 
            error: 'Internal Server Error', 
            message: error.message 
        });
    }
};

module.exports = allowCors(handler);
