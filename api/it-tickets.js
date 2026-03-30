// api/it-tickets.js - IT Support Ticket Management System
// Full Procurement Workflow: User Request → IT Review (Store Check) → HR Cost Approval → COO Approval → Director Final Approval
const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middleware/auth');
const admin = require('./_firebase-admin');
const db = admin.firestore();

// ============================================
// IT REQUEST CATEGORIES
// ============================================
const IT_CATEGORIES = {
    hardware: {
        label: 'Hardware Request',
        items: ['Desktop Computer', 'Laptop', 'Monitor', 'Keyboard & Mouse', 'Headset', 'Docking Station', 'Printer', 'Scanner', 'UPS/Power Backup', 'Other Hardware']
    },
    software: {
        label: 'Software Request',
        items: ['Operating System', 'Microsoft Office', 'AutoCAD', 'Tekla Structures', 'SDS/2', 'Adobe Suite', 'Antivirus', 'VPN Client', 'Project Management Tool', 'Other Software']
    },
    network: {
        label: 'Network & Connectivity',
        items: ['Internet Issue', 'Wi-Fi Access', 'VPN Setup', 'Email Configuration', 'Network Drive Access', 'Firewall Exception', 'Other Network Issue']
    },
    access: {
        label: 'Access & Permissions',
        items: ['New User Account', 'Password Reset', 'Email Account Setup', 'Shared Drive Access', 'Software License', 'Cloud Storage Access', 'Application Access', 'Other Access Request']
    },
    maintenance: {
        label: 'Maintenance & Repair',
        items: ['Computer Not Working', 'Slow Performance', 'Blue Screen/Crash', 'Data Recovery', 'Virus/Malware Removal', 'Hardware Repair', 'Software Update', 'Other Maintenance']
    },
    other: {
        label: 'Other IT Support',
        items: ['Training Request', 'Data Backup', 'Equipment Return', 'Workstation Setup', 'Meeting Room Tech Support', 'Other']
    }
};

// ============================================
// PROCUREMENT WORKFLOW STATUSES
// ============================================
// open               → User submitted, waiting for IT review
// available_in_store → IT confirmed item is in store, will be issued
// need_purchase      → IT marked for purchase, sent to HR
// pending_hr         → HR reviewing, adding cost details
// pending_coo        → COO approval pending
// coo_approved       → COO approved, sent to Director
// pending_director   → Director final approval pending
// approved           → Director approved (procurement can proceed)
// rejected           → Rejected at any stage
// in_progress        → IT is working on it (for non-procurement tickets)
// on_hold            → Ticket on hold
// issued             → Item issued from store
// delivered          → Purchased item delivered
// closed             → Ticket closed/completed
// resolved           → Ticket resolved

// ============================================
// GET /api/it-tickets/categories
// ============================================
router.get('/categories', verifyToken, async (req, res) => {
    try {
        res.json({ success: true, data: IT_CATEGORIES });
    } catch (error) {
        console.error('Error fetching categories:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch categories' });
    }
});

// ============================================
// POST /api/it-tickets/submit
// Any user can submit an IT request
// ============================================
router.post('/submit', verifyToken, async (req, res) => {
    try {
        const { category, item, priority, subject, description, quantity, attachments } = req.body;

        if (!category || !item || !subject || !description) {
            return res.status(400).json({
                success: false,
                error: 'Category, item, subject, and description are required'
            });
        }

        const ticketData = {
            ticketNumber: `IT-${Date.now().toString(36).toUpperCase()}`,
            category,
            categoryLabel: IT_CATEGORIES[category]?.label || category,
            item,
            quantity: parseInt(quantity) || 1,
            priority: priority || 'medium',
            subject,
            description,
            attachments: attachments || [],

            // Requester info
            requestedByUid: req.user.uid,
            requestedByName: req.user.name,
            requestedByEmail: req.user.email,
            requestedByRole: req.user.role,

            // Status & workflow tracking
            status: 'open',

            // IT Review
            itReviewedBy: null,
            itReviewedByName: null,
            itReviewedAt: null,
            itNotes: null,
            availability: null, // 'in_store' or 'need_purchase'

            // HR Cost Approval
            hrReviewedBy: null,
            hrReviewedByName: null,
            hrReviewedAt: null,
            hrNotes: null,
            estimatedCost: null,
            currency: 'USD',
            vendor: null,

            // COO Approval
            cooApprovedBy: null,
            cooApprovedByName: null,
            cooApprovedAt: null,
            cooNotes: null,
            cooDecision: null,

            // Director Approval
            directorApprovedBy: null,
            directorApprovedByName: null,
            directorApprovedAt: null,
            directorNotes: null,
            directorDecision: null,

            // Resolution
            resolution: null,
            resolvedAt: null,

            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        const docRef = await db.collection('it_tickets').add(ticketData);

        res.json({
            success: true,
            data: { id: docRef.id, ...ticketData },
            message: `IT ticket ${ticketData.ticketNumber} created successfully`
        });
    } catch (error) {
        console.error('Error submitting IT ticket:', error);
        res.status(500).json({ success: false, error: 'Failed to submit IT ticket' });
    }
});

// ============================================
// GET /api/it-tickets/my-requests
// Get current user's IT requests
// ============================================
router.get('/my-requests', verifyToken, async (req, res) => {
    try {
        const snapshot = await db.collection('it_tickets')
            .where('requestedByUid', '==', req.user.uid)
            .get();

        const tickets = [];
        snapshot.forEach(doc => {
            tickets.push({ id: doc.id, ...doc.data() });
        });

        res.json({ success: true, data: tickets });
    } catch (error) {
        console.error('Error fetching my IT requests:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch requests' });
    }
});

