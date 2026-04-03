// api/daily-expenses.js - Daily Expenses Management API
const express = require('express');
const router = express.Router();
const admin = require('./_firebase-admin');
const { verifyToken } = require('../middleware/auth');

const db = admin.firestore();

// GET /api/daily-expenses - List expenses with optional filters
router.get('/', verifyToken, async (req, res) => {
    try {
        if (!['accounts', 'coo', 'director'].includes(req.user.role)) {
            return res.status(403).json({ success: false, error: 'Permission denied' });
        }

        const { month, year, category, startDate, endDate } = req.query;

        let query = db.collection('dailyExpenses').orderBy('expenseDate', 'desc');

        const snapshot = await query.get();
        let expenses = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        // Filter by month/year
        if (month && year) {
            expenses = expenses.filter(e => {
                const d = e.expenseDate ? new Date(e.expenseDate) : null;
                return d && (d.getMonth() + 1) === parseInt(month) && d.getFullYear() === parseInt(year);
            });
        } else if (year) {
            expenses = expenses.filter(e => {
                const d = e.expenseDate ? new Date(e.expenseDate) : null;
                return d && d.getFullYear() === parseInt(year);
            });
        }

        // Filter by date range
        if (startDate && endDate) {
            const start = new Date(startDate);
            const end = new Date(endDate);
            expenses = expenses.filter(e => {
                const d = e.expenseDate ? new Date(e.expenseDate) : null;
                return d && d >= start && d <= end;
            });
        }

        // Filter by category
        if (category) {
            expenses = expenses.filter(e => e.category === category);
        }

        // Calculate summary
        const totalAmount = expenses.reduce((sum, e) => sum + (parseFloat(e.amount) || 0), 0);
        const categoryBreakdown = {};
        expenses.forEach(e => {
            const cat = e.category || 'Uncategorized';
            categoryBreakdown[cat] = (categoryBreakdown[cat] || 0) + (parseFloat(e.amount) || 0);
        });

        return res.status(200).json({
            success: true,
            data: expenses,
            summary: { totalAmount, count: expenses.length, categoryBreakdown }
        });
    } catch (error) {
        console.error('Daily Expenses GET error:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/daily-expenses - Add new expense
router.post('/', verifyToken, async (req, res) => {
    try {
        if (!['accounts', 'coo', 'director'].includes(req.user.role)) {
            return res.status(403).json({ success: false, error: 'Only Accounts, COO, or Director can add expenses' });
        }

        const {
            expenseDate, category, description, amount, currency,
            paidTo, paymentMethod, referenceNo, gstApplicable,
            gstAmount, projectId, projectName, receiptBase64, receiptFileName,
            remarks
        } = req.body;

        if (!expenseDate || !amount || !category) {
            return res.status(400).json({ success: false, error: 'Date, amount, and category are required' });
        }

        // Upload receipt if provided
        let receiptUrl = '';
        if (receiptBase64 && receiptFileName) {
            const bucket = admin.storage().bucket();
            const fileBuffer = Buffer.from(receiptBase64, 'base64');
            const filePath = `expense-receipts/${Date.now()}_${receiptFileName}`;
            const file = bucket.file(filePath);
            await file.save(fileBuffer, { metadata: { contentType: 'application/pdf' } });
            await file.makePublic();
            receiptUrl = `https://storage.googleapis.com/${bucket.name}/${filePath}`;
        }

        const expenseData = {
            expenseDate,
            category,
            description: description || '',
            amount: parseFloat(amount) || 0,
            currency: currency || 'INR',
            paidTo: paidTo || '',
            paymentMethod: paymentMethod || 'cash',
            referenceNo: referenceNo || '',
            gstApplicable: gstApplicable || false,
            gstAmount: parseFloat(gstAmount) || 0,
            projectId: projectId || '',
            projectName: projectName || '',
            receiptUrl,
            receiptFileName: receiptFileName || '',
            remarks: remarks || '',
            status: 'recorded', // recorded, approved, rejected
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            createdBy: req.user.name,
            createdByUid: req.user.uid,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        const docRef = await db.collection('dailyExpenses').add(expenseData);

        // Log activity
        await db.collection('activities').add({
            type: 'expense_recorded',
            details: `Daily expense of ${currency || 'INR'} ${parseFloat(amount).toLocaleString()} recorded - ${category}: ${description || 'N/A'}`,
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
                    type: 'expense_recorded',
                    recipientRole: role,
                    recipientUid: userDoc.id,
                    message: `Expense: ${currency || 'INR'} ${parseFloat(amount).toLocaleString()} - ${category}: ${description || 'N/A'}`,
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    isRead: false
                });
            });
        }

        return res.status(201).json({
            success: true,
            data: { id: docRef.id, ...expenseData },
            message: 'Expense recorded successfully'
        });
    } catch (error) {
        console.error('Daily Expenses POST error:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

// PUT /api/daily-expenses/:id - Update expense
router.put('/:id', verifyToken, async (req, res) => {
    try {
        if (!['accounts', 'coo', 'director'].includes(req.user.role)) {
            return res.status(403).json({ success: false, error: 'Permission denied' });
        }

        const expenseRef = db.collection('dailyExpenses').doc(req.params.id);
        const expenseDoc = await expenseRef.get();
        if (!expenseDoc.exists) {
            return res.status(404).json({ success: false, error: 'Expense not found' });
        }

        const { action, data } = req.body;

        if (action === 'approve') {
            await expenseRef.update({
                status: 'approved',
                approvedBy: req.user.name,
                approvedByUid: req.user.uid,
                approvedAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            return res.status(200).json({ success: true, message: 'Expense approved' });
        }

        if (action === 'reject') {
            await expenseRef.update({
                status: 'rejected',
                rejectedBy: req.user.name,
                rejectedByUid: req.user.uid,
                rejectionReason: (data && data.reason) || '',
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            return res.status(200).json({ success: true, message: 'Expense rejected' });
        }

        // General edit
        const allowedFields = [
            'expenseDate', 'category', 'description', 'amount', 'currency',
            'paidTo', 'paymentMethod', 'referenceNo', 'gstApplicable',
            'gstAmount', 'projectId', 'projectName', 'remarks'
        ];
        const updates = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
        for (const field of allowedFields) {
            if (req.body[field] !== undefined) {
                updates[field] = field === 'amount' || field === 'gstAmount'
                    ? parseFloat(req.body[field]) || 0
                    : req.body[field];
            }
        }

        await expenseRef.update(updates);
        return res.status(200).json({ success: true, message: 'Expense updated successfully' });
    } catch (error) {
        console.error('Daily Expenses PUT error:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

// DELETE /api/daily-expenses/:id
router.delete('/:id', verifyToken, async (req, res) => {
    try {
        if (!['accounts', 'coo', 'director'].includes(req.user.role)) {
            return res.status(403).json({ success: false, error: 'Permission denied' });
        }

        const expenseRef = db.collection('dailyExpenses').doc(req.params.id);
        const expenseDoc = await expenseRef.get();
        if (!expenseDoc.exists) {
            return res.status(404).json({ success: false, error: 'Expense not found' });
        }

        const expense = expenseDoc.data();
        if (expense.status === 'approved') {
            return res.status(400).json({ success: false, error: 'Cannot delete approved expenses' });
        }

        await expenseRef.delete();

        await db.collection('activities').add({
            type: 'expense_deleted',
            details: `Expense of ${expense.currency || 'INR'} ${expense.amount} deleted - ${expense.category}`,
            performedByName: req.user.name,
            performedByRole: req.user.role,
            performedByUid: req.user.uid,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });

        return res.status(200).json({ success: true, message: 'Expense deleted successfully' });
    } catch (error) {
        console.error('Daily Expenses DELETE error:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

// GET /api/daily-expenses/summary/monthly - Monthly expense summary
router.get('/summary/monthly', verifyToken, async (req, res) => {
    try {
        if (!['accounts', 'coo', 'director'].includes(req.user.role)) {
            return res.status(403).json({ success: false, error: 'Permission denied' });
        }

        const { year } = req.query;
        const targetYear = parseInt(year) || new Date().getFullYear();

        const snapshot = await db.collection('dailyExpenses').get();
        const expenses = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        const monthlyData = {};
        for (let m = 1; m <= 12; m++) {
            monthlyData[m] = { total: 0, count: 0, categories: {} };
        }

        expenses.forEach(e => {
            const d = e.expenseDate ? new Date(e.expenseDate) : null;
            if (!d || d.getFullYear() !== targetYear) return;
            const month = d.getMonth() + 1;
            const amount = parseFloat(e.amount) || 0;
            monthlyData[month].total += amount;
            monthlyData[month].count++;
            const cat = e.category || 'Uncategorized';
            monthlyData[month].categories[cat] = (monthlyData[month].categories[cat] || 0) + amount;
        });

        return res.status(200).json({ success: true, data: monthlyData, year: targetYear });
    } catch (error) {
        console.error('Monthly Summary error:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
