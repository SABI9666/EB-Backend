// api/gst-filing.js - GST Filing Status Tracking API
const express = require('express');
const router = express.Router();
const admin = require('./_firebase-admin');
const { verifyToken } = require('../middleware/auth');

const db = admin.firestore();

// GET /api/gst-filing - List GST filing records
router.get('/', verifyToken, async (req, res) => {
    try {
        if (!['accounts', 'coo', 'director'].includes(req.user.role)) {
            return res.status(403).json({ success: false, error: 'Permission denied' });
        }

        const { year, status } = req.query;

        const snapshot = await db.collection('gstFiling').orderBy('year', 'desc').get();
        let records = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        if (year) {
            records = records.filter(r => r.year === parseInt(year));
        }

        if (status) {
            records = records.filter(r => r.filingStatus === status);
        }

        return res.status(200).json({ success: true, data: records });
    } catch (error) {
        console.error('GST Filing GET error:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/gst-filing - Add/Update GST filing record for a month
router.post('/', verifyToken, async (req, res) => {
    try {
        if (!['accounts', 'coo', 'director'].includes(req.user.role)) {
            return res.status(403).json({ success: false, error: 'Only Accounts, COO, or Director can manage GST filing' });
        }

        const {
            month, year, filingStatus, filingType,
            filingDate, returnType, taxableAmount, cgstAmount,
            sgstAmount, igstAmount, totalTaxAmount, gstinNumber,
            acknowledgementNo, filingPeriod, remarks,
            documentBase64, documentFileName
        } = req.body;

        if (!month || !year) {
            return res.status(400).json({ success: false, error: 'Month and year are required' });
        }

        // Check if record already exists for this month/year
        const existingQuery = await db.collection('gstFiling')
            .where('month', '==', parseInt(month))
            .where('year', '==', parseInt(year))
            .get();

        // Upload document if provided
        let documentUrl = '';
        if (documentBase64 && documentFileName) {
            const bucket = admin.storage().bucket();
            const fileBuffer = Buffer.from(documentBase64, 'base64');
            const filePath = `gst-documents/${year}_${month}_${Date.now()}_${documentFileName}`;
            const file = bucket.file(filePath);
            await file.save(fileBuffer, { metadata: { contentType: 'application/pdf' } });
            await file.makePublic();
            documentUrl = `https://storage.googleapis.com/${bucket.name}/${filePath}`;
        }

        const monthNames = ['', 'January', 'February', 'March', 'April', 'May', 'June',
            'July', 'August', 'September', 'October', 'November', 'December'];

        const gstData = {
            month: parseInt(month),
            monthName: monthNames[parseInt(month)] || '',
            year: parseInt(year),
            filingStatus: filingStatus || 'not_filed', // not_filed, filed, filed_late, pending_review
            filingType: filingType || 'GSTR-3B',
            filingDate: filingDate || '',
            returnType: returnType || 'GSTR-3B',
            taxableAmount: parseFloat(taxableAmount) || 0,
            cgstAmount: parseFloat(cgstAmount) || 0,
            sgstAmount: parseFloat(sgstAmount) || 0,
            igstAmount: parseFloat(igstAmount) || 0,
            totalTaxAmount: parseFloat(totalTaxAmount) || 0,
            gstinNumber: gstinNumber || '',
            acknowledgementNo: acknowledgementNo || '',
            filingPeriod: filingPeriod || `${monthNames[parseInt(month)]} ${year}`,
            remarks: remarks || '',
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedBy: req.user.name,
            updatedByUid: req.user.uid
        };

        if (documentUrl) {
            gstData.documentUrl = documentUrl;
            gstData.documentFileName = documentFileName;
        }

        let docId;
        if (!existingQuery.empty) {
            // Update existing record
            docId = existingQuery.docs[0].id;
            await db.collection('gstFiling').doc(docId).update(gstData);
        } else {
            // Create new record
            gstData.createdAt = admin.firestore.FieldValue.serverTimestamp();
            gstData.createdBy = req.user.name;
            gstData.createdByUid = req.user.uid;
            const docRef = await db.collection('gstFiling').add(gstData);
            docId = docRef.id;
        }

        // Log activity
        await db.collection('activities').add({
            type: 'gst_filing_updated',
            details: `GST filing for ${monthNames[parseInt(month)]} ${year} marked as "${filingStatus || 'not_filed'}"`,
            performedByName: req.user.name,
            performedByRole: req.user.role,
            performedByUid: req.user.uid,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });

        // Notify COO and Director
        if (filingStatus === 'filed') {
            const notifyRoles = ['coo', 'director'];
            for (const role of notifyRoles) {
                const roleSnapshot = await db.collection('users').where('role', '==', role).where('status', '==', 'active').get();
                roleSnapshot.forEach(userDoc => {
                    db.collection('notifications').add({
                        type: 'gst_filed',
                        recipientRole: role,
                        recipientUid: userDoc.id,
                        message: `GST (${filingType || 'GSTR-3B'}) filed for ${monthNames[parseInt(month)]} ${year} - Tax: INR ${(parseFloat(totalTaxAmount) || 0).toLocaleString()}`,
                        createdAt: admin.firestore.FieldValue.serverTimestamp(),
                        isRead: false
                    });
                });
            }
        }

        return res.status(existingQuery.empty ? 201 : 200).json({
            success: true,
            data: { id: docId, ...gstData },
            message: existingQuery.empty ? 'GST filing record created' : 'GST filing record updated'
        });
    } catch (error) {
        console.error('GST Filing POST error:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

// DELETE /api/gst-filing/:id
router.delete('/:id', verifyToken, async (req, res) => {
    try {
        if (!['accounts', 'director'].includes(req.user.role)) {
            return res.status(403).json({ success: false, error: 'Only Accounts or Director can delete GST records' });
        }

        const gstRef = db.collection('gstFiling').doc(req.params.id);
        const gstDoc = await gstRef.get();
        if (!gstDoc.exists) {
            return res.status(404).json({ success: false, error: 'GST record not found' });
        }

        await gstRef.delete();

        return res.status(200).json({ success: true, message: 'GST filing record deleted' });
    } catch (error) {
        console.error('GST Filing DELETE error:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
