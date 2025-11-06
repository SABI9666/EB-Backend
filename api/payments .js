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
                invoiceNo,
                invoiceDate,
                amount,
                paymentDueDate,
                paymentTerms,
                milestoneDescription
            } = req.body;

            // Only accounts team can create payment records
            if (!['accounts', 'coo', 'director'].includes(req.user.role)) {
                return res.status(403).json({ 
                    success: false, 
                    error: 'Only Accounts team can create payment records' 
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

            const paymentData = {
                projectId,
                projectCode: project.projectCode,
                projectName: project.projectName,
                clientCompany: project.clientCompany,
                quoteValue: project.quoteValue,
                currency: project.currency || 'USD',
                
                invoiceNo: invoiceNo || '',
                invoiceDate: invoiceDate || admin.firestore.FieldValue.serverTimestamp(),
                invoiceAmount: amount || 0,
                paymentDueDate: paymentDueDate || null,
                paymentTerms: paymentTerms || project.paymentTerms || '',
                milestoneDescription: milestoneDescription || '',
                
                paymentReceivedDate: null,
                paymentReceivedAmount: 0,
                balanceOutstanding: amount || 0,
                paymentStatus: 'pending', // pending, partially_paid, fully_paid, delayed
                
                invoiceUrl: '',
                paymentProofUrl: '',
                remarks: '',
                
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                createdBy: req.user.name,
                createdByUid: req.user.uid,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            };

            const docRef = await db.collection('payments').add(paymentData);

            // Update project payment status
            await db.collection('projects').doc(projectId).update({
                lastInvoiceDate: invoiceDate || admin.firestore.FieldValue.serverTimestamp(),
                totalInvoiced: admin.firestore.FieldValue.increment(amount || 0),
                paymentStatus: 'invoice_generated',
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });

            // Create activity
            await db.collection('activities').add({
                type: 'invoice_created',
                details: `Invoice ${invoiceNo} generated for ${project.projectName}`,
                performedByName: req.user.name,
                performedByRole: req.user.role,
                performedByUid: req.user.uid,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                projectId: projectId,
                paymentId: docRef.id
            });

            // Send notifications
            const notificationRoles = ['bdm', 'coo', 'director'];
            for (const role of notificationRoles) {
                await db.collection('notifications').add({
                    type: 'invoice_created',
                    recipientRole: role,
                    recipientUid: role === 'bdm' ? project.bdmUid : null,
                    message: `Invoice generated for ${project.projectName} - Amount: ${project.currency} ${amount}`,
                    projectId: projectId,
                    paymentId: docRef.id,
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    isRead: false
                });
            }

            return res.status(201).json({ 
                success: true, 
                data: { id: docRef.id, ...paymentData },
                message: 'Payment record created successfully' 
            });
        }

        if (req.method === 'GET') {
            const { projectId, status, overdue } = req.query;
            
            let query = db.collection('payments').orderBy('createdAt', 'desc');
            
            if (projectId) {
                query = query.where('projectId', '==', projectId);
            }
            
            if (status) {
                query = query.where('paymentStatus', '==', status);
            }
            
            const snapshot = await query.get();
            let payments = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            
            // Filter overdue payments if requested
            if (overdue === 'true') {
                const now = new Date();
                payments = payments.filter(payment => {
                    if (payment.paymentStatus === 'fully_paid') return false;
                    if (!payment.paymentDueDate) return false;
                    
                    const dueDate = payment.paymentDueDate.toDate ? 
                        payment.paymentDueDate.toDate() : 
                        new Date(payment.paymentDueDate);
                    
                    const daysPastDue = Math.floor((now - dueDate) / (1000 * 60 * 60 * 24));
                    return daysPastDue > 15;
                });
            }
            
            return res.status(200).json({ success: true, data: payments });
        }

        if (req.method === 'PUT') {
            const { id } = req.query;
            const { action, data } = req.body;
            
            if (!id || !action) {
                return res.status(400).json({ 
                    success: false, 
                    error: 'Payment ID and action required' 
                });
            }
            
            const paymentRef = db.collection('payments').doc(id);
            const paymentDoc = await paymentRef.get();
            
            if (!paymentDoc.exists) {
                return res.status(404).json({ 
                    success: false, 
                    error: 'Payment record not found' 
                });
            }
            
            const payment = paymentDoc.data();
            let updates = {};
            let activityDetail = '';
            let sendDelayNotification = false;
            
            switch (action) {
                case 'record_payment':
                    const receivedAmount = parseFloat(data.amount) || 0;
                    const previousReceived = payment.paymentReceivedAmount || 0;
                    const totalReceived = previousReceived + receivedAmount;
                    const invoiceAmount = payment.invoiceAmount || 0;
                    
                    updates.paymentReceivedAmount = totalReceived;
                    updates.paymentReceivedDate = data.receivedDate || admin.firestore.FieldValue.serverTimestamp();
                    updates.balanceOutstanding = Math.max(0, invoiceAmount - totalReceived);
                    updates.paymentProofUrl = data.proofUrl || '';
                    
                    if (totalReceived >= invoiceAmount) {
                        updates.paymentStatus = 'fully_paid';
                    } else if (totalReceived > 0) {
                        updates.paymentStatus = 'partially_paid';
                    }
                    
                    activityDetail = `Payment received: ${payment.currency} ${receivedAmount}`;
                    
                    // Send payment received notification
                    const roles = ['bdm', 'coo', 'director'];
                    for (const role of roles) {
                        await db.collection('notifications').add({
                            type: 'payment_received',
                            recipientRole: role,
                            message: `Payment received for ${payment.projectName} - ${payment.currency} ${receivedAmount}`,
                            projectId: payment.projectId,
                            paymentId: id,
                            createdAt: admin.firestore.FieldValue.serverTimestamp(),
                            isRead: false
                        });
                    }
                    break;
                    
                case 'mark_delayed':
                    updates.paymentStatus = 'delayed';
                    updates.remarks = data.remarks || 'Payment delayed';
                    activityDetail = 'Payment marked as delayed';
                    sendDelayNotification = true;
                    break;
                    
                case 'update_invoice':
                    updates.invoiceUrl = data.url || '';
                    updates.invoiceNo = data.invoiceNo || payment.invoiceNo;
                    activityDetail = 'Invoice updated';
                    break;
                    
                default:
                    return res.status(400).json({ 
                        success: false, 
                        error: 'Invalid action' 
                    });
            }
            
            updates.updatedAt = admin.firestore.FieldValue.serverTimestamp();
            await paymentRef.update(updates);
            
            // Update project payment status
            if (updates.paymentStatus) {
                await db.collection('projects').doc(payment.projectId).update({
                    paymentStatus: updates.paymentStatus,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
            }
            
            // Log activity
            await db.collection('activities').add({
                type: `payment_${action}`,
                details: activityDetail,
                performedByName: req.user.name,
                performedByRole: req.user.role,
                performedByUid: req.user.uid,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                projectId: payment.projectId,
                paymentId: id
            });
            
            // Send delay notification if needed
            if (sendDelayNotification) {
                const urgentRoles = ['accounts', 'coo', 'director', 'bdm'];
                for (const role of urgentRoles) {
                    await db.collection('notifications').add({
                        type: 'payment_delayed',
                        recipientRole: role,
                        message: `⚠️ Payment delay for ${payment.projectName}, please follow up with client`,
                        projectId: payment.projectId,
                        paymentId: id,
                        priority: 'high',
                        createdAt: admin.firestore.FieldValue.serverTimestamp(),
                        isRead: false
                    });
                }
            }
            
            return res.status(200).json({ 
                success: true, 
                message: 'Payment record updated successfully' 
            });
        }

        return res.status(405).json({ success: false, error: 'Method not allowed' });
        
    } catch (error) {
        console.error('Payments API error:', error);
        return res.status(500).json({ 
            success: false, 
            error: 'Internal Server Error', 
            message: error.message 
        });
    }
};

// Scheduled function to check for overdue payments (run daily)
async function checkOverduePayments() {
    try {
        const snapshot = await db.collection('payments')
            .where('paymentStatus', 'in', ['pending', 'partially_paid'])
            .get();
        
        const now = new Date();
        const overduePayments = [];
        
        for (const doc of snapshot.docs) {
            const payment = doc.data();
            if (!payment.paymentDueDate) continue;
            
            const dueDate = payment.paymentDueDate.toDate ? 
                payment.paymentDueDate.toDate() : 
                new Date(payment.paymentDueDate);
            
            const daysPastDue = Math.floor((now - dueDate) / (1000 * 60 * 60 * 24));
            
            if (daysPastDue > 15 && payment.paymentStatus !== 'delayed') {
                // Mark as delayed
                await doc.ref.update({
                    paymentStatus: 'delayed',
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
                
                overduePayments.push({
                    id: doc.id,
                    ...payment,
                    daysPastDue
                });
            }
        }
        
        // Send notifications for overdue payments
        for (const payment of overduePayments) {
            const urgentRoles = ['accounts', 'coo', 'director', 'bdm'];
            for (const role of urgentRoles) {
                await db.collection('notifications').add({
                    type: 'payment_overdue',
                    recipientRole: role,
                    message: `⚠️ URGENT: Payment for ${payment.projectName} is ${payment.daysPastDue} days overdue`,
                    projectId: payment.projectId,
                    paymentId: payment.id,
                    priority: 'urgent',
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    isRead: false
                });
            }
        }
        
        return overduePayments.length;
    } catch (error) {
        console.error('Check overdue payments error:', error);
        return 0;
    }
}

module.exports = allowCors(handler);
module.exports.checkOverduePayments = checkOverduePayments;
