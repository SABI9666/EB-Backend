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
                submissionDate,
                submittedTo,
                submissionMethod,
                drawingNumbers,
                documentTypes,
                submissionProofUrl
            } = req.body;

            // Only Design Lead can submit to client
            if (!['design_lead', 'coo', 'director'].includes(req.user.role)) {
                return res.status(403).json({ 
                    success: false, 
                    error: 'Only Design Lead can submit to client' 
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

            const submissionData = {
                projectId,
                projectCode: project.projectCode,
                projectName: project.projectName,
                clientCompany: project.clientCompany,
                
                submissionDate: submissionDate || admin.firestore.FieldValue.serverTimestamp(),
                submittedBy: req.user.name,
                submittedByUid: req.user.uid,
                submittedTo: submittedTo || project.clientRepresentative || '',
                submissionMethod: submissionMethod || 'Email',
                
                drawingNumbers: drawingNumbers || [],
                documentTypes: documentTypes || [],
                submissionProofUrl: submissionProofUrl || '',
                
                clientFeedback: 'pending', // pending, revision_required, approved, rejected
                clientFeedbackDate: null,
                clientComments: '',
                revisedSubmissionDate: null,
                revisionCount: 0,
                
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            };

            const docRef = await db.collection('submissions').add(submissionData);

            // Update project status
            await db.collection('projects').doc(projectId).update({
                designStatus: 'submitted',
                lastSubmissionDate: submissionDate || admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });

            // Create activity
            await db.collection('activities').add({
                type: 'design_submitted',
                details: `Design submitted to ${submittedTo} for ${project.projectName}`,
                performedByName: req.user.name,
                performedByRole: req.user.role,
                performedByUid: req.user.uid,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                projectId: projectId,
                submissionId: docRef.id
            });

            // Send notifications
            const notificationRoles = ['bdm', 'coo', 'director', 'accounts'];
            for (const role of notificationRoles) {
                await db.collection('notifications').add({
                    type: 'design_submitted',
                    recipientRole: role,
                    recipientUid: role === 'bdm' ? project.bdmUid : null,
                    message: `Design submitted to ${project.clientCompany}. Awaiting feedback.`,
                    projectId: projectId,
                    submissionId: docRef.id,
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    isRead: false
                });
            }

            return res.status(201).json({ 
                success: true, 
                data: { id: docRef.id, ...submissionData },
                message: 'Submission recorded successfully' 
            });
        }

        if (req.method === 'GET') {
            const { projectId, status } = req.query;
            
            let query = db.collection('submissions').orderBy('createdAt', 'desc');
            
            if (projectId) {
                query = query.where('projectId', '==', projectId);
            }
            
            if (status) {
                query = query.where('clientFeedback', '==', status);
            }
            
            const snapshot = await query.get();
            const submissions = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            
            return res.status(200).json({ success: true, data: submissions });
        }

        if (req.method === 'PUT') {
            const { id } = req.query;
            const { action, data } = req.body;
            
            if (!id || !action) {
                return res.status(400).json({ 
                    success: false, 
                    error: 'Submission ID and action required' 
                });
            }
            
            const submissionRef = db.collection('submissions').doc(id);
            const submissionDoc = await submissionRef.get();
            
            if (!submissionDoc.exists) {
                return res.status(404).json({ 
                    success: false, 
                    error: 'Submission not found' 
                });
            }
            
            const submission = submissionDoc.data();
            let updates = {};
            let activityDetail = '';
            let notificationMessage = '';
            let notificationRoles = [];
            
            switch (action) {
                case 'client_feedback':
                    updates.clientFeedback = data.feedback;
                    updates.clientFeedbackDate = admin.firestore.FieldValue.serverTimestamp();
                    updates.clientComments = data.comments || '';
                    
                    if (data.feedback === 'approved') {
                        activityDetail = 'Client approved the design';
                        notificationMessage = `Client approved ${submission.projectName}. Check payment milestone.`;
                        notificationRoles = ['bdm', 'coo', 'director', 'accounts'];
                        
                        // Update project status
                        await db.collection('projects').doc(submission.projectId).update({
                            designStatus: 'approved',
                            status: 'completed',
                            updatedAt: admin.firestore.FieldValue.serverTimestamp()
                        });
                        
                        // Trigger payment milestone check
                        await db.collection('notifications').add({
                            type: 'milestone_check',
                            recipientRole: 'accounts',
                            message: `Design approved for ${submission.projectName}. Please check payment milestone.`,
                            projectId: submission.projectId,
                            priority: 'high',
                            createdAt: admin.firestore.FieldValue.serverTimestamp(),
                            isRead: false
                        });
                    } else if (data.feedback === 'revision_required') {
                        updates.revisionCount = admin.firestore.FieldValue.increment(1);
                        activityDetail = 'Client requested revision';
                        notificationMessage = `Client requested revision for ${submission.projectName}: ${data.comments}`;
                        notificationRoles = ['design_lead', 'coo', 'director'];
                        
                        // Update project status
                        await db.collection('projects').doc(submission.projectId).update({
                            designStatus: 'revision_required',
                            updatedAt: admin.firestore.FieldValue.serverTimestamp()
                        });
                    } else if (data.feedback === 'rejected') {
                        activityDetail = 'Client rejected the design';
                        notificationMessage = `Client rejected ${submission.projectName}. Immediate action required.`;
                        notificationRoles = ['bdm', 'coo', 'director', 'design_lead'];
                        
                        // Update project status
                        await db.collection('projects').doc(submission.projectId).update({
                            designStatus: 'rejected',
                            status: 'on_hold',
                            updatedAt: admin.firestore.FieldValue.serverTimestamp()
                        });
                    }
                    break;
                    
                case 'revised_submission':
                    updates.revisedSubmissionDate = admin.firestore.FieldValue.serverTimestamp();
                    updates.submissionProofUrl = data.proofUrl || submission.submissionProofUrl;
                    updates.clientFeedback = 'pending';
                    activityDetail = 'Revised design submitted to client';
                    notificationMessage = `Revised design submitted to ${submission.clientCompany}`;
                    notificationRoles = ['bdm', 'coo', 'director'];
                    break;
                    
                default:
                    return res.status(400).json({ 
                        success: false, 
                        error: 'Invalid action' 
                    });
            }
            
            updates.updatedAt = admin.firestore.FieldValue.serverTimestamp();
            await submissionRef.update(updates);
            
            // Log activity
            await db.collection('activities').add({
                type: `submission_${action}`,
                details: activityDetail,
                performedByName: req.user.name,
                performedByRole: req.user.role,
                performedByUid: req.user.uid,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                projectId: submission.projectId,
                submissionId: id
            });
            
            // Send notifications
            if (notificationRoles.length > 0) {
                for (const role of notificationRoles) {
                    await db.collection('notifications').add({
                        type: `submission_${action}`,
                        recipientRole: role,
                        message: notificationMessage,
                        projectId: submission.projectId,
                        submissionId: id,
                        createdAt: admin.firestore.FieldValue.serverTimestamp(),
                        isRead: false
                    });
                }
            }
            
            return res.status(200).json({ 
                success: true, 
                message: 'Submission updated successfully' 
            });
        }

        return res.status(405).json({ success: false, error: 'Method not allowed' });
        
    } catch (error) {
        console.error('Submissions API error:', error);
        return res.status(500).json({ 
            success: false, 
            error: 'Internal Server Error', 
            message: error.message 
        });
    }
};

module.exports = allowCors(handler);
