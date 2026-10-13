// api/subventors.js - Subventor Management API (Add, P.O. Upload, Payment Status)
const express = require('express');
const router = express.Router();
const admin = require('./_firebase-admin');
const { verifyToken } = require('../middleware/auth');

const db = admin.firestore();

// Fields Accounts may correct after a subvendor is entered.
const EDITABLE_FIELDS = [
    'vendorName', 'vendorCompany', 'vendorEmail', 'vendorPhone',
    'vendorGST', 'vendorPAN', 'vendorAddress', 'vendorBankDetails',
    'projectId', 'projectName', 'projectCode', 'clientCompany',
    'poNumber', 'poDate', 'poAmount', 'poCurrency', 'poDescription',
    'paymentTerms', 'scopeOfWork', 'remarks'
];

async function uploadPoFile(poFileBase64, poFileName) {
    const bucket = admin.storage().bucket();
    const filePath = `subventor-po/${Date.now()}_${poFileName}`;
    const file = bucket.file(filePath);
    await file.save(Buffer.from(poFileBase64, 'base64'), { metadata: { contentType: 'application/pdf' } });
    await file.makePublic();
    return `https://storage.googleapis.com/${bucket.name}/${filePath}`;
}

// Paid / balance / status always follow the P.O. amount and the payment history.
function paymentTotals(poAmount, history, currentStatus) {
    const totalPaid = history.reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
    const balanceDue = Math.max(0, (poAmount || 0) - totalPaid);
    let paymentStatus = totalPaid <= 0 ? 'pending' : (poAmount > 0 && totalPaid >= poAmount ? 'paid' : 'partial');
    if (currentStatus === 'on_hold') paymentStatus = 'on_hold';
    const dates = history.map(p => p.paymentDate).filter(Boolean).sort();
    return { totalPaid, balanceDue, paymentStatus, lastPaymentDate: dates[dates.length - 1] || null };
}

function logActivity(req, type, details) {
    return db.collection('activities').add({
        type, details,
        performedByName: req.user.name,
        performedByRole: req.user.role,
        performedByUid: req.user.uid,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
}

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
        const poFileUrl = poFileBase64 && poFileName ? await uploadPoFile(poFileBase64, poFileName) : '';

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
            if (poFileBase64 && poFileName) poFileUrl = await uploadPoFile(poFileBase64, poFileName);

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

        } else if (action === 'edit_payment' || action === 'delete_payment') {
            // Correct or remove one recorded payment. recordedAt guards against editing a shifted entry.
            const { index, recordedAt, amount, paymentDate, paymentMethod, referenceNo, notes } = data || {};
            if (action === 'edit_payment' && !(parseFloat(amount) > 0)) {
                return res.status(400).json({ success: false, error: 'Valid payment amount is required' });
            }
            let current;
            await db.runTransaction(async tx => {
                const snap = await tx.get(subventorRef);
                current = snap.data();
                const history = [...(current.paymentHistory || [])];
                const entry = history[index];
                if (!Number.isInteger(index) || !entry || (entry.recordedAt || '') !== (recordedAt || '')) {
                    const err = new Error('This payment has changed since you opened it. Please reload and try again.');
                    err.status = 409; throw err;
                }
                if (action === 'delete_payment') history.splice(index, 1);
                else history[index] = {
                    ...entry,
                    amount: parseFloat(amount),
                    paymentDate: paymentDate || entry.paymentDate,
                    paymentMethod: paymentMethod ?? entry.paymentMethod ?? '',
                    referenceNo: referenceNo ?? entry.referenceNo ?? '',
                    notes: notes ?? entry.notes ?? '',
                    editedBy: req.user.name,
                    editedAt: new Date().toISOString()
                };
                tx.update(subventorRef, {
                    paymentHistory: history,
                    ...paymentTotals(current.poAmount || 0, history, current.paymentStatus),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
            });
            await logActivity(req, action === 'delete_payment' ? 'subventor_payment_deleted' : 'subventor_payment_edited',
                `Payment ${action === 'delete_payment' ? 'removed' : 'edited'} for "${current.vendorCompany}"`);
            return res.status(200).json({ success: true, message: action === 'delete_payment' ? 'Payment removed' : 'Payment updated' });

        } else {
            // Edit any entered detail (vendor, project, P.O.); optionally replace the P.O. file.
            const input = action === 'edit_details' ? (data || {}) : req.body;
            const updates = {};
            for (const field of EDITABLE_FIELDS) {
                if (input[field] === undefined) continue;
                updates[field] = typeof input[field] === 'string' ? input[field].trim() : input[field];
            }
            if (updates.poAmount !== undefined) {
                updates.poAmount = parseFloat(updates.poAmount || 0);
                if (!Number.isFinite(updates.poAmount) || updates.poAmount < 0) {
                    return res.status(400).json({ success: false, error: 'P.O. amount must be zero or more' });
                }
            }
            if (updates.poCurrency !== undefined) updates.poCurrency = String(updates.poCurrency || 'INR').toUpperCase();
            if (updates.vendorName === '' || updates.vendorCompany === '') {
                return res.status(400).json({ success: false, error: 'Vendor name and company are required' });
            }
            if (input.poFileBase64 && input.poFileName) {
                updates.poFileUrl = await uploadPoFile(input.poFileBase64, input.poFileName);
                updates.poFileName = input.poFileName;
            }
            let before;
            await db.runTransaction(async tx => {
                const snap = await tx.get(subventorRef);
                before = snap.data();
                const poAmount = updates.poAmount !== undefined ? updates.poAmount : (before.poAmount || 0);
                tx.update(subventorRef, {
                    ...updates,
                    ...paymentTotals(poAmount, before.paymentHistory || [], before.paymentStatus),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                    lastEditedBy: req.user.name,
                    lastEditedAt: new Date().toISOString()
                });
            });
            const changed = Object.keys(updates).filter(k => String(updates[k]) !== String(before[k] ?? ''));
            await logActivity(req, 'subventor_edited',
                `Subvendor "${updates.vendorCompany || before.vendorCompany}" edited${changed.length ? ': ' + changed.join(', ') : ''}`);
            return res.status(200).json({ success: true, message: 'Subvendor updated successfully' });
        }
    } catch (error) {
        console.error('Subventor PUT error:', error);
        return res.status(error.status || 500).json({ success: false, error: error.message });
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
