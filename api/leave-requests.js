// api/leave-requests.js - HR Leave Management System
// Version: 5.0.0 - Multi-Level Approval with Role-Based Flows
const express = require('express');
const router = express.Router();
const { verifyToken, requireRole } = require('../middleware/auth');
const admin = require('./_firebase-admin');
const db = admin.firestore();

// ============================================
// DESIGNER TEAM LEADS (Can approve designer leaves)
// These users have leave flow: Team Lead → COO → HR
// ============================================
const DESIGNER_TEAM_LEADS = [
    'muruganantham.tech@edanbrook.in',
    'aravindhan.tech@edanbrook.in',
    'sathish.tech@edanbrook.in',
    'meeraj.tech@edanbrook.in',
    'rebar.lead@edanbrook.com'
];

// ============================================
// APPROVAL FLOW CONFIGURATIONS
// ============================================
// Flow Types:
// Type 1: BDM/Estimator/Accounts → COO → HR → Director (4 stages)
// Type 2: Designer → Team Lead → HR → COO (4 stages)  
// Type 3: Team Lead → COO → HR (3 stages, no Director needed for team leads)
// Type 4: HR → Director (2 stages)
// Type 5: COO → Director (2 stages)
// ============================================

function getApprovalFlow(userRole, userEmail) {
    const emailLower = userEmail.toLowerCase();
    
    // Check if user is a designer team lead
    const isTeamLead = DESIGNER_TEAM_LEADS.some(tl => tl.toLowerCase() === emailLower);
    
    if (isTeamLead) {
        // Team Lead Flow: COO → HR (no Director needed)
        return {
            flowType: 'teamlead_flow',
            stages: [
                { stage: 1, approverType: 'coo', label: 'COO Approval' },
                { stage: 2, approverType: 'hr', label: 'HR Approval' }
            ],
            totalStages: 2,
            requiresTeamLeadSelection: false
        };
    }
    
    switch (userRole.toLowerCase()) {
        case 'bdm':
        case 'estimator':
        case 'accounts':
            // BDM/Estimator/Accounts Flow: COO → HR → Director
            return {
                flowType: 'standard_flow',
                stages: [
                    { stage: 1, approverType: 'coo', label: 'COO Approval' },
                    { stage: 2, approverType: 'hr', label: 'HR Approval' },
                    { stage: 3, approverType: 'director', label: 'Director Approval' }
                ],
                totalStages: 3,
                requiresTeamLeadSelection: false
            };
            
        case 'designer':
            // Designer Flow: Team Lead → HR → COO
            return {
                flowType: 'designer_flow',
                stages: [
                    { stage: 1, approverType: 'teamlead', label: 'Team Lead Approval' },
                    { stage: 2, approverType: 'hr', label: 'HR Approval' },
                    { stage: 3, approverType: 'coo', label: 'COO Approval' }
                ],
                totalStages: 3,
                requiresTeamLeadSelection: true,
                availableTeamLeads: DESIGNER_TEAM_LEADS
            };
            
        case 'hr':
            // HR Flow: Director only
            return {
                flowType: 'hr_flow',
                stages: [
                    { stage: 1, approverType: 'director', label: 'Director Approval' }
                ],
                totalStages: 1,
                requiresTeamLeadSelection: false
            };
            
        case 'coo':
            // COO Flow: Director only
            return {
                flowType: 'coo_flow',
                stages: [
                    { stage: 1, approverType: 'director', label: 'Director Approval' }
                ],
                totalStages: 1,
                requiresTeamLeadSelection: false
            };
            
        case 'director':
            // Director has no leave flow (self-approved or manual)
            return {
                flowType: 'director_flow',
                stages: [],
                totalStages: 0,
                requiresTeamLeadSelection: false,
                message: 'Director leaves are handled separately'
            };
            
        default:
            // Default Flow: COO → HR → Director
            return {
                flowType: 'default_flow',
                stages: [
                    { stage: 1, approverType: 'coo', label: 'COO Approval' },
                    { stage: 2, approverType: 'hr', label: 'HR Approval' },
                    { stage: 3, approverType: 'director', label: 'Director Approval' }
                ],
                totalStages: 3,
                requiresTeamLeadSelection: false
            };
    }
}