// ============================================
// GET /api/it-tickets/all
// IT, HR, COO, Director can view all tickets
// ============================================
router.get('/all', verifyToken, async (req, res) => {
    try {
        const allowedRoles = ['it', 'hr', 'coo', 'director'];
        if (!allowedRoles.includes(req.user.role)) {
            return res.status(403).json({ success: false, error: 'Insufficient permissions' });
        }

        let query = db.collection('it_tickets');

        const { status } = req.query;
        if (status) {
            query = query.where('status', '==', status);
        }

        const snapshot = await query.get();
        let tickets = [];
        snapshot.forEach(doc => {
            tickets.push({ id: doc.id, ...doc.data() });
        });

        // Sort client-side to avoid composite index requirement
        tickets.sort((a, b) => {
            const dateA = a.createdAt?.toDate ? a.createdAt.toDate() : new Date(a.createdAt || 0);
            const dateB = b.createdAt?.toDate ? b.createdAt.toDate() : new Date(b.createdAt || 0);
            return dateB - dateA;
        });

        res.json({ success: true, data: tickets });
    } catch (error) {
        console.error('Error fetching all IT tickets:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch tickets' });
    }
});

// ============================================
// GET /api/it-tickets/pending-hr
// HR sees tickets that need cost review
// ============================================
router.get('/pending-hr', verifyToken, async (req, res) => {
    try {
        if (req.user.role !== 'hr' && req.user.role !== 'coo' && req.user.role !== 'director') {
            return res.status(403).json({ success: false, error: 'Insufficient permissions' });
        }

        const snapshot = await db.collection('it_tickets')
            .where('status', '==', 'pending_hr')
            .get();

        const tickets = [];
        snapshot.forEach(doc => {
            tickets.push({ id: doc.id, ...doc.data() });
        });

        res.json({ success: true, data: tickets });
    } catch (error) {
        console.error('Error fetching HR pending tickets:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch pending tickets' });
    }
});

// ============================================
// GET /api/it-tickets/pending-coo
// COO sees tickets pending approval
// ============================================
router.get('/pending-coo', verifyToken, async (req, res) => {
    try {
        if (req.user.role !== 'coo' && req.user.role !== 'director') {
            return res.status(403).json({ success: false, error: 'Insufficient permissions' });
        }

        const snapshot = await db.collection('it_tickets')
            .where('status', '==', 'pending_coo')
            .get();

        const tickets = [];
        snapshot.forEach(doc => {
            tickets.push({ id: doc.id, ...doc.data() });
        });

        res.json({ success: true, data: tickets });
    } catch (error) {
        console.error('Error fetching COO pending tickets:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch pending tickets' });
    }
});

// ============================================
// GET /api/it-tickets/pending-director
// Director sees tickets pending final approval
// ============================================
router.get('/pending-director', verifyToken, async (req, res) => {
    try {
        if (req.user.role !== 'director') {
            return res.status(403).json({ success: false, error: 'Insufficient permissions' });
        }

        const snapshot = await db.collection('it_tickets')
            .where('status', '==', 'pending_director')
            .get();

        const tickets = [];
        snapshot.forEach(doc => {
            tickets.push({ id: doc.id, ...doc.data() });
        });

        res.json({ success: true, data: tickets });
    } catch (error) {
        console.error('Error fetching Director pending tickets:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch pending tickets' });
    }
});

