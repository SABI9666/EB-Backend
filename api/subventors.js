// api/subventors.js - Subventor Management API (Add, P.O. Upload, Payment Status)
const express = require('express');
const router = express.Router();
const admin = require('./_firebase-admin');
const { verifyToken } = require('../middleware/auth');

const db = admin.firestore();

// GET /api/subventors - List all subventors (with optional filters)
router.get('/', verifyToken, async (req, res) => {
    try {
        if (!['accounts', 'coo', 'director'].includes(req.user.role)) {
            return res.status(403).json({ success: false, error: 'Permission denied' });
        }

        const { projectId, paymentStatus } = req.query;
        let query = db.collection('subventors').orderBy('createdAt', 'desc');

        if (projectId) {
            query = db.collection('subventors').where('projectId', '==', projectId).orderBy('createdAt', 'desc');
        }

        const snapshot = await query.get();
        let subventors = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        if (paymentStatus) {
            subventors = subventors.filter(s => s.paymentStatus === paymentStatus);
        }

        return res.status(200).json({ success: true, data: subventors });
    } catch (error) {
        console.error('Subventors GET error:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

// GET /api/subventors/:id - Get single subventor
router.get('/:id', verifyToken, async (req, res) => {
    try {
        if (!['accounts', 'coo', 'director'].includes(req.user.role)) {
            return res.status(403).json({ success: false, error: 'Permission denied' });
        }

        const doc = await db.collection('subventors').doc(req.params.id).get();
        if (!doc.exists) {
            return res.status(404).json({ success: false, error: 'Subventor not found' });
        }

        return res.status(200).json({ success: true, data: { id: doc.id, ...doc.data() } });
    } catch (error) {
        console.error('Subventor GET by ID error:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/subventors - Add new subventor
router.post('/', verifyToken, async (req, res) => {
    try {
        if (!['accounts', 'coo', 'director'].includes(req.user.role)) {
            return res.status(403).json({ success: false, error: 'Only Accounts, COO, or Director can add subventors' });
        }

        const {
            vendorName, vendorCompany, vendorEmail, vendorPhone,
            vendorGST, vendorPAN, vendorAddress, vendorBankDetails,
            projectId, projectName, projectCode, clientCompany,
            poNumber, poDate, poAmount, poCurrency, poDescription,
            poFileBase64, poFileName,
            paymentTerms, scopeOfWork, remarks
        } = req.body;

        if (!vendorName || !vendorCompany) {
            return res.status(400).json({ success: false, error: 'Vendor name and company are required' });
        }

        // Upload P.O. file if provided
        let poFileUrl = '';
        if (poFileBase64 && poFileName) {
            const bucket = admin.storage().bucket();
            const fileBuffer = Buffer.from(poFileBase64, 'base64');
            const filePath = `subventor-po/${Date.now()}_${poFileName}`;
            const file = bucket.file(filePath);
            await file.save(fileBuffer, {
                metadata: { contentType: 'application/pdf' }
            });
            await file.makePublic();
            poFileUrl = `https://storage.googleapis.com/${bucket.name}/${filePath}`;
        }

        const subventorData = {
            vendorName,
            vendorCompany,
            vendorEmail: vendorEmail || '',
            vendorPhone: vendorPhone || '',
            vendorGST: vendorGST || '',
            vendorPAN: vendorPAN || '',
            vendorAddress: vendorAddress || '',
            vendorBankDetails: vendorBankDetails || '',

            projectId: projectId || '',
            projectName: projectName || '',
            projectCode: projectCode || '',
            clientCompany: clientCompany || '',

            poNumber: poNumber || '',
            poDate: poDate || '',
            poAmount: parseFloat(poAmount) || 0,
            poCurrency: poCurrency || 'INR',
            poDescription: poDescription || '',
            poFileUrl,
            poFileName: poFileName || '',

            paymentTerms: paymentTerms || '',
            scopeOfWork: scopeOfWork || '',
            remarks: remarks || '',

            // Payment tracking
            paymentStatus: 'pending', // pending, partial, paid, on_hold
            totalPaid: 0,
            balanceDue: parseFloat(poAmount) || 0,
            paymentHistory: [],

            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            createdBy: req.user.name,
            createdByUid: req.user.uid,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        const docRef = await db.collection('subventors').add(subventorData);

        // Log activity
        await db.collection('activities').add({
            type: 'subventor_added',
            details: `Subventor "${vendorCompany}" added${projectName ? ' for project ' + projectName : ''}${poNumber ? ' - P.O. #' + poNumber : ''}`,
            performedByName: req.user.name,
            performedByRole: req.user.role,
            performedByUid: req.user.uid,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            projectId: projectId || null
        });

        // Notify COO and Director
        const notifyRoles = ['coo', 'director'];
        for (const role of notifyRoles) {
            const roleSnapshot = await db.collection('users').where('role', '==', role).where('status', '==', 'active').get();
            roleSnapshot.forEach(userDoc => {
                db.collection('notifications').add({
                    type: 'subventor_added',
                    recipientRole: role,
                    recipientUid: userDoc.id,
                    message: `New subventor "${vendorCompany}" added${poNumber ? ' with P.O. #' + poNumber : ''} - Amount: ${poCurrency || 'INR'} ${parseFloat(poAmount || 0).toLocaleString()}`,
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    isRead: false
                });
            });
        }

        return res.status(201).json({
            success: true,
            data: { id: docRef.id, ...subventorData },
            message: 'Subventor added successfully'
        });
    } catch (error) {
        console.error('Subventor POST error:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

// PUT /api/subventors/:id - Update subventor details
router.put('/:id', verifyToken, async (req, res) => {
    try {
        if (!['accounts', 'coo', 'director'].includes(req.user.role)) {
            return res.status(403).json({ success: false, error: 'Permission denied' });
        }

        const subventorRef = db.collection('subventors').doc(req.params.id);
        const subventorDoc = await subventorRef.get();
        if (!subventorDoc.exists) {
            return res.status(404).json({ success: false, error: 'Subventor not found' });
        }

        const { action, data } = req.body;

        if (action === 'upload_po') {
            // Upload / re-upload P.O. file
            const { poFileBase64, poFileName, poNumber, poDate, poAmount, poCurrency, poDescription } = data || {};

            let poFileUrl = subventorDoc.data().poFileUrl || '';
            if (poFileBase64 && poFileName) {
                const bucket = admin.storage().bucket();
                const fileBuffer = Buffer.from(poFileBase64, 'base64');
                const filePath = `subventor-po/${Date.now()}_${poFileName}`;
                const file = bucket.file(filePath);
                await file.save(fileBuffer, { metadata: { contentType: 'application/pdf' } });
                await file.makePublic();
                poFileUrl = `https://storage.googleapis.com/${bucket.name}/${filePath}`;
            }

            const updates = {
                poFileUrl,
                poFileName: poFileName || subventorDoc.data().poFileName,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            };
            if (poNumber) updates.poNumber = poNumber;
            if (poDate) updates.poDate = poDate;
            if (poAmount !== undefined) {
                updates.poAmount = parseFloat(poAmount) || 0;
                updates.balanceDue = (parseFloat(poAmount) || 0) - (subventorDoc.data().totalPaid || 0);
            }
            if (poCurrency) updates.poCurrency = poCurrency;
            if (poDescription) updates.poDescription = poDescription;

            await subventorRef.update(updates);

            await db.collection('activities').add({
                type: 'subventor_po_uploaded',
                details: `P.O. uploaded for subventor "${subventorDoc.data().vendorCompany}"${poNumber ? ' - P.O. #' + poNumber : ''}`,
                performedByName: req.user.name,
                performedByRole: req.user.role,
                performedByUid: req.user.uid,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });

            return res.status(200).json({ success: true, message: 'P.O. uploaded successfully' });

        } else if (action === 'record_payment') {
            // Record a payment against this subventor
            const { amount, paymentDate, paymentMethod, referenceNo, notes } = data || {};

            if (!amount || parseFloat(amount) <= 0) {
                return res.status(400).json({ success: false, error: 'Valid payment amount is required' });
            }

            const current = subventorDoc.data();
            const paymentAmount = parseFloat(amount);
            const newTotalPaid = (current.totalPaid || 0) + paymentAmount;
            const poTotal = current.poAmount || 0;
            const newBalance = Math.max(0, poTotal - newTotalPaid);

            let newStatus = 'partial';
            if (newTotalPaid >= poTotal && poTotal > 0) {
                newStatus = 'paid';
            } else if (newTotalPaid === 0) {
                newStatus = 'pending';
            }

            const paymentEntry = {
                amount: paymentAmount,
                paymentDate: paymentDate || new Date().toISOString(),
                paymentMethod: paymentMethod || '',
                referenceNo: referenceNo || '',
                notes: notes || '',
                recordedBy: req.user.name,
                recordedAt: new Date().toISOString()
            };

            await subventorRef.update({
                totalPaid: newTotalPaid,
                balanceDue: newBalance,
                paymentStatus: newStatus,
                paymentHistory: admin.firestore.FieldValue.arrayUnion(paymentEntry),
                lastPaymentDate: paymentDate || new Date().toISOString(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });

            await db.collection('activities').add({
                type: 'subventor_payment_recorded',
                details: `Payment of ${current.poCurrency || 'INR'} ${paymentAmount.toLocaleString()} recorded for "${current.vendorCompany}"`,
                performedByName: req.user.name,
                performedByRole: req.user.role,
                performedByUid: req.user.uid,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });

            // Notify COO and Director
            const notifyRoles = ['coo', 'director'];
            for (const role of notifyRoles) {
                const roleSnapshot = await db.collection('users').where('role', '==', role).where('status', '==', 'active').get();
                roleSnapshot.forEach(userDoc => {
                    db.collection('notifications').add({
                        type: 'subventor_payment',
                        recipientRole: role,
                        recipientUid: userDoc.id,
                        message: `Payment of ${current.poCurrency || 'INR'} ${paymentAmount.toLocaleString()} made to "${current.vendorCompany}" - Balance: ${current.poCurrency || 'INR'} ${newBalance.toLocaleString()}`,
                        createdAt: admin.firestore.FieldValue.serverTimestamp(),
                        isRead: false
                    });
                });
            }

            return res.status(200).json({ success: true, message: 'Payment recorded successfully' });

        } else if (action === 'update_status') {
            // Update payment status directly (on_hold, etc.)
            const { paymentStatus, remarks } = data || {};
            const updates = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
            if (paymentStatus) updates.paymentStatus = paymentStatus;
            if (remarks !== undefined) updates.remarks = remarks;

            await subventorRef.update(updates);
            return res.status(200).json({ success: true, message: 'Status updated successfully' });

        } else {
            // General update
            const allowedFields = [
                'vendorName', 'vendorCompany', 'vendorEmail', 'vendorPhone',
                'vendorGST', 'vendorPAN', 'vendorAddress', 'vendorBankDetails',
                'projectId', 'projectName', 'projectCode', 'clientCompany',
                'paymentTerms', 'scopeOfWork', 'remarks'
            ];
            const updates = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
            for (const field of allowedFields) {
                if (req.body[field] !== undefined) {
                    updates[field] = req.body[field];
                }
            }

            await subventorRef.update(updates);
            return res.status(200).json({ success: true, message: 'Subventor updated successfully' });
        }
    } catch (error) {
        console.error('Subventor PUT error:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

// DELETE /api/subventors/:id
router.delete('/:id', verifyToken, async (req, res) => {
    try {
        if (!['accounts', 'coo', 'director'].includes(req.user.role)) {
            return res.status(403).json({ success: false, error: 'Permission denied' });
        }

        const subventorRef = db.collection('subventors').doc(req.params.id);
        const subventorDoc = await subventorRef.get();
        if (!subventorDoc.exists) {
            return res.status(404).json({ success: false, error: 'Subventor not found' });
        }

        const subventor = subventorDoc.data();
        if (subventor.paymentStatus === 'paid' || (subventor.totalPaid || 0) > 0) {
            return res.status(400).json({ success: false, error: 'Cannot delete subventor with recorded payments' });
        }

        await subventorRef.delete();

        await db.collection('activities').add({
            type: 'subventor_deleted',
            details: `Subventor "${subventor.vendorCompany}" deleted`,
            performedByName: req.user.name,
            performedByRole: req.user.role,
            performedByUid: req.user.uid,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });

        return res.status(200).json({ success: true, message: 'Subventor deleted successfully' });
    } catch (error) {
        console.error('Subventor DELETE error:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
