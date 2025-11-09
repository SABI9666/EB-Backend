// api/invoices.js - Invoice management with email notifications
const express = require('express');
const router = express.Router();
const admin = require('./_firebase-admin');
const { sendEmailNotification } = require('./email'); // Import email function

const db = admin.firestore();

// Simple auth check function (inline)
async function checkAuth(req, res, next) {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }
        const token = authHeader.split('Bearer ')[1];
        const decodedToken = await admin.auth().verifyIdToken(token);
        req.user = { uid: decodedToken.uid, email: decodedToken.email };
        
        // Get user details from Firestore
        const userDoc = await db.collection('users').doc(decodedToken.uid).get();
        if (userDoc.exists) {
            const userData = userDoc.data();
            req.user.name = userData.name || userData.email;
            req.user.role = userData.role;
        }
        
        next();
    } catch (error) {
        res.status(401).json({ success: false, error: 'Invalid token' });
    }
}

// Get all invoices
router.get('/', checkAuth, async (req, res) => {
    try {
        const { status, projectId, overdue } = req.query;
        let query = db.collection('invoices');
        
        // Filter by status if provided
        if (status) {
            query = query.where('status', '==', status);
        }
        
        // Filter by project if provided
        if (projectId) {
            query = query.where('projectId', '==', projectId);
        }
        
        // Filter overdue invoices
        if (overdue === 'true') {
            const today = new Date();
            query = query.where('dueDate', '<', today).where('status', '!=', 'paid');
        }
        
        const invoicesSnapshot = await query.get();
        const invoices = [];
        
        for (const doc of invoicesSnapshot.docs) {
            const invoiceData = doc.data();
            
            // Enhance with project details if available
            if (invoiceData.projectId) {
                const projectDoc = await db.collection('projects').doc(invoiceData.projectId).get();
                if (projectDoc.exists) {
                    const projectData = projectDoc.data();
                    invoiceData.projectName = projectData.projectName;
                    invoiceData.projectCode = projectData.projectCode;
                    invoiceData.clientCompany = projectData.clientCompany;
                    invoiceData.bdmEmail = projectData.bdmEmail;
                }
            }
            
            // Calculate overdue days if applicable
            if (invoiceData.dueDate && invoiceData.status !== 'paid') {
                const dueDate = invoiceData.dueDate.toDate ? invoiceData.dueDate.toDate() : new Date(invoiceData.dueDate);
                const today = new Date();
                const diffTime = today - dueDate;
                const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
                
                if (diffDays > 0) {
                    invoiceData.daysOverdue = diffDays;
                    invoiceData.isOverdue = true;
                } else {
                    invoiceData.daysUntilDue = Math.abs(diffDays);
                    invoiceData.isOverdue = false;
                }
            }
            
            invoices.push({
                id: doc.id,
                ...invoiceData
            });
        }
        
        res.json({ success: true, data: invoices });
    } catch (error) {
        console.error('Error fetching invoices:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get single invoice
router.get('/:id', checkAuth, async (req, res) => {
    try {
        const doc = await db.collection('invoices').doc(req.params.id).get();
        if (!doc.exists) {
            return res.status(404).json({ success: false, error: 'Invoice not found' });
        }
        
        const invoiceData = doc.data();
        
        // Enhance with project details
        if (invoiceData.projectId) {
            const projectDoc = await db.collection('projects').doc(invoiceData.projectId).get();
            if (projectDoc.exists) {
                const projectData = projectDoc.data();
                invoiceData.projectName = projectData.projectName;
                invoiceData.projectCode = projectData.projectCode;
                invoiceData.clientCompany = projectData.clientCompany;
                invoiceData.clientContact = projectData.clientContact;
                invoiceData.bdmEmail = projectData.bdmEmail;
            }
        }
        
        res.json({ success: true, data: { id: doc.id, ...invoiceData } });
    } catch (error) {
        console.error('Error fetching invoice:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Create invoice with email notification
router.post('/', checkAuth, async (req, res) => {
    try {
        const {
            projectId,
            invoiceNumber,
            invoiceAmount,
            dueDate,
            paymentTerms,
            description,
            items,
            clientDetails,
            notes
        } = req.body;
        
        // Validation
        if (!invoiceNumber || !invoiceAmount || !dueDate) {
            return res.status(400).json({ 
                success: false, 
                error: 'Invoice number, amount, and due date are required' 
            });
        }
        
        let projectData = {};
        let bdmEmail = null;
        
        // Get project details if projectId provided
        if (projectId) {
            const projectDoc = await db.collection('projects').doc(projectId).get();
            if (projectDoc.exists) {
                projectData = projectDoc.data();
                
                // Get BDM email
                if (projectData.bdmUid) {
                    const bdmDoc = await db.collection('users').doc(projectData.bdmUid).get();
                    if (bdmDoc.exists) {
                        bdmEmail = bdmDoc.data().email;
                    }
                }
            }
        }
        
        const invoiceData = {
            invoiceNumber,
            invoiceAmount: Number(invoiceAmount),
            dueDate: admin.firestore.Timestamp.fromDate(new Date(dueDate)),
            paymentTerms: paymentTerms || 'Net 30',
            description: description || '',
            items: items || [],
            clientDetails: clientDetails || {
                company: projectData.clientCompany || '',
                contact: projectData.clientContact || '',
                email: projectData.clientEmail || '',
                phone: projectData.clientPhone || '',
                address: projectData.clientAddress || ''
            },
            projectId: projectId || null,
            projectName: projectData.projectName || null,
            projectCode: projectData.projectCode || null,
            clientCompany: projectData.clientCompany || clientDetails?.company || '',
            notes: notes || '',
            status: 'pending', // pending, sent, paid, overdue
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            createdBy: req.user.uid,
            createdByName: req.user.name || req.user.email,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };
        
        const docRef = await db.collection('invoices').add(invoiceData);
        
        // Log activity
        await db.collection('activities').add({
            type: 'invoice_created',
            details: `Invoice ${invoiceNumber} created for ${invoiceData.clientCompany}`,
            performedByName: req.user.name || req.user.email,
            performedByRole: req.user.role || 'accounts',
            performedByUid: req.user.uid,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            projectId: projectId || null,
            invoiceId: docRef.id
        });
        
        // Create notifications for COO, Director, and BDM
        const notificationRoles = ['coo', 'director'];
        const notificationPromises = [];
        
        for (const role of notificationRoles) {
            const roleUsersSnapshot = await db.collection('users').where('role', '==', role).get();
            roleUsersSnapshot.forEach(userDoc => {
                notificationPromises.push(
                    db.collection('notifications').add({
                        type: 'invoice_created',
                        recipientUid: userDoc.id,
                        recipientRole: role,
                        message: `New invoice ${invoiceNumber} created for ${invoiceData.clientCompany} - Amount: $${invoiceAmount}`,
                        invoiceId: docRef.id,
                        projectId: projectId || null,
                        priority: 'high',
                        createdAt: admin.firestore.FieldValue.serverTimestamp(),
                        isRead: false
                    })
                );
            });
        }
        
        // Notify BDM if available
        if (projectData.bdmUid) {
            notificationPromises.push(
                db.collection('notifications').add({
                    type: 'invoice_created',
                    recipientUid: projectData.bdmUid,
                    recipientRole: 'bdm',
                    message: `New invoice ${invoiceNumber} created for your project ${projectData.projectName} - Amount: $${invoiceAmount}`,
                    invoiceId: docRef.id,
                    projectId: projectId,
                    priority: 'high',
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    isRead: false
                })
            );
        }
        
        await Promise.all(notificationPromises);
        
        // SEND EMAIL NOTIFICATION for invoice creation
        const emailData = {
            invoiceId: docRef.id,
            invoiceNumber: invoiceNumber,
            invoiceAmount: invoiceAmount,
            dueDate: dueDate,
            paymentTerms: paymentTerms || 'Net 30',
            projectId: projectId,
            projectName: projectData.projectName || 'N/A',
            projectCode: projectData.projectCode || 'N/A',
            clientCompany: invoiceData.clientCompany,
            createdBy: req.user.name || req.user.email,
            bdmEmail: bdmEmail
        };
        
        await sendEmailNotification('invoice.created', emailData);
        
        res.json({ 
            success: true, 
            data: { id: docRef.id },
            message: 'Invoice created successfully and notifications sent'
        });
    } catch (error) {
        console.error('Error creating invoice:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Update invoice (e.g., mark as paid, send reminders)
router.put('/:id', checkAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const { status, sendReminder } = req.body;
        
        const invoiceRef = db.collection('invoices').doc(id);
        const invoiceDoc = await invoiceRef.get();
        
        if (!invoiceDoc.exists) {
            return res.status(404).json({ success: false, error: 'Invoice not found' });
        }
        
        const invoiceData = invoiceDoc.data();
        const updates = {
            ...req.body,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedBy: req.user.uid
        };
        
        // Remove sendReminder from updates as it's just a trigger
        delete updates.sendReminder;
        
        // Update invoice
        await invoiceRef.update(updates);
        
        // If marking as paid
        if (status === 'paid') {
            await db.collection('activities').add({
                type: 'invoice_paid',
                details: `Invoice ${invoiceData.invoiceNumber} marked as paid`,
                performedByName: req.user.name || req.user.email,
                performedByRole: req.user.role,
                performedByUid: req.user.uid,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                invoiceId: id,
                projectId: invoiceData.projectId || null
            });
        }
        
        // Send payment reminder if requested
        if (sendReminder) {
            const projectData = {};
            let bdmEmail = null;
            
            if (invoiceData.projectId) {
                const projectDoc = await db.collection('projects').doc(invoiceData.projectId).get();
                if (projectDoc.exists) {
                    Object.assign(projectData, projectDoc.data());
                    
                    // Get BDM email
                    if (projectData.bdmUid) {
                        const bdmDoc = await db.collection('users').doc(projectData.bdmUid).get();
                        if (bdmDoc.exists) {
                            bdmEmail = bdmDoc.data().email;
                        }
                    }
                }
            }
            
            // Calculate days until due or overdue
            const dueDate = invoiceData.dueDate.toDate ? invoiceData.dueDate.toDate() : new Date(invoiceData.dueDate);
            const today = new Date();
            const diffTime = dueDate - today;
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
            
            let emailEvent = 'invoice.payment_due';
            let daysInfo = { daysUntilDue: diffDays };
            
            if (diffDays < 0) {
                emailEvent = 'invoice.overdue';
                daysInfo = { daysOverdue: Math.abs(diffDays) };
            }
            
            // Send email reminder
            const emailData = {
                invoiceId: id,
                invoiceNumber: invoiceData.invoiceNumber,
                invoiceAmount: invoiceData.invoiceAmount,
                dueDate: dueDate,
                projectId: invoiceData.projectId,
                projectName: projectData.projectName || invoiceData.projectName || 'N/A',
                clientCompany: invoiceData.clientCompany || invoiceData.clientDetails?.company || 'N/A',
                contactPerson: invoiceData.clientDetails?.contact || projectData.clientContact || 'N/A',
                contactEmail: invoiceData.clientDetails?.email || projectData.clientEmail || 'N/A',
                contactPhone: invoiceData.clientDetails?.phone || projectData.clientPhone || 'N/A',
                bdmEmail: bdmEmail,
                ...daysInfo
            };
            
            await sendEmailNotification(emailEvent, emailData);
            
            // Log reminder activity
            await db.collection('activities').add({
                type: 'payment_reminder_sent',
                details: `Payment reminder sent for invoice ${invoiceData.invoiceNumber}`,
                performedByName: req.user.name || req.user.email,
                performedByRole: req.user.role,
                performedByUid: req.user.uid,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                invoiceId: id,
                projectId: invoiceData.projectId || null
            });
        }
        
        res.json({ 
            success: true, 
            message: sendReminder ? 'Invoice updated and reminder sent' : 'Invoice updated successfully'
        });
    } catch (error) {
        console.error('Error updating invoice:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Delete invoice
router.delete('/:id', checkAuth, async (req, res) => {
    try {
        const { id } = req.params;
        
        // Check permissions (only accounts, COO, or Director can delete)
        if (!['accounts', 'coo', 'director'].includes(req.user.role)) {
            return res.status(403).json({ success: false, error: 'Permission denied' });
        }
        
        const invoiceRef = db.collection('invoices').doc(id);
        const invoiceDoc = await invoiceRef.get();
        
        if (!invoiceDoc.exists) {
            return res.status(404).json({ success: false, error: 'Invoice not found' });
        }
        
        const invoiceData = invoiceDoc.data();
        
        // Don't delete paid invoices
        if (invoiceData.status === 'paid') {
            return res.status(400).json({ 
                success: false, 
                error: 'Cannot delete paid invoices' 
            });
        }
        
        await invoiceRef.delete();
        
        // Log deletion
        await db.collection('activities').add({
            type: 'invoice_deleted',
            details: `Invoice ${invoiceData.invoiceNumber} deleted`,
            performedByName: req.user.name || req.user.email,
            performedByRole: req.user.role,
            performedByUid: req.user.uid,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            projectId: invoiceData.projectId || null
        });
        
        res.json({ success: true, message: 'Invoice deleted successfully' });
    } catch (error) {
        console.error('Error deleting invoice:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Bulk send payment reminders for due/overdue invoices
router.post('/send-reminders', checkAuth, async (req, res) => {
    try {
        // Check permissions
        if (!['accounts', 'coo', 'director'].includes(req.user.role)) {
            return res.status(403).json({ success: false, error: 'Permission denied' });
        }
        
        const today = new Date();
        const reminderThreshold = new Date();
        reminderThreshold.setDate(reminderThreshold.getDate() + 7); // Remind 7 days before due
        
        // Get invoices that are due soon or overdue
        const invoicesSnapshot = await db.collection('invoices')
            .where('status', '!=', 'paid')
            .get();
        
        const reminders = [];
        
        for (const doc of invoicesSnapshot.docs) {
            const invoiceData = doc.data();
            const dueDate = invoiceData.dueDate.toDate ? invoiceData.dueDate.toDate() : new Date(invoiceData.dueDate);
            
            // Send reminder if due within 7 days or overdue
            if (dueDate <= reminderThreshold) {
                const projectData = {};
                let bdmEmail = null;
                
                if (invoiceData.projectId) {
                    const projectDoc = await db.collection('projects').doc(invoiceData.projectId).get();
                    if (projectDoc.exists) {
                        Object.assign(projectData, projectDoc.data());
                        
                        // Get BDM email
                        if (projectData.bdmUid) {
                            const bdmDoc = await db.collection('users').doc(projectData.bdmUid).get();
                            if (bdmDoc.exists) {
                                bdmEmail = bdmDoc.data().email;
                            }
                        }
                    }
                }
                
                const diffTime = dueDate - today;
                const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
                
                let emailEvent = 'invoice.payment_due';
                let daysInfo = { daysUntilDue: diffDays };
                
                if (diffDays < 0) {
                    emailEvent = 'invoice.overdue';
                    daysInfo = { daysOverdue: Math.abs(diffDays) };
                }
                
                const emailData = {
                    invoiceId: doc.id,
                    invoiceNumber: invoiceData.invoiceNumber,
                    invoiceAmount: invoiceData.invoiceAmount,
                    dueDate: dueDate,
                    projectId: invoiceData.projectId,
                    projectName: projectData.projectName || invoiceData.projectName || 'N/A',
                    clientCompany: invoiceData.clientCompany || invoiceData.clientDetails?.company || 'N/A',
                    contactPerson: invoiceData.clientDetails?.contact || projectData.clientContact || 'N/A',
                    contactEmail: invoiceData.clientDetails?.email || projectData.clientEmail || 'N/A',
                    contactPhone: invoiceData.clientDetails?.phone || projectData.clientPhone || 'N/A',
                    bdmEmail: bdmEmail,
                    ...daysInfo
                };
                
                await sendEmailNotification(emailEvent, emailData);
                
                reminders.push({
                    invoiceNumber: invoiceData.invoiceNumber,
                    clientCompany: invoiceData.clientCompany,
                    status: diffDays < 0 ? 'overdue' : 'due_soon',
                    ...daysInfo
                });
            }
        }
        
        // Log bulk reminder activity
        if (reminders.length > 0) {
            await db.collection('activities').add({
                type: 'bulk_payment_reminders_sent',
                details: `Sent ${reminders.length} payment reminders`,
                performedByName: req.user.name || req.user.email,
                performedByRole: req.user.role,
                performedByUid: req.user.uid,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
        }
        
        res.json({ 
            success: true, 
            message: `${reminders.length} payment reminders sent`,
            reminders: reminders
        });
    } catch (error) {
        console.error('Error sending bulk reminders:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