// ============================================
// PUT /api/it-tickets/it-review/:id
// IT checks store availability and processes ticket
// ============================================
router.put('/it-review/:id', verifyToken, async (req, res) => {
    try {
        if (req.user.role !== 'it') {
            return res.status(403).json({ success: false, error: 'Only IT team can review tickets' });
        }

        const { id } = req.params;
        const { availability, itNotes, quotationUrl, quotationFileName, estimatedCost, vendor } = req.body;
        // availability: 'in_store' or 'need_purchase'

        if (!availability || !['in_store', 'need_purchase'].includes(availability)) {
            return res.status(400).json({ success: false, error: 'Availability must be in_store or need_purchase' });
        }

        const ticketRef = db.collection('it_tickets').doc(id);
        const ticketDoc = await ticketRef.get();
        if (!ticketDoc.exists) {
            return res.status(404).json({ success: false, error: 'Ticket not found' });
        }

        const updateData = {
            availability,
            itReviewedBy: req.user.uid,
            itReviewedByName: req.user.name,
            itReviewedAt: admin.firestore.FieldValue.serverTimestamp(),
            itNotes: itNotes || null,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        // Attach quotation(s) if provided (for purchase requests)
        if (quotationUrl) updateData.quotationUrl = quotationUrl;
        if (quotationFileName) updateData.quotationFileName = quotationFileName;
        if (req.body.quotations) updateData.quotations = req.body.quotations;
        if (estimatedCost) updateData.itEstimatedCost = parseFloat(estimatedCost);
        if (vendor) updateData.itVendor = vendor;

        if (availability === 'in_store') {
            updateData.status = 'available_in_store';
        } else {
            updateData.status = 'pending_hr';
        }

        await ticketRef.update(updateData);

        const updated = await ticketRef.get();
        res.json({
            success: true,
            data: { id: updated.id, ...updated.data() },
            message: availability === 'in_store'
                ? 'Item marked as available in store'
                : 'Ticket sent to HR for cost approval'
        });
    } catch (error) {
        console.error('Error in IT review:', error);
        res.status(500).json({ success: false, error: 'Failed to process IT review' });
    }
});

// ============================================
// PUT /api/it-tickets/it-issue/:id
// IT marks item as issued from store
// ============================================
router.put('/it-issue/:id', verifyToken, async (req, res) => {
    try {
        if (req.user.role !== 'it') {
            return res.status(403).json({ success: false, error: 'Only IT team can issue items' });
        }

        const { id } = req.params;
        const { resolution } = req.body;

        const ticketRef = db.collection('it_tickets').doc(id);
        const ticketDoc = await ticketRef.get();
        if (!ticketDoc.exists) {
            return res.status(404).json({ success: false, error: 'Ticket not found' });
        }

        await ticketRef.update({
            status: 'issued',
            resolution: resolution || 'Item issued from store',
            resolvedAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        const updated = await ticketRef.get();
        res.json({ success: true, data: { id: updated.id, ...updated.data() }, message: 'Item issued successfully' });
    } catch (error) {
        console.error('Error issuing item:', error);
        res.status(500).json({ success: false, error: 'Failed to issue item' });
    }
});

// ============================================
// PUT /api/it-tickets/hr-review/:id
// HR adds cost details and sends to COO
// ============================================
router.put('/hr-review/:id', verifyToken, async (req, res) => {
    try {
        if (req.user.role !== 'hr') {
            return res.status(403).json({ success: false, error: 'Only HR can add cost details' });
        }

        const { id } = req.params;
        const { estimatedCost, currency, vendor, hrNotes } = req.body;

        if (!estimatedCost) {
            return res.status(400).json({ success: false, error: 'Estimated cost is required' });
        }

        const ticketRef = db.collection('it_tickets').doc(id);
        const ticketDoc = await ticketRef.get();
        if (!ticketDoc.exists) {
            return res.status(404).json({ success: false, error: 'Ticket not found' });
        }

        await ticketRef.update({
            status: 'pending_coo',
            estimatedCost: parseFloat(estimatedCost),
            currency: currency || 'USD',
            vendor: vendor || null,
            hrReviewedBy: req.user.uid,
            hrReviewedByName: req.user.name,
            hrReviewedAt: admin.firestore.FieldValue.serverTimestamp(),
            hrNotes: hrNotes || null,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        const updated = await ticketRef.get();
        res.json({
            success: true,
            data: { id: updated.id, ...updated.data() },
            message: 'Cost details added, sent to COO for approval'
        });
    } catch (error) {
        console.error('Error in HR review:', error);
        res.status(500).json({ success: false, error: 'Failed to process HR review' });
    }
});

// ============================================
// PUT /api/it-tickets/coo-approve/:id
// COO approves/rejects and sends to Director
// ============================================
router.put('/coo-approve/:id', verifyToken, async (req, res) => {
    try {
        if (req.user.role !== 'coo') {
            return res.status(403).json({ success: false, error: 'Only COO can approve at this stage' });
        }

        const { id } = req.params;
        const { decision, cooNotes } = req.body;

        if (!decision || !['approved', 'rejected'].includes(decision)) {
            return res.status(400).json({ success: false, error: 'Decision must be approved or rejected' });
        }

        const ticketRef = db.collection('it_tickets').doc(id);
        const ticketDoc = await ticketRef.get();
        if (!ticketDoc.exists) {
            return res.status(404).json({ success: false, error: 'Ticket not found' });
        }

        const updateData = {
            cooDecision: decision,
            cooApprovedBy: req.user.uid,
            cooApprovedByName: req.user.name,
            cooApprovedAt: admin.firestore.FieldValue.serverTimestamp(),
            cooNotes: cooNotes || null,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        if (decision === 'approved') {
            updateData.status = 'pending_director';
        } else {
            updateData.status = 'rejected';
            updateData.rejectedAt = admin.firestore.FieldValue.serverTimestamp();
            updateData.rejectedBy = 'coo';
        }

        await ticketRef.update(updateData);

        const updated = await ticketRef.get();
        res.json({
            success: true,
            data: { id: updated.id, ...updated.data() },
            message: decision === 'approved' ? 'Approved by COO, sent to Director' : 'Rejected by COO'
        });
    } catch (error) {
        console.error('Error in COO approval:', error);
        res.status(500).json({ success: false, error: 'Failed to process COO approval' });
    }
});

// ============================================
// PUT /api/it-tickets/director-approve/:id
// Director final approval/rejection
// ============================================
router.put('/director-approve/:id', verifyToken, async (req, res) => {
    try {
        if (req.user.role !== 'director') {
            return res.status(403).json({ success: false, error: 'Only Director can give final approval' });
        }

        const { id } = req.params;
        const { decision, directorNotes } = req.body;

        if (!decision || !['approved', 'rejected'].includes(decision)) {
            return res.status(400).json({ success: false, error: 'Decision must be approved or rejected' });
        }

        const ticketRef = db.collection('it_tickets').doc(id);
        const ticketDoc = await ticketRef.get();
        if (!ticketDoc.exists) {
            return res.status(404).json({ success: false, error: 'Ticket not found' });
        }

        const updateData = {
            directorDecision: decision,
            directorApprovedBy: req.user.uid,
            directorApprovedByName: req.user.name,
            directorApprovedAt: admin.firestore.FieldValue.serverTimestamp(),
            directorNotes: directorNotes || null,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        if (decision === 'approved') {
            updateData.status = 'approved';
        } else {
            updateData.status = 'rejected';
            updateData.rejectedAt = admin.firestore.FieldValue.serverTimestamp();
            updateData.rejectedBy = 'director';
        }

        await ticketRef.update(updateData);

        const updated = await ticketRef.get();
        res.json({
            success: true,
            data: { id: updated.id, ...updated.data() },
            message: decision === 'approved' ? 'Final approval granted by Director' : 'Rejected by Director'
        });
    } catch (error) {
        console.error('Error in Director approval:', error);
        res.status(500).json({ success: false, error: 'Failed to process Director approval' });
    }
});

// ============================================
// PUT /api/it-tickets/update/:id
// ============================================
// POST /api/it-tickets/stock-purchase
// IT team creates a stock purchase request with quotation
// Same approval flow: IT → HR → COO → Director
// ============================================
router.post('/stock-purchase', verifyToken, async (req, res) => {
    try {
        if (req.user.role !== 'it') {
            return res.status(403).json({ success: false, error: 'Only IT team can create stock purchase requests' });
        }

        const { category, item, quantity, subject, description, vendor,
                estimatedCost, currency, quotationUrl, quotationFileName, quotations } = req.body;

        if (!item || !subject || !description) {
            return res.status(400).json({
                success: false,
                error: 'Item, subject, and description are required'
            });
        }

        const ticketData = {
            ticketNumber: `ITS-${Date.now().toString(36).toUpperCase()}`,
            ticketType: 'stock_purchase',
            category: category || 'hardware',
            categoryLabel: IT_CATEGORIES[category]?.label || 'Stock Purchase',
            item,
            quantity: parseInt(quantity) || 1,
            priority: 'medium',
            subject,
            description,

            // IT is the requester for stock purchases
            requestedByUid: req.user.uid,
            requestedByName: req.user.name,
            requestedByEmail: req.user.email,
            requestedByRole: 'it',

            // IT has already reviewed (since IT is creating it)
            availability: 'need_purchase',
            itReviewedBy: req.user.uid,
            itReviewedByName: req.user.name,
            itReviewedAt: admin.firestore.FieldValue.serverTimestamp(),
            itNotes: 'Stock purchase request by IT department',
            itEstimatedCost: estimatedCost ? parseFloat(estimatedCost) : null,
            itVendor: vendor || null,

            // Quotation
            quotationUrl: quotationUrl || null,
            quotationFileName: quotationFileName || null,
            quotations: quotations || [],

            // Goes directly to HR
            status: 'pending_hr',

            // HR Cost Approval
            hrReviewedBy: null, hrReviewedByName: null, hrReviewedAt: null,
            hrNotes: null, estimatedCost: estimatedCost ? parseFloat(estimatedCost) : null,
            currency: currency || 'USD', vendor: vendor || null,

            // COO / Director Approval
            cooApprovedBy: null, cooApprovedByName: null, cooApprovedAt: null,
            cooNotes: null, cooDecision: null,
            directorApprovedBy: null, directorApprovedByName: null, directorApprovedAt: null,
            directorNotes: null, directorDecision: null,

            resolution: null, resolvedAt: null,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        const docRef = await db.collection('it_tickets').add(ticketData);

        res.json({
            success: true,
            data: { id: docRef.id, ...ticketData },
            message: `Stock purchase request ${ticketData.ticketNumber} created and sent to HR`
        });
    } catch (error) {
        console.error('Error creating stock purchase request:', error);
        res.status(500).json({ success: false, error: 'Failed to create stock purchase request' });
    }
});

// ============================================
// PUT /api/it-tickets/update/:id
// General update (IT team manages status, resolve, close)
// ============================================
router.put('/update/:id', verifyToken, async (req, res) => {
    try {
        const allowedRoles = ['it', 'coo', 'director'];
        if (!allowedRoles.includes(req.user.role)) {
            return res.status(403).json({ success: false, error: 'Insufficient permissions' });
        }

        const { id } = req.params;
        const { status, resolution, notes } = req.body;

        const ticketRef = db.collection('it_tickets').doc(id);
        const ticketDoc = await ticketRef.get();
        if (!ticketDoc.exists) {
            return res.status(404).json({ success: false, error: 'Ticket not found' });
        }

        const updateData = {
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedByUid: req.user.uid,
            updatedByName: req.user.name
        };

        if (status) updateData.status = status;
        if (resolution) updateData.resolution = resolution;
        if (notes) updateData.notes = notes;

        if (status === 'closed' || status === 'resolved' || status === 'delivered') {
            updateData.resolvedAt = admin.firestore.FieldValue.serverTimestamp();
        }

        await ticketRef.update(updateData);

        const updated = await ticketRef.get();
        res.json({ success: true, data: { id: updated.id, ...updated.data() }, message: 'Ticket updated successfully' });
    } catch (error) {
        console.error('Error updating IT ticket:', error);
        res.status(500).json({ success: false, error: 'Failed to update ticket' });
    }
});

// ============================================
// GET /api/it-tickets/dashboard
// IT dashboard statistics
// ============================================
router.get('/dashboard', verifyToken, async (req, res) => {
    try {
        const allowedRoles = ['it', 'hr', 'coo', 'director'];
        if (!allowedRoles.includes(req.user.role)) {
            return res.status(403).json({ success: false, error: 'Insufficient permissions' });
        }

        const snapshot = await db.collection('it_tickets').get();
        const tickets = [];
        snapshot.forEach(doc => {
            tickets.push({ id: doc.id, ...doc.data() });
        });

        const totalTickets = tickets.length;
        const openTickets = tickets.filter(t => t.status === 'open').length;
        const inProgressTickets = tickets.filter(t => t.status === 'in_progress').length;
        const closedTickets = tickets.filter(t => ['closed', 'resolved', 'issued', 'delivered'].includes(t.status)).length;
        const onHoldTickets = tickets.filter(t => t.status === 'on_hold').length;
        const pendingHR = tickets.filter(t => t.status === 'pending_hr').length;
        const pendingCOO = tickets.filter(t => t.status === 'pending_coo').length;
        const pendingDirector = tickets.filter(t => t.status === 'pending_director').length;
        const approvedTickets = tickets.filter(t => t.status === 'approved').length;
        const rejectedTickets = tickets.filter(t => t.status === 'rejected').length;
        const availableInStore = tickets.filter(t => t.status === 'available_in_store').length;
        const needPurchase = tickets.filter(t => t.availability === 'need_purchase').length;
        const stockPurchaseRequests = tickets.filter(t => t.ticketType === 'stock_purchase').length;

        // Priority breakdown (active only)
        const activeStatuses = ['open', 'in_progress', 'pending_hr', 'pending_coo', 'pending_director', 'available_in_store'];
        const highPriority = tickets.filter(t => t.priority === 'high' && activeStatuses.includes(t.status)).length;
        const mediumPriority = tickets.filter(t => t.priority === 'medium' && activeStatuses.includes(t.status)).length;
        const lowPriority = tickets.filter(t => t.priority === 'low' && activeStatuses.includes(t.status)).length;
        const criticalPriority = tickets.filter(t => t.priority === 'critical' && activeStatuses.includes(t.status)).length;

        // Category breakdown
        const categoryStats = {};
        tickets.forEach(t => {
            if (!categoryStats[t.category]) {
                categoryStats[t.category] = { total: 0, open: 0, closed: 0, label: t.categoryLabel || t.category };
            }
            categoryStats[t.category].total++;
            if (['closed', 'resolved', 'issued', 'delivered'].includes(t.status)) {
                categoryStats[t.category].closed++;
            } else {
                categoryStats[t.category].open++;
            }
        });

        // Monthly stats (last 6 months)
        const monthlyStats = [];
        const now = new Date();
        for (let i = 5; i >= 0; i--) {
            const monthDate = new Date(now.getFullYear(), now.getMonth() - i, 1);
            const monthEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59);
            const monthName = monthDate.toLocaleString('default', { month: 'short', year: 'numeric' });

            const monthCreated = tickets.filter(t => {
                const created = t.createdAt?.toDate ? t.createdAt.toDate() : new Date(t.createdAt);
                return created >= monthDate && created <= monthEnd;
            }).length;

            const monthClosed = tickets.filter(t => {
                if (!t.resolvedAt) return false;
                const resolved = t.resolvedAt?.toDate ? t.resolvedAt.toDate() : new Date(t.resolvedAt);
                return resolved >= monthDate && resolved <= monthEnd;
            }).length;

            monthlyStats.push({ month: monthName, created: monthCreated, closed: monthClosed });
        }

        // Avg resolution time
        const closedWithTime = tickets.filter(t =>
            ['closed', 'resolved', 'issued', 'delivered'].includes(t.status) && t.resolvedAt && t.createdAt
        );
        let avgResolutionHours = 0;
        if (closedWithTime.length > 0) {
            const totalHours = closedWithTime.reduce((sum, t) => {
                const created = t.createdAt?.toDate ? t.createdAt.toDate() : new Date(t.createdAt);
                const resolved = t.resolvedAt?.toDate ? t.resolvedAt.toDate() : new Date(t.resolvedAt);
                return sum + (resolved - created) / (1000 * 60 * 60);
            }, 0);
            avgResolutionHours = Math.round(totalHours / closedWithTime.length);
        }

        // Total procurement cost (approved)
        const totalProcurementCost = tickets
            .filter(t => t.estimatedCost && ['approved', 'delivered', 'closed'].includes(t.status))
            .reduce((sum, t) => sum + (parseFloat(t.estimatedCost) || 0), 0);

        // Recent tickets
        const recentTickets = tickets
            .sort((a, b) => {
                const dateA = a.createdAt?.toDate ? a.createdAt.toDate() : new Date(a.createdAt);
                const dateB = b.createdAt?.toDate ? b.createdAt.toDate() : new Date(b.createdAt);
                return dateB - dateA;
            })
            .slice(0, 15);

        res.json({
            success: true,
            data: {
                summary: {
                    totalTickets, openTickets, inProgressTickets, closedTickets, onHoldTickets,
                    pendingHR, pendingCOO, pendingDirector, approvedTickets, rejectedTickets,
                    availableInStore, needPurchase, stockPurchaseRequests, avgResolutionHours, totalProcurementCost
                },
                priority: { critical: criticalPriority, high: highPriority, medium: mediumPriority, low: lowPriority },
                categoryStats,
                monthlyStats,
                recentTickets
            }
        });
    } catch (error) {
        console.error('Error fetching IT dashboard:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch dashboard data' });
    }
});

// ============================================
// PUT /api/it-tickets/user-edit/:id
// User can edit their own ticket ONLY if status is 'open' (before IT reviews)
// ============================================
router.put('/user-edit/:id', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const ticketRef = db.collection('it_tickets').doc(id);
        const ticketDoc = await ticketRef.get();
        if (!ticketDoc.exists) {
            return res.status(404).json({ success: false, error: 'Ticket not found' });
        }

        const ticket = ticketDoc.data();

        // Only owner can edit
        if (ticket.requestedByUid !== req.user.uid && req.user.role !== 'it') {
            return res.status(403).json({ success: false, error: 'You can only edit your own tickets' });
        }

        // Only editable when status is 'open'
        if (ticket.status !== 'open') {
            return res.status(400).json({ success: false, error: 'Ticket can only be edited before IT review' });
        }

        const { category, item, quantity, priority, subject, description } = req.body;
        const updateData = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };

        if (category) { updateData.category = category; updateData.categoryLabel = IT_CATEGORIES[category]?.label || category; }
        if (item) updateData.item = item;
        if (quantity) updateData.quantity = parseInt(quantity);
        if (priority) updateData.priority = priority;
        if (subject) updateData.subject = subject;
        if (description) updateData.description = description;

        await ticketRef.update(updateData);
        const updated = await ticketRef.get();
        res.json({ success: true, data: { id: updated.id, ...updated.data() }, message: 'Ticket updated' });
    } catch (error) {
        console.error('Error editing ticket:', error);
        res.status(500).json({ success: false, error: 'Failed to edit ticket' });
    }
});

// ============================================
// DELETE /api/it-tickets/user-delete/:id
// User can delete their own ticket ONLY if status is 'open'
// ============================================
router.delete('/user-delete/:id', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const ticketRef = db.collection('it_tickets').doc(id);
        const ticketDoc = await ticketRef.get();
        if (!ticketDoc.exists) {
            return res.status(404).json({ success: false, error: 'Ticket not found' });
        }

        const ticket = ticketDoc.data();

        if (ticket.requestedByUid !== req.user.uid && req.user.role !== 'it') {
            return res.status(403).json({ success: false, error: 'You can only delete your own tickets' });
        }

        if (ticket.status !== 'open') {
            return res.status(400).json({ success: false, error: 'Ticket can only be deleted before IT review' });
        }

        await ticketRef.delete();
        res.json({ success: true, message: 'Ticket deleted successfully' });
    } catch (error) {
        console.error('Error deleting ticket:', error);
        res.status(500).json({ success: false, error: 'Failed to delete ticket' });
    }
});

// ============================================
// DELETE /api/it-tickets/:id
// IT team or Director can delete any ticket
// ============================================
router.delete('/:id', verifyToken, async (req, res) => {
    try {
        if (req.user.role !== 'it' && req.user.role !== 'director') {
            return res.status(403).json({ success: false, error: 'Insufficient permissions' });
        }

        const { id } = req.params;
        const ticketRef = db.collection('it_tickets').doc(id);
        const ticketDoc = await ticketRef.get();
        if (!ticketDoc.exists) {
            return res.status(404).json({ success: false, error: 'Ticket not found' });
        }

        await ticketRef.delete();
        res.json({ success: true, message: 'Ticket deleted successfully' });
    } catch (error) {
        console.error('Error deleting IT ticket:', error);
        res.status(500).json({ success: false, error: 'Failed to delete ticket' });
    }
});

module.exports = router;