// ============================================
// GET: Approval Flow Info (for UI to show correct form)
// ============================================
router.get('/approval-flow', verifyToken, async (req, res) => {
    try {
        const flow = getApprovalFlow(req.user.role, req.user.email);
        
        res.json({
            success: true,
            data: {
                userRole: req.user.role,
                userEmail: req.user.email,
                ...flow
            }
        });
    } catch (error) {
        console.error('Get approval flow error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get approval flow',
            details: error.message
        });
    }
});

// ============================================
// GET: Available Team Leads (for Designer dropdown)
// ============================================
router.get('/team-leads', verifyToken, async (req, res) => {
    try {
        // Fetch team lead details from users collection
        const teamLeadDetails = [];
        
        for (const email of DESIGNER_TEAM_LEADS) {
            const userSnapshot = await db.collection('users')
                .where('email', '==', email)
                .limit(1)
                .get();
            
            if (!userSnapshot.empty) {
                const userData = userSnapshot.docs[0].data();
                teamLeadDetails.push({
                    email: email,
                    name: userData.name || email.split('@')[0],
                    uid: userSnapshot.docs[0].id
                });
            } else {
                // User not found in DB, still add with email
                teamLeadDetails.push({
                    email: email,
                    name: email.split('@')[0].replace('.', ' ').replace(/\b\w/g, l => l.toUpperCase()),
                    uid: null
                });
            }
        }
        
        res.json({
            success: true,
            data: teamLeadDetails
        });
    } catch (error) {
        console.error('Get team leads error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch team leads',
            details: error.message
        });
    }
});

// ============================================
// EMPLOYEE: Submit Leave Request
// ============================================
router.post('/submit', verifyToken, requireRole(['bdm', 'estimator', 'designer', 'accounts', 'coo', 'hr', 'director']), async (req, res) => {
    try {
        const {
            leaveType,
            startDate,
            endDate,
            reason,
            emergencyContact,
            emergencyPhone,
            selectedTeamLead // Required for designers
        } = req.body;

        // Validation
        if (!leaveType || !startDate || !endDate || !reason) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields'
            });
        }

        // Get approval flow for this user
        const approvalFlow = getApprovalFlow(req.user.role, req.user.email);
        
        // Validate team lead selection for designers
        if (approvalFlow.requiresTeamLeadSelection) {
            if (!selectedTeamLead) {
                return res.status(400).json({
                    success: false,
                    error: 'Please select your reporting Team Lead'
                });
            }
            
            const isValidTeamLead = DESIGNER_TEAM_LEADS.some(
                tl => tl.toLowerCase() === selectedTeamLead.toLowerCase()
            );
            
            if (!isValidTeamLead) {
                return res.status(400).json({
                    success: false,
                    error: 'Invalid team lead selected'
                });
            }
        }

        // Calculate number of days
        const start = new Date(startDate);
        const end = new Date(endDate);
        const diffTime = Math.abs(end - start);
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1;

        // Create leave request with multi-stage approval tracking
        const leaveRequest = {
            // Employee Info
            employeeUid: req.user.uid,
            employeeName: req.user.name,
            employeeEmail: req.user.email,
            employeeRole: req.user.role,
            
            // Leave Details
            leaveType,
            startDate,
            endDate,
            numberOfDays: diffDays,
            reason,
            emergencyContact: emergencyContact || '',
            emergencyPhone: emergencyPhone || '',
            
            // Approval Flow Configuration
            flowType: approvalFlow.flowType,
            totalStages: approvalFlow.totalStages,
            currentStage: approvalFlow.totalStages > 0 ? 1 : 0,
            
            // Selected Team Lead (for designers)
            selectedTeamLead: selectedTeamLead || null,
            
            // Stage 1 Approval (varies by flow)
            stage1ApproverType: approvalFlow.stages[0]?.approverType || null,
            stage1ApproverEmail: approvalFlow.flowType === 'designer_flow' ? selectedTeamLead : null,
            stage1Status: approvalFlow.totalStages >= 1 ? 'pending' : 'not_required',
            stage1ApprovedAt: null,
            stage1ApprovedBy: null,
            stage1ApprovedByName: null,
            stage1Comments: '',
            
            // Stage 2 Approval
            stage2ApproverType: approvalFlow.stages[1]?.approverType || null,
            stage2Status: approvalFlow.totalStages >= 2 ? 'pending' : 'not_required',
            stage2ApprovedAt: null,
            stage2ApprovedBy: null,
            stage2ApprovedByName: null,
            stage2Comments: '',
            stage2Category: '', // HR categorization
            
            // Stage 3 Approval
            stage3ApproverType: approvalFlow.stages[2]?.approverType || null,
            stage3Status: approvalFlow.totalStages >= 3 ? 'pending' : 'not_required',
            stage3ApprovedAt: null,
            stage3ApprovedBy: null,
            stage3ApprovedByName: null,
            stage3Comments: '',
            
            // Overall Status
            status: 'pending', // pending, approved, rejected
            
            // Timestamps
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        const docRef = await db.collection('leaveRequests').add(leaveRequest);

        // Log activity
        await db.collection('activities').add({
            type: 'leave_request_submitted',
            message: `${req.user.name} submitted a leave request for ${diffDays} days (${leaveType})`,
            performedBy: req.user.uid,
            performedByName: req.user.name,
            leaveRequestId: docRef.id,
            flowType: approvalFlow.flowType,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });

        res.json({
            success: true,
            message: 'Leave request submitted successfully',
            leaveRequestId: docRef.id,
            data: {
                ...leaveRequest,
                id: docRef.id,
                approvalFlow: approvalFlow
            }
        });

    } catch (error) {
        console.error('Submit leave request error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to submit leave request',
            details: error.message
        });
    }
});

