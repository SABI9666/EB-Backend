// api/leave-requests.js - HR Leave Management System
const express = require('express');
const router = express.Router();
const { verifyToken, requireRole } = require('../middleware/auth');
const admin = require('./_firebase-admin');
const db = admin.firestore();

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
            emergencyPhone
        } = req.body;

        // Validation
        if (!leaveType || !startDate || !endDate || !reason) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields'
            });
        }

        // Calculate number of days
        const start = new Date(startDate);
        const end = new Date(endDate);
        const diffTime = Math.abs(end - start);
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1;

        // Determine reporting officer based on role
        let reportingOfficer = 'coo'; // Default
        if (['coo'].includes(req.user.role)) {
            reportingOfficer = 'director';
        }

        // Create leave request
        const leaveRequest = {
            employeeUid: req.user.uid,
            employeeName: req.user.name,
            employeeEmail: req.user.email,
            employeeRole: req.user.role,
            leaveType,
            startDate,
            endDate,
            numberOfDays: diffDays,
            reason,
            emergencyContact: emergencyContact || '',
            emergencyPhone: emergencyPhone || '',
            
            // Multi-level approval workflow
            reportingOfficer, // COO or Director
            reportingOfficerStatus: 'pending',
            reportingOfficerApprovedAt: null,
            reportingOfficerComments: '',
            
            hrStatus: 'pending',
            hrApprovedAt: null,
            hrComments: '',
            hrCategory: '', // HR categorizes leave type
            
            directorStatus: 'pending',
            directorApprovedAt: null,
            directorComments: '',
            
            // Overall status
            status: 'pending', // pending, approved, rejected
            currentStage: 1, // 1: Reporting Officer, 2: HR, 3: Director
            
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        const docRef = await db.collection('leaveRequests').add(leaveRequest);

        // Log activity
        await db.collection('activities').add({
            type: 'leave_request_submitted',
            message: `${req.user.name} submitted a leave request for ${diffDays} days`,
            performedBy: req.user.uid,
            performedByName: req.user.name,
            leaveRequestId: docRef.id,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });

        res.json({
            success: true,
            message: 'Leave request submitted successfully',
            leaveRequestId: docRef.id,
            data: leaveRequest
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
            requests.push({
                id: doc.id,
                ...doc.data(),
                createdAt: doc.data().createdAt?.toDate().toISOString(),
                updatedAt: doc.data().updatedAt?.toDate().toISOString()
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
// REPORTING OFFICER: Get Pending Approvals (Stage 1)
// ============================================
router.get('/pending-stage1', verifyToken, requireRole(['coo', 'director']), async (req, res) => {
    try {
        const reportingRole = req.user.role;
        
        const snapshot = await db.collection('leaveRequests')
            .where('reportingOfficer', '==', reportingRole)
            .where('reportingOfficerStatus', '==', 'pending')
            .where('currentStage', '==', 1)
            .orderBy('createdAt', 'desc')
            .get();

        const requests = [];
        snapshot.forEach(doc => {
            requests.push({
                id: doc.id,
                ...doc.data(),
                createdAt: doc.data().createdAt?.toDate().toISOString()
            });
        });

        res.json({
            success: true,
            data: requests
        });

    } catch (error) {
        console.error('Get stage 1 pending requests error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch pending requests',
            details: error.message
        });
    }
});

// ============================================
// REPORTING OFFICER: Approve/Reject (Stage 1)
// ============================================
router.put('/stage1/:id', verifyToken, requireRole(['coo', 'director']), async (req, res) => {
    try {
        const { id } = req.params;
        const { action, comments } = req.body; // action: 'approve' or 'reject'

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

        // Check if this user is the reporting officer
        if (leaveData.reportingOfficer !== req.user.role) {
            return res.status(403).json({
                success: false,
                error: 'You are not authorized to approve this request'
            });
        }

        const updateData = {
            reportingOfficerStatus: action === 'approve' ? 'approved' : 'rejected',
            reportingOfficerApprovedAt: admin.firestore.FieldValue.serverTimestamp(),
            reportingOfficerComments: comments || '',
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
            type: `leave_stage1_${action}`,
            message: `${req.user.name} ${action}ed leave request for ${leaveData.employeeName}`,
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
        console.error('Stage 1 approval error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to process approval',
            details: error.message
        });
    }
});

// ============================================
// HR: Get Pending Approvals (Stage 2)
// ============================================
router.get('/pending-stage2', verifyToken, requireRole(['hr']), async (req, res) => {
    try {
        const snapshot = await db.collection('leaveRequests')
            .where('hrStatus', '==', 'pending')
            .where('currentStage', '==', 2)
            .orderBy('createdAt', 'desc')
            .get();

        const requests = [];
        snapshot.forEach(doc => {
            requests.push({
                id: doc.id,
                ...doc.data(),
                createdAt: doc.data().createdAt?.toDate().toISOString()
            });
        });

        res.json({
            success: true,
            data: requests
        });

    } catch (error) {
        console.error('Get stage 2 pending requests error:', error);
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
router.put('/stage2/:id', verifyToken, requireRole(['hr']), async (req, res) => {
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

        const updateData = {
            hrStatus: action === 'approve' ? 'approved' : 'rejected',
            hrApprovedAt: admin.firestore.FieldValue.serverTimestamp(),
            hrComments: comments || '',
            hrCategory: hrCategory || leaveData.leaveType,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        if (action === 'approve') {
            // Move to Stage 3 (Director)
            updateData.currentStage = 3;
        } else {
            // Rejected by HR
            updateData.status = 'rejected';
            updateData.currentStage = 0;
        }

        await docRef.update(updateData);

        // Log activity
        await db.collection('activities').add({
            type: `leave_stage2_${action}`,
            message: `HR ${action}ed leave request for ${leaveData.employeeName}`,
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
        console.error('Stage 2 approval error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to process approval',
            details: error.message
        });
    }
});

// ============================================
// DIRECTOR: Get Pending Approvals (Stage 3 - Final)
// ============================================
router.get('/pending-stage3', verifyToken, requireRole(['director']), async (req, res) => {
    try {
        const snapshot = await db.collection('leaveRequests')
            .where('directorStatus', '==', 'pending')
            .where('currentStage', '==', 3)
            .orderBy('createdAt', 'desc')
            .get();

        const requests = [];
        snapshot.forEach(doc => {
            requests.push({
                id: doc.id,
                ...doc.data(),
                createdAt: doc.data().createdAt?.toDate().toISOString()
            });
        });

        res.json({
            success: true,
            data: requests
        });

    } catch (error) {
        console.error('Get stage 3 pending requests error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch pending requests',
            details: error.message
        });
    }
});

// ============================================
// DIRECTOR: Final Approve/Reject (Stage 3)
// ============================================
router.put('/stage3/:id', verifyToken, requireRole(['director']), async (req, res) => {
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

        const updateData = {
            directorStatus: action === 'approve' ? 'approved' : 'rejected',
            directorApprovedAt: admin.firestore.FieldValue.serverTimestamp(),
            directorComments: comments || '',
            status: action === 'approve' ? 'approved' : 'rejected',
            currentStage: action === 'approve' ? 4 : 0, // 4 = completed, 0 = rejected
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        await docRef.update(updateData);

        // Log activity
        await db.collection('activities').add({
            type: `leave_final_${action}`,
            message: `Director ${action}ed leave request for ${leaveData.employeeName} (FINAL)`,
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
        console.error('Stage 3 approval error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to process final approval',
            details: error.message
        });
    }
});

// ============================================
// ALL: Get Leave Request by ID (for viewing details)
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

        // Check access - employee can see their own, approvers can see their queue
        const canView = (
            leaveData.employeeUid === req.user.uid ||
            ['coo', 'director', 'hr'].includes(req.user.role)
        );

        if (!canView) {
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
            requests.push({
                id: doc.id,
                ...doc.data(),
                createdAt: doc.data().createdAt?.toDate().toISOString()
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

module.exports = router;
