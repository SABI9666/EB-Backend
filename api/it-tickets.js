// api/it-tickets.js - IT Support Ticket Management System
// Handles IT requests (computer, software, hardware, network, etc.) and IT dashboard
const express = require('express');
const router = express.Router();
const { verifyToken, requireRole } = require('../middleware/auth');
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
// GET /api/it-tickets/categories
// Public categories list for request forms
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
        const { category, item, priority, subject, description, attachmentUrl } = req.body;

        if (!category || !item || !subject || !description) {
            return res.status(400).json({
                success: false,
                error: 'Category, item, subject, and description are required'
            });
        }

        const ticketData = {
            // Ticket info
            ticketNumber: `IT-${Date.now().toString(36).toUpperCase()}`,
            category,
            categoryLabel: IT_CATEGORIES[category]?.label || category,
            item,
            priority: priority || 'medium',
            subject,
            description,
            attachmentUrl: attachmentUrl || null,

            // Requester info
            requestedByUid: req.user.uid,
            requestedByName: req.user.name,
            requestedByEmail: req.user.email,
            requestedByRole: req.user.role,

            // Status tracking
            status: 'open',
            assignedTo: null,
            assignedToName: null,
            resolution: null,
            resolvedAt: null,

            // Timestamps
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
            .orderBy('createdAt', 'desc')
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
// IT team, COO, Director can view all tickets
// ============================================
router.get('/all', verifyToken, async (req, res) => {
    try {
        const allowedRoles = ['it', 'coo', 'director'];
        if (!allowedRoles.includes(req.user.role)) {
            return res.status(403).json({ success: false, error: 'Insufficient permissions' });
        }

        const { status, category, priority, limit: queryLimit } = req.query;

        let query = db.collection('it_tickets').orderBy('createdAt', 'desc');

        if (status) {
            query = query.where('status', '==', status);
        }

        if (queryLimit) {
            query = query.limit(parseInt(queryLimit));
        }

        const snapshot = await query.get();
        let tickets = [];
        snapshot.forEach(doc => {
            tickets.push({ id: doc.id, ...doc.data() });
        });

        // Client-side filtering for additional fields (Firestore limitation on multiple where clauses)
        if (category) {
            tickets = tickets.filter(t => t.category === category);
        }
        if (priority) {
            tickets = tickets.filter(t => t.priority === priority);
        }

        res.json({ success: true, data: tickets });
    } catch (error) {
        console.error('Error fetching all IT tickets:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch tickets' });
    }
});

// ============================================
// PUT /api/it-tickets/update/:id
// IT team can update ticket status, assign, resolve
// ============================================
router.put('/update/:id', verifyToken, async (req, res) => {
    try {
        const allowedRoles = ['it', 'coo', 'director'];
        if (!allowedRoles.includes(req.user.role)) {
            return res.status(403).json({ success: false, error: 'Insufficient permissions' });
        }

        const { id } = req.params;
        const { status, assignedTo, assignedToName, resolution, notes } = req.body;

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
        if (assignedTo !== undefined) updateData.assignedTo = assignedTo;
        if (assignedToName !== undefined) updateData.assignedToName = assignedToName;
        if (resolution) updateData.resolution = resolution;
        if (notes) updateData.notes = notes;

        // Set resolved timestamp when closing
        if (status === 'closed' || status === 'resolved') {
            updateData.resolvedAt = admin.firestore.FieldValue.serverTimestamp();
            updateData.resolvedByUid = req.user.uid;
            updateData.resolvedByName = req.user.name;
        }

        await ticketRef.update(updateData);

        const updated = await ticketRef.get();
        res.json({
            success: true,
            data: { id: updated.id, ...updated.data() },
            message: 'Ticket updated successfully'
        });
    } catch (error) {
        console.error('Error updating IT ticket:', error);
        res.status(500).json({ success: false, error: 'Failed to update ticket' });
    }
});