// ============================================
// EMPLOYEE: Get My Leave Requests
// ============================================
router.get('/my-requests', verifyToken, async (req, res) => {
    try {
        const snapshot = await db.collection('leaveRequests')
            .where('employeeUid', '==', req.user.uid)
            .orderBy('createdAt', 'desc')
            .get();

        const requests = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            requests.push({
                id: doc.id,
                ...data,
                createdAt: data.createdAt?.toDate().toISOString(),
                updatedAt: data.updatedAt?.toDate().toISOString()
            });
        });

        res.json({
            success: true,
            data: requests
        });

    } catch (error) {
        console.error('Get my leave requests error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch leave requests',
            details: error.message
        });
    }
});

// ============================================
// TEAM LEAD: Get Pending Designer Approvals (Stage 1)
// ============================================
router.get('/pending-teamlead', verifyToken, async (req, res) => {
    try {
        const userEmail = req.user.email.toLowerCase();
        
        // Check if user is a team lead
        const isTeamLead = DESIGNER_TEAM_LEADS.some(tl => tl.toLowerCase() === userEmail);
        
        if (!isTeamLead) {
            return res.status(403).json({
                success: false,
                error: 'You are not authorized as a team lead'
            });
        }

        // Get requests where this team lead is selected
        const snapshot = await db.collection('leaveRequests')
            .where('selectedTeamLead', '==', req.user.email)
            .where('currentStage', '==', 1)
            .where('stage1Status', '==', 'pending')
            .orderBy('createdAt', 'desc')
            .get();

        const requests = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            requests.push({
                id: doc.id,
                ...data,
                createdAt: data.createdAt?.toDate().toISOString()
            });
        });

        res.json({
            success: true,
            data: requests
        });

    } catch (error) {
        console.error('Get team lead pending requests error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch pending requests',
            details: error.message
        });
    }
});

