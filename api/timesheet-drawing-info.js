// api/timesheet-drawing-info.js
// Adds an endpoint for designers to attach a drawing number and/or model
// number to their timesheet entries without modifying the main
// api/timesheets.js file.
//
// Exposed routes (mounted at /api/timesheet-drawing-info):
//   PATCH /:id    { drawingNumber?, modelNumber? }
//       Update the drawingNumber / modelNumber on an existing timesheet
//       document. Only the designer who owns the entry can edit it.

const express = require('express');
const util = require('util');
const admin = require('./_firebase-admin');
const { verifyToken } = require('../middleware/auth.js');

const router = express.Router();
const db = admin.firestore();

function sanitize(value) {
    if (value === null || value === undefined) return '';
    return String(value).trim().slice(0, 200);
}

router.patch('/:id', async (req, res) => {
    try {
        await util.promisify(verifyToken)(req, res);
    } catch (error) {
        return res.status(401).json({
            success: false,
            error: 'Authentication failed',
            message: error.message
        });
    }

    try {
        const { id } = req.params;
        const { uid } = req.user;
        const bodyDrawing = req.body && req.body.drawingNumber;
        const bodyModel = req.body && req.body.modelNumber;

        if (!id) {
            return res.status(400).json({ success: false, error: 'Missing timesheet ID.' });
        }
        if (bodyDrawing === undefined && bodyModel === undefined) {
            return res.status(400).json({
                success: false,
                error: 'Provide at least one of: drawingNumber, modelNumber.'
            });
        }

        const docRef = db.collection('timesheets').doc(id);
        const snap = await docRef.get();
        if (!snap.exists) {
            return res.status(404).json({ success: false, error: 'Timesheet entry not found.' });
        }

        const entry = snap.data();
        if (entry.designerUid !== uid) {
            return res.status(403).json({
                success: false,
                error: 'You are not authorized to edit this entry.'
            });
        }

        const update = {
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };
        if (bodyDrawing !== undefined) update.drawingNumber = sanitize(bodyDrawing);
        if (bodyModel !== undefined) update.modelNumber = sanitize(bodyModel);

        await docRef.update(update);

        return res.status(200).json({
            success: true,
            data: {
                id,
                drawingNumber: update.drawingNumber !== undefined ? update.drawingNumber : entry.drawingNumber || '',
                modelNumber: update.modelNumber !== undefined ? update.modelNumber : entry.modelNumber || ''
            }
        });
    } catch (error) {
        console.error('Error in PATCH /timesheet-drawing-info/:id', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
