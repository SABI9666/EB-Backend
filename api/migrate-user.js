// api/migrate-user.js - One-time migration endpoint for re-registered users
// Scans ALL collections and fixes UID references for a given email
const express = require('express');
const router = express.Router();
const admin = require('./_firebase-admin');
const { verifyToken } = require('../middleware/auth');

const db = admin.firestore();

// Allowed emails that can run migrations
const ALLOWED_EMAILS = ['sabin@edanbrook.com', 'director@edanbrook.com', 'ajit@edanbrook.com'];

// GET /api/migrate-user?email=xxx - Scan for orphaned UIDs
router.get('/', verifyToken, async (req, res) => {
    try {
        const callerEmail = (req.user.email || '').toLowerCase();
        if (!ALLOWED_EMAILS.includes(callerEmail)) {
            return res.status(403).json({ success: false, error: 'Not authorized to run migrations' });
        }

        const email = (req.query.email || callerEmail).toLowerCase();

        // Step 1: Find the NEW UID (current Firebase Auth user)
        let newUid = null;
        try {
            const authUser = await admin.auth().getUserByEmail(email);
            newUid = authUser.uid;
        } catch (e) {
            return res.status(400).json({ success: false, error: `No Firebase Auth user found for ${email}` });
        }

        // Step 2: Check Firestore users collection
        const userSnap = await db.collection('users').where('email', '==', email).get();
        const firestoreUids = userSnap.docs.map(d => d.id);

        // Step 3: Find ALL UIDs that created proposals with this email
        const proposalSnap = await db.collection('proposals').where('createdBy', '==', email).get();
        const proposalUids = new Set();
        proposalSnap.docs.forEach(d => {
            const uid = d.data().createdByUid;
            if (uid) proposalUids.add(uid);
        });

        // Step 4: Find UIDs from projects with this email as BDM
        const projectSnap = await db.collection('projects').where('bdmEmail', '==', email).get();
        const projectUids = new Set();
        projectSnap.docs.forEach(d => {
            const uid = d.data().bdmUid;
            if (uid) projectUids.add(uid);
        });

        // Step 5: Collect all old UIDs (any UID that isn't the current auth UID)
        const allFoundUids = new Set([...proposalUids, ...projectUids]);
        const oldUids = [...allFoundUids].filter(uid => uid !== newUid);

        // Count documents per old UID
        const uidDetails = [];
        for (const uid of oldUids) {
            const pCount = await db.collection('proposals').where('createdByUid', '==', uid).get();
            const prCount = await db.collection('projects').where('bdmUid', '==', uid).get();
            const payCount = await db.collection('payments').where('createdByUid', '==', uid).get();
            uidDetails.push({
                uid,
                proposalCount: pCount.size,
                projectCount: prCount.size,
                paymentCount: payCount.size,
                existsInUsers: (await db.collection('users').doc(uid).get()).exists
            });
        }

        return res.status(200).json({
            success: true,
            email,
            currentAuthUid: newUid,
            firestoreUserDocs: firestoreUids,
            proposalsFoundByEmail: proposalSnap.size,
            projectsFoundByEmail: projectSnap.size,
            oldUids: uidDetails,
            message: oldUids.length > 0
                ? `Found ${oldUids.length} old UID(s) with documents. POST to this endpoint to migrate.`
                : 'No old UIDs found. User data may already be correct.'
        });

    } catch (error) {
        console.error('Migration scan error:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/migrate-user - Execute migration
router.post('/', verifyToken, async (req, res) => {
    try {
        const callerEmail = (req.user.email || '').toLowerCase();
        if (!ALLOWED_EMAILS.includes(callerEmail)) {
            return res.status(403).json({ success: false, error: 'Not authorized to run migrations' });
        }

        const email = (req.body.email || callerEmail).toLowerCase();

        // Step 1: Find the NEW UID
        let newUid = null;
        try {
            const authUser = await admin.auth().getUserByEmail(email);
            newUid = authUser.uid;
        } catch (e) {
            return res.status(400).json({ success: false, error: `No Firebase Auth user found for ${email}` });
        }

        // Step 2: Find ALL old UIDs from proposals
        const proposalSnap = await db.collection('proposals').where('createdBy', '==', email).get();
        const oldUids = new Set();
        proposalSnap.docs.forEach(d => {
            const uid = d.data().createdByUid;
            if (uid && uid !== newUid) oldUids.add(uid);
        });

        // Also check projects
        const projectSnap = await db.collection('projects').where('bdmEmail', '==', email).get();
        projectSnap.docs.forEach(d => {
            const uid = d.data().bdmUid;
            if (uid && uid !== newUid) oldUids.add(uid);
        });

        if (oldUids.size === 0) {
            return res.status(200).json({
                success: true,
                message: 'No migration needed. All documents already use the current UID.',
                currentUid: newUid
            });
        }

        const migrationLog = [];
        const BATCH_LIMIT = 400;

        // Process each old UID
        for (const oldUid of oldUids) {
            console.log(`Migrating documents from ${oldUid} -> ${newUid}`);

            // Define all collections and fields to migrate
            const migrations = [
                { collection: 'proposals', field: 'createdByUid', label: 'proposal' },
                { collection: 'projects', field: 'bdmUid', label: 'project (bdm)' },
                { collection: 'projects', field: 'designLeadUid', label: 'project (designLead)' },
                { collection: 'payments', field: 'bdmUid', label: 'payment (bdm)' },
                { collection: 'payments', field: 'createdByUid', label: 'payment (created)' },
                { collection: 'notifications', field: 'recipientUid', label: 'notification' },
                { collection: 'tasks', field: 'designerUid', label: 'task' },
                { collection: 'timesheets', field: 'designerUid', label: 'timesheet' },
                { collection: 'variations', field: 'createdByUid', label: 'variation' },
                { collection: 'activities', field: 'performedByUid', label: 'activity' },
                { collection: 'deliverables', field: 'designerUid', label: 'deliverable' },
                { collection: 'submissions', field: 'submittedByUid', label: 'submission' },
            ];

            for (const mig of migrations) {
                try {
                    const snap = await db.collection(mig.collection)
                        .where(mig.field, '==', oldUid).get();

                    if (snap.empty) continue;

                    // Process in batches
                    let batch = db.batch();
                    let count = 0;

                    for (const doc of snap.docs) {
                        batch.update(doc.ref, {
                            [mig.field]: newUid,
                            updatedAt: admin.firestore.FieldValue.serverTimestamp()
                        });
                        count++;
                        migrationLog.push(`${mig.label}: ${doc.id}`);

                        if (count >= BATCH_LIMIT) {
                            await batch.commit();
                            batch = db.batch();
                            count = 0;
                        }
                    }

                    if (count > 0) {
                        await batch.commit();
                    }

                    console.log(`  ${mig.collection}.${mig.field}: ${snap.size} docs updated`);
                } catch (err) {
                    console.error(`  Error migrating ${mig.collection}.${mig.field}:`, err.message);
                    migrationLog.push(`ERROR ${mig.label}: ${err.message}`);
                }
            }

            // Merge old user doc into new if exists
            const oldUserDoc = await db.collection('users').doc(oldUid).get();
            if (oldUserDoc.exists) {
                const oldData = oldUserDoc.data();
                await db.collection('users').doc(newUid).set({
                    ...oldData,
                    email: email,
                    migratedFromUid: oldUid,
                    migratedAt: admin.firestore.FieldValue.serverTimestamp()
                }, { merge: true });
                migrationLog.push(`user doc merged: ${oldUid} -> ${newUid}`);
            }
        }

        // Log migration activity
        await db.collection('activities').add({
            type: 'uid_migration',
            details: `UID migration for ${email}: ${[...oldUids].join(', ')} -> ${newUid}. ${migrationLog.length} documents updated.`,
            performedByName: callerEmail,
            performedByUid: req.user.uid,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });

        return res.status(200).json({
            success: true,
            message: `Migration complete! ${migrationLog.length} documents updated.`,
            email,
            oldUids: [...oldUids],
            newUid,
            migratedCount: migrationLog.length,
            details: migrationLog
        });

    } catch (error) {
        console.error('Migration error:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