// ============================================
// TEAM LEAD: Approve/Reject Designer Leave (Stage 1)
// ============================================
router.put('/teamlead-approve/:id', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { action, comments } = req.body;
        const userEmail = req.user.email.toLowerCase();

        // Check if user is a team lead
        const isTeamLead = DESIGNER_TEAM_LEADS.some(tl => tl.toLowerCase() === userEmail);
        
        if (!isTeamLead) {
            return res.status(403).json({
                success: false,
                error: 'You are not authorized as a team lead'
            });
        }

        if (!['approve', 'reject'].includes(action)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid action. Use "approve" or "reject"'
            });
        }

        const docRef = db.collection('leaveRequests').doc(id);
        const doc = await docRef.get();

        if (!doc.exists) {
            return res.status(404).json({
                success: false,
                error: 'Leave request not found'
            });
        }

        const leaveData = doc.data();

        // Verify this team lead is assigned to this request
        if (leaveData.selectedTeamLead?.toLowerCase() !== userEmail) {
            return res.status(403).json({
                success: false,
                error: 'You are not the assigned team lead for this request'
            });
        }

        const updateData = {
            stage1Status: action === 'approve' ? 'approved' : 'rejected',
            stage1ApprovedAt: admin.firestore.FieldValue.serverTimestamp(),
            stage1ApprovedBy: req.user.uid,
            stage1ApprovedByName: req.user.name,
            stage1Comments: comments || '',
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        if (action === 'approve') {
            // Move to Stage 2 (HR)
            updateData.currentStage = 2;
        } else {
            // Rejected - end workflow
            updateData.status = 'rejected';
            updateData.currentStage = 0;
        }

        await docRef.update(updateData);

        // Log activity
        await db.collection('activities').add({
            type: `leave_teamlead_${action}`,
            message: `Team Lead ${req.user.name} ${action}ed leave request for ${leaveData.employeeName}`,
            performedBy: req.user.uid,
            performedByName: req.user.name,
            leaveRequestId: id,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });

        res.json({
            success: true,
            message: `Leave request ${action}ed successfully`
        });

    } catch (error) {
        console.error('Team lead approval error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to process approval',
            details: error.message
        });
    }
});

// ============================================
// COO: Get Pending Approvals
// COO approves: BDM/Estimator/Accounts (Stage 1), Team Leads (Stage 1), Designers (Stage 3)
// ============================================
router.get('/pending-coo', verifyToken, requireRole(['coo']), async (req, res) => {
    try {
        const requests = [];
        
        // 1. Get Stage 1 requests where COO is the first approver (BDM, Estimator, Accounts)
        const stage1Snapshot = await db.collection('leaveRequests')
            .where('stage1ApproverType', '==', 'coo')
            .where('currentStage', '==', 1)
            .where('stage1Status', '==', 'pending')
            .orderBy('createdAt', 'desc')
            .get();

        stage1Snapshot.forEach(doc => {
            const data = doc.data();
            requests.push({
                id: doc.id,
                ...data,
                approvalStage: 1,
                createdAt: data.createdAt?.toDate().toISOString()
            });
        });

        // 2. Get Stage 3 requests for Designer flow (COO is final approver)
        const stage3Snapshot = await db.collection('leaveRequests')
            .where('stage3ApproverType', '==', 'coo')
            .where('currentStage', '==', 3)
            .where('stage3Status', '==', 'pending')
            .orderBy('createdAt', 'desc')
            .get();

        stage3Snapshot.forEach(doc => {
            const data = doc.data();
            requests.push({
                id: doc.id,
                ...data,
                approvalStage: 3,
                createdAt: data.createdAt?.toDate().toISOString()
            });
        });

        res.json({
            success: true,
            data: requests
        });

    } catch (error) {
        console.error('Get COO pending requests error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch pending requests',
            details: error.message
        });
    }
});

