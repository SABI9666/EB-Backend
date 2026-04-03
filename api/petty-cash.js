// api/petty-cash.js - Petty Cash Fund Management API
const express = require('express');
const router = express.Router();
const admin = require('./_firebase-admin');
const { verifyToken } = require('../middleware/auth');

const db = admin.firestore();

// GET /api/petty-cash - List petty cash entries with optional filters
router.get('/', verifyToken, async (req, res) => {
    try {
        if (!['accounts', 'coo', 'director'].includes(req.user.role)) {
            return res.status(403).json({ success: false, error: 'Permission denied' });
        }

        const { month, year, type } = req.query;

        const snapshot = await db.collection('pettyCash').orderBy('entryDate', 'desc').get();
        let entries = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        if (month && year) {
            entries = entries.filter(e => {
                const d = e.entryDate ? new Date(e.entryDate) : null;
                return d && (d.getMonth() + 1) === parseInt(month) && d.getFullYear() === parseInt(year);
            });
        } else if (year) {
            entries = entries.filter(e => {
                const d = e.entryDate ? new Date(e.entryDate) : null;
                return d && d.getFullYear() === parseInt(year);
            });
        }

        if (type) {
            entries = entries.filter(e => e.entryType === type);
        }

        // Get fund info
        const fundDoc = await db.collection('pettyCashFund').doc('current').get();
        const fund = fundDoc.exists ? fundDoc.data() : { totalFund: 0, currentBalance: 0, totalSpent: 0 };

        return res.status(200).json({ success: true, data: entries, fund });
    } catch (error) {
        console.error('Petty Cash GET error:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/petty-cash - Add petty cash entry (expense or replenish)
router.post('/', verifyToken, async (req, res) => {
    try {
        if (!['accounts', 'coo', 'director'].includes(req.user.role)) {
            return res.status(403).json({ success: false, error: 'Permission denied' });
        }

        const {
            entryType, entryDate, amount, category, description,
            paidTo, voucherNo, approvedBy, remarks,
            receiptBase64, receiptFileName
        } = req.body;

        if (!entryType || !entryDate || !amount) {
            return res.status(400).json({ success: false, error: 'Entry type, date, and amount are required' });
        }

        // Upload receipt if provided
        let receiptUrl = '';
        if (receiptBase64 && receiptFileName) {
            const bucket = admin.storage().bucket();
            const fileBuffer = Buffer.from(receiptBase64, 'base64');
            const filePath = `petty-cash-receipts/${Date.now()}_${receiptFileName}`;
            const file = bucket.file(filePath);
            await file.save(fileBuffer, { metadata: { contentType: 'application/pdf' } });
            await file.makePublic();
            receiptUrl = `https://storage.googleapis.com/${bucket.name}/${filePath}`;
        }

        const entryData = {
            entryType, // 'expense' or 'replenish'
            entryDate,
            amount: parseFloat(amount) || 0,
            category: category || '',
            description: description || '',
            paidTo: paidTo || '',
            voucherNo: voucherNo || '',
            approvedBy: approvedBy || '',
            remarks: remarks || '',
            receiptUrl,
            receiptFileName: receiptFileName || '',
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            createdBy: req.user.name,
            createdByUid: req.user.uid
        };

        const docRef = await db.collection('pettyCash').add(entryData);

        // Update fund balance
        const fundRef = db.collection('pettyCashFund').doc('current');
        const fundDoc = await fundRef.get();
        const parsedAmount = parseFloat(amount) || 0;

        if (fundDoc.exists) {
            if (entryType === 'expense') {
                await fundRef.update({
                    currentBalance: admin.firestore.FieldValue.increment(-parsedAmount),
                    totalSpent: admin.firestore.FieldValue.increment(parsedAmount),
                    lastUpdated: admin.firestore.FieldValue.serverTimestamp()
                });
            } else {
                await fundRef.update({
                    currentBalance: admin.firestore.FieldValue.increment(parsedAmount),
                    totalFund: admin.firestore.FieldValue.increment(parsedAmount),
                    lastUpdated: admin.firestore.FieldValue.serverTimestamp()
                });
            }
        } else {
            await fundRef.set({
                totalFund: entryType === 'replenish' ? parsedAmount : 0,
                currentBalance: entryType === 'replenish' ? parsedAmount : -parsedAmount,
                totalSpent: entryType === 'expense' ? parsedAmount : 0,
                lastUpdated: admin.firestore.FieldValue.serverTimestamp()
            });
        }

        // Log activity
        await db.collection('activities').add({
            type: entryType === 'expense' ? 'petty_cash_expense' : 'petty_cash_replenish',
            details: entryType === 'expense'
                ? `Petty cash expense: INR ${parsedAmount.toLocaleString()} - ${category}: ${description || 'N/A'}`
                : `Petty cash replenished: INR ${parsedAmount.toLocaleString()}`,
            performedByName: req.user.name,
            performedByRole: req.user.role,
            performedByUid: req.user.uid,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });

        // Notify COO and Director for expenses
        const notifyRoles = ['coo', 'director'];
        for (const role of notifyRoles) {
            if (req.user.role === role) continue;
            const roleSnapshot = await db.collection('users').where('role', '==', role).where('status', '==', 'active').get();
            roleSnapshot.forEach(userDoc => {
                db.collection('notifications').add({
                    type: entryType === 'expense' ? 'petty_cash_expense' : 'petty_cash_replenish',
                    recipientRole: role,
                    recipientUid: userDoc.id,
                    message: entryType === 'expense'
                        ? `Petty Cash: INR ${parsedAmount.toLocaleString()} spent on ${category || 'N/A'}`
                        : `Petty Cash replenished: INR ${parsedAmount.toLocaleString()}`,
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    isRead: false
                });
            });
        }

        return res.status(201).json({
            success: true,
            data: { id: docRef.id, ...entryData },
            message: entryType === 'expense' ? 'Expense recorded' : 'Fund replenished'
        });
    } catch (error) {
        console.error('Petty Cash POST error:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

// DELETE /api/petty-cash/:id
router.delete('/:id', verifyToken, async (req, res) => {
    try {
        if (!['accounts', 'director'].includes(req.user.role)) {
            return res.status(403).json({ success: false, error: 'Permission denied' });
        }

        const entryRef = db.collection('pettyCash').doc(req.params.id);
        const entryDoc = await entryRef.get();
        if (!entryDoc.exists) {
            return res.status(404).json({ success: false, error: 'Entry not found' });
        }

        const entry = entryDoc.data();
        const parsedAmount = parseFloat(entry.amount) || 0;

        // Reverse the fund balance
        const fundRef = db.collection('pettyCashFund').doc('current');
        if (entry.entryType === 'expense') {
            await fundRef.update({
                currentBalance: admin.firestore.FieldValue.increment(parsedAmount),
                totalSpent: admin.firestore.FieldValue.increment(-parsedAmount),
                lastUpdated: admin.firestore.FieldValue.serverTimestamp()
            });
        } else {
            await fundRef.update({
                currentBalance: admin.firestore.FieldValue.increment(-parsedAmount),
                totalFund: admin.firestore.FieldValue.increment(-parsedAmount),
                lastUpdated: admin.firestore.FieldValue.serverTimestamp()
            });
        }

        await entryRef.delete();

        return res.status(200).json({ success: true, message: 'Entry deleted' });
    } catch (error) {
        console.error('Petty Cash DELETE error:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