// ============================================
// GET /api/it-tickets/dashboard
// IT dashboard statistics for IT team, COO, Director
// ============================================
router.get('/dashboard', verifyToken, async (req, res) => {
    try {
        const allowedRoles = ['it', 'coo', 'director'];
        if (!allowedRoles.includes(req.user.role)) {
            return res.status(403).json({ success: false, error: 'Insufficient permissions' });
        }

        // Get all tickets
        const snapshot = await db.collection('it_tickets').get();
        const tickets = [];
        snapshot.forEach(doc => {
            tickets.push({ id: doc.id, ...doc.data() });
        });

        // Basic stats
        const totalTickets = tickets.length;
        const openTickets = tickets.filter(t => t.status === 'open').length;
        const inProgressTickets = tickets.filter(t => t.status === 'in_progress').length;
        const closedTickets = tickets.filter(t => t.status === 'closed' || t.status === 'resolved').length;
        const onHoldTickets = tickets.filter(t => t.status === 'on_hold').length;

        // Priority breakdown
        const highPriority = tickets.filter(t => t.priority === 'high' && t.status !== 'closed' && t.status !== 'resolved').length;
        const mediumPriority = tickets.filter(t => t.priority === 'medium' && t.status !== 'closed' && t.status !== 'resolved').length;
        const lowPriority = tickets.filter(t => t.priority === 'low' && t.status !== 'closed' && t.status !== 'resolved').length;
        const criticalPriority = tickets.filter(t => t.priority === 'critical' && t.status !== 'closed' && t.status !== 'resolved').length;

        // Category breakdown
        const categoryStats = {};
        tickets.forEach(t => {
            if (!categoryStats[t.category]) {
                categoryStats[t.category] = { total: 0, open: 0, closed: 0, label: t.categoryLabel || t.category };
            }
            categoryStats[t.category].total++;
            if (t.status === 'open' || t.status === 'in_progress') {
                categoryStats[t.category].open++;
            } else {
                categoryStats[t.category].closed++;
            }
        });

        // Monthly stats (last 6 months)
        const monthlyStats = [];
        const now = new Date();
        for (let i = 5; i >= 0; i--) {
            const monthDate = new Date(now.getFullYear(), now.getMonth() - i, 1);
            const monthEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59);
            const monthName = monthDate.toLocaleString('default', { month: 'short', year: 'numeric' });

            const monthTickets = tickets.filter(t => {
                const created = t.createdAt?.toDate ? t.createdAt.toDate() : new Date(t.createdAt);
                return created >= monthDate && created <= monthEnd;
            });

            const monthClosed = tickets.filter(t => {
                if (!t.resolvedAt) return false;
                const resolved = t.resolvedAt?.toDate ? t.resolvedAt.toDate() : new Date(t.resolvedAt);
                return resolved >= monthDate && resolved <= monthEnd;
            });

            monthlyStats.push({
                month: monthName,
                created: monthTickets.length,
                closed: monthClosed.length
            });
        }

        // Recent tickets (last 10)
        const recentTickets = tickets
            .sort((a, b) => {
                const dateA = a.createdAt?.toDate ? a.createdAt.toDate() : new Date(a.createdAt);
                const dateB = b.createdAt?.toDate ? b.createdAt.toDate() : new Date(b.createdAt);
                return dateB - dateA;
            })
            .slice(0, 10);

        // Average resolution time (for closed tickets with resolvedAt)
        const closedWithTime = tickets.filter(t =>
            (t.status === 'closed' || t.status === 'resolved') && t.resolvedAt && t.createdAt
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

        res.json({
            success: true,
            data: {
                summary: {
                    totalTickets,
                    openTickets,
                    inProgressTickets,
                    closedTickets,
                    onHoldTickets,
                    avgResolutionHours
                },
                priority: {
                    critical: criticalPriority,
                    high: highPriority,
                    medium: mediumPriority,
                    low: lowPriority
                },
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
// DELETE /api/it-tickets/:id
// IT team can delete tickets
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