// ============================================
// COO: Approve/Reject Leave
// ============================================
router.put('/coo-approve/:id', verifyToken, requireRole(['coo']), async (req, res) => {
    try {
        const { id } = req.params;
        const { action, comments } = req.body;

        if (!['approve', 'reject'].includes(action)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid action'
            });
        }

        const docRef = db.collection('leaveRequests').doc(id);
        const doc = await docRef.get();

        if (!doc.exists) {
            return res.status(404).json({
                success: false,
                error: 'Leave request not found'
            });
        }

        const leaveData = doc.data();
        const currentStage = leaveData.currentStage;
        
        // Determine which stage COO is approving
        let stageField = '';
        let nextStage = 0;
        let isFinal = false;

        if (currentStage === 1 && leaveData.stage1ApproverType === 'coo') {
            stageField = 'stage1';
            nextStage = 2; // Move to HR
        } else if (currentStage === 3 && leaveData.stage3ApproverType === 'coo') {
            stageField = 'stage3';
            isFinal = true; // COO is final approver for designer flow
        } else {
            return res.status(403).json({
                success: false,
                error: 'This request is not pending COO approval at this stage'
            });
        }

        const updateData = {
            [`${stageField}Status`]: action === 'approve' ? 'approved' : 'rejected',
            [`${stageField}ApprovedAt`]: admin.firestore.FieldValue.serverTimestamp(),
            [`${stageField}ApprovedBy`]: req.user.uid,
            [`${stageField}ApprovedByName`]: req.user.name,
            [`${stageField}Comments`]: comments || '',
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        if (action === 'approve') {
            if (isFinal) {
                updateData.status = 'approved';
                updateData.currentStage = 4; // Completed
            } else {
                updateData.currentStage = nextStage;
            }
        } else {
            updateData.status = 'rejected';
            updateData.currentStage = 0;
        }

        await docRef.update(updateData);

        // Log activity
        await db.collection('activities').add({
            type: `leave_coo_${action}`,
            message: `COO ${req.user.name} ${action}ed leave request for ${leaveData.employeeName}${isFinal ? ' (FINAL)' : ''}`,
            performedBy: req.user.uid,
            performedByName: req.user.name,
            leaveRequestId: id,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });

        res.json({
            success: true,
            message: `Leave request ${action}ed by COO${isFinal ? ' (Final)' : ''}`
        });

    } catch (error) {
        console.error('COO approval error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to process approval',
            details: error.message
        });
    }
});

// ============================================
// HR: Get Pending Approvals (Stage 2 for most flows)
// ============================================
router.get('/pending-hr', verifyToken, requireRole(['hr']), async (req, res) => {
    try {
        // Get requests where HR is at Stage 2
        const snapshot = await db.collection('leaveRequests')
            .where('stage2ApproverType', '==', 'hr')
            .where('currentStage', '==', 2)
            .where('stage2Status', '==', 'pending')
            .orderBy('createdAt', 'desc')
            .get();

        const requests = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            requests.push({
                id: doc.id,
                ...data,
                createdAt: data.createdAt?.toDate().toISOString()
            });
        });

        res.json({
            success: true,
            data: requests
        });

    } catch (error) {
        console.error('Get HR pending requests error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch pending requests',
            details: error.message
        });
    }
});

// ============================================
// HR: Approve/Reject + Categorize (Stage 2)
// ============================================
router.put('/hr-approve/:id', verifyToken, requireRole(['hr']), async (req, res) => {
    try {
        const { id } = req.params;
        const { action, comments, hrCategory } = req.body;

        if (!['approve', 'reject'].includes(action)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid action'
            });
        }

        const docRef = db.collection('leaveRequests').doc(id);
        const doc = await docRef.get();

        if (!doc.exists) {
            return res.status(404).json({
                success: false,
                error: 'Leave request not found'
            });
        }

        const leaveData = doc.data();

        // Verify HR is the approver at current stage
        if (leaveData.currentStage !== 2 || leaveData.stage2ApproverType !== 'hr') {
            return res.status(403).json({
                success: false,
                error: 'This request is not pending HR approval'
            });
        }

        const updateData = {
            stage2Status: action === 'approve' ? 'approved' : 'rejected',
            stage2ApprovedAt: admin.firestore.FieldValue.serverTimestamp(),
            stage2ApprovedBy: req.user.uid,
            stage2ApprovedByName: req.user.name,
            stage2Comments: comments || '',
            stage2Category: hrCategory || leaveData.leaveType,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        if (action === 'approve') {
            // Check if there's a Stage 3
            if (leaveData.totalStages >= 3 && leaveData.stage3ApproverType) {
                updateData.currentStage = 3;
            } else {
                // HR is final for team lead flow
                updateData.status = 'approved';
                updateData.currentStage = 4; // Completed
            }
        } else {
            updateData.status = 'rejected';
            updateData.currentStage = 0;
        }

        await docRef.update(updateData);

        // Log activity
        await db.collection('activities').add({
            type: `leave_hr_${action}`,
            message: `HR ${req.user.name} ${action}ed leave request for ${leaveData.employeeName}`,
            performedBy: req.user.uid,
            performedByName: req.user.name,
            leaveRequestId: id,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });

        res.json({
            success: true,
            message: `Leave request ${action}ed by HR`
        });

    } catch (error) {
        console.error('HR approval error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to process approval',
            details: error.message
        });
    }
});

