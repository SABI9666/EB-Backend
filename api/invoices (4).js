// api/invoices.js - Simplified version without auth middleware
const express = require('express');
const router = express.Router();
const admin = require('./_firebase-admin');

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
        next();
    } catch (error) {
        res.status(401).json({ success: false, error: 'Invalid token' });
    }
}

// Get all invoices
router.get('/', checkAuth, async (req, res) => {
    try {
        const invoicesSnapshot = await db.collection('invoices').get();
        const invoices = invoicesSnapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));
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
        res.json({ success: true, data: { id: doc.id, ...doc.data() } });
    } catch (error) {
        console.error('Error fetching invoice:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Create invoice
router.post('/', checkAuth, async (req, res) => {
    try {
        const invoiceData = {
            ...req.body,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            createdBy: req.user.uid
        };
        const docRef = await db.collection('invoices').add(invoiceData);
        res.json({ success: true, data: { id: docRef.id } });
    } catch (error) {
        console.error('Error creating invoice:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