// ============================================
// DIRECTOR: Get Pending Approvals
// Director approves: BDM/Estimator/Accounts (Stage 3), HR (Stage 1), COO (Stage 1)
// ============================================
router.get('/pending-director', verifyToken, requireRole(['director']), async (req, res) => {
    try {
        const requests = [];
        
        // 1. Get Stage 3 requests (BDM, Estimator, Accounts final approval)
        const stage3Snapshot = await db.collection('leaveRequests')
            .where('stage3ApproverType', '==', 'director')
            .where('currentStage', '==', 3)
            .where('stage3Status', '==', 'pending')
            .orderBy('createdAt', 'desc')
            .get();

        stage3Snapshot.forEach(doc => {
            const data = doc.data();
            requests.push({
                id: doc.id,
                ...data,
                approvalStage: 3,
                createdAt: data.createdAt?.toDate().toISOString()
            });
        });

        // 2. Get Stage 1 requests where Director is first approver (HR, COO leaves)
        const stage1Snapshot = await db.collection('leaveRequests')
            .where('stage1ApproverType', '==', 'director')
            .where('currentStage', '==', 1)
            .where('stage1Status', '==', 'pending')
            .orderBy('createdAt', 'desc')
            .get();

        stage1Snapshot.forEach(doc => {
            const data = doc.data();
            requests.push({
                id: doc.id,
                ...data,
                approvalStage: 1,
                createdAt: data.createdAt?.toDate().toISOString()
            });
        });

        res.json({
            success: true,
            data: requests
        });

    } catch (error) {
        console.error('Get Director pending requests error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch pending requests',
            details: error.message
        });
    }
});

// ============================================
// DIRECTOR: Approve/Reject Leave (Final for most flows)
// ============================================
router.put('/director-approve/:id', verifyToken, requireRole(['director']), async (req, res) => {
    try {
        const { id } = req.params;
        const { action, comments } = req.body;

        if (!['approve', 'reject'].includes(action)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid action'
            });
        }

        const docRef = db.collection('leaveRequests').doc(id);
        const doc = await docRef.get();

        if (!doc.exists) {
            return res.status(404).json({
                success: false,
                error: 'Leave request not found'
            });
        }

        const leaveData = doc.data();
        const currentStage = leaveData.currentStage;
        
        // Determine which stage Director is approving
        let stageField = '';
        
        if (currentStage === 1 && leaveData.stage1ApproverType === 'director') {
            stageField = 'stage1';
        } else if (currentStage === 3 && leaveData.stage3ApproverType === 'director') {
            stageField = 'stage3';
        } else {
            return res.status(403).json({
                success: false,
                error: 'This request is not pending Director approval'
            });
        }

        const updateData = {
            [`${stageField}Status`]: action === 'approve' ? 'approved' : 'rejected',
            [`${stageField}ApprovedAt`]: admin.firestore.FieldValue.serverTimestamp(),
            [`${stageField}ApprovedBy`]: req.user.uid,
            [`${stageField}ApprovedByName`]: req.user.name,
            [`${stageField}Comments`]: comments || '',
            status: action === 'approve' ? 'approved' : 'rejected',
            currentStage: action === 'approve' ? 4 : 0, // 4 = completed, 0 = rejected
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        await docRef.update(updateData);

        // Log activity
        await db.collection('activities').add({
            type: `leave_director_${action}`,
            message: `Director ${req.user.name} ${action}ed leave request for ${leaveData.employeeName} (FINAL)`,
            performedBy: req.user.uid,
            performedByName: req.user.name,
            leaveRequestId: id,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });

        res.json({
            success: true,
            message: `Leave request ${action}ed by Director (Final)`
        });

    } catch (error) {
        console.error('Director approval error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to process approval',
            details: error.message
        });
    }
});

// ============================================
// ALL: Get Leave Request by ID
// ============================================
router.get('/:id', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const doc = await db.collection('leaveRequests').doc(id).get();

        if (!doc.exists) {
            return res.status(404).json({
                success: false,
                error: 'Leave request not found'
            });
        }

        const leaveData = doc.data();
        const userEmail = req.user.email.toLowerCase();

        // Check access permissions
        const isOwner = leaveData.employeeUid === req.user.uid;
        const isManagement = ['coo', 'director', 'hr'].includes(req.user.role);
        const isAssignedTeamLead = leaveData.selectedTeamLead?.toLowerCase() === userEmail;

        if (!isOwner && !isManagement && !isAssignedTeamLead) {
            return res.status(403).json({
                success: false,
                error: 'Access denied'
            });
        }

        res.json({
            success: true,
            data: {
                id: doc.id,
                ...leaveData,
                createdAt: leaveData.createdAt?.toDate().toISOString(),
                updatedAt: leaveData.updatedAt?.toDate().toISOString()
            }
        });

    } catch (error) {
        console.error('Get leave request error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch leave request',
            details: error.message
        });
    }
});

// ============================================
// MANAGEMENT: Get all leave requests (for reporting)
// ============================================
router.get('/all/requests', verifyToken, requireRole(['coo', 'director', 'hr']), async (req, res) => {
    try {
        const snapshot = await db.collection('leaveRequests')
            .orderBy('createdAt', 'desc')
            .limit(100)
            .get();

        const requests = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            requests.push({
                id: doc.id,
                ...data,
                createdAt: data.createdAt?.toDate().toISOString()
            });
        });

        res.json({
            success: true,
            data: requests
        });

    } catch (error) {
        console.error('Get all leave requests error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch leave requests',
            details: error.message
        });
    }
});

// ============================================
// Get pending count for badge display
// ============================================
router.get('/pending/count', verifyToken, async (req, res) => {
    try {
        const userRole = req.user.role;
        const userEmail = req.user.email.toLowerCase();
        let count = 0;

        // Check if user is a team lead
        const isTeamLead = DESIGNER_TEAM_LEADS.some(tl => tl.toLowerCase() === userEmail);

        if (isTeamLead) {
            const snapshot = await db.collection('leaveRequests')
                .where('selectedTeamLead', '==', req.user.email)
                .where('currentStage', '==', 1)
                .where('stage1Status', '==', 'pending')
                .get();
            count += snapshot.size;
        }

        if (userRole === 'coo') {
            // Stage 1 COO approvals
            const s1 = await db.collection('leaveRequests')
                .where('stage1ApproverType', '==', 'coo')
                .where('currentStage', '==', 1)
                .where('stage1Status', '==', 'pending')
                .get();
            count += s1.size;

            // Stage 3 COO approvals (designer flow)
            const s3 = await db.collection('leaveRequests')
                .where('stage3ApproverType', '==', 'coo')
                .where('currentStage', '==', 3)
                .where('stage3Status', '==', 'pending')
                .get();
            count += s3.size;
        }

        if (userRole === 'hr') {
            const snapshot = await db.collection('leaveRequests')
                .where('stage2ApproverType', '==', 'hr')
                .where('currentStage', '==', 2)
                .where('stage2Status', '==', 'pending')
                .get();
            count = snapshot.size;
        }

        if (userRole === 'director') {
            // Stage 1 Director approvals (HR/COO leaves)
            const s1 = await db.collection('leaveRequests')
                .where('stage1ApproverType', '==', 'director')
                .where('currentStage', '==', 1)
                .where('stage1Status', '==', 'pending')
                .get();
            count += s1.size;

            // Stage 3 Director approvals
            const s3 = await db.collection('leaveRequests')
                .where('stage3ApproverType', '==', 'director')
                .where('currentStage', '==', 3)
                .where('stage3Status', '==', 'pending')
                .get();
            count += s3.size;
        }

        res.json({
            success: true,
            count: count
        });

    } catch (error) {
        console.error('Get pending count error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get pending count',
            details: error.message
        });
    }
});

module.exports = router;
