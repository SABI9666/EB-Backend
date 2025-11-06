// api/notifications.js - Complete handler with sorting workaround
// NO CHANGES to existing functionality - this file remains unchanged
const admin = require('./_firebase-admin');
const { verifyToken } = require('../middleware/auth');
const util = require('util');

const db = admin.firestore();

const allowCors = fn => async (req, res) => {
    res.setHeader('Access-Control-Allow-Credentials', true);
    // Allow requests from any origin - adjust in production if needed
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
        // Verify user token for all requests
        await util.promisify(verifyToken)(req, res);

        // ============================================
        // GET - Fetch notifications for the logged-in user
        // ============================================
        if (req.method === 'GET') {
            const { unreadOnly, limit = 20 } = req.query; // Default limit to 20
            const userRole = req.user.role;
            const userUid = req.user.uid;

            // Base query setup (removed orderBy for workaround)
            let baseQuery = db.collection('notifications')
                             .limit(parseInt(limit)); // Apply limit early

            let roleQuery = baseQuery.where('recipientRole', '==', userRole);
            let uidQuery = baseQuery.where('recipientUid', '==', userUid);

            let allNotifications = [];

            // Execute queries in parallel
            const [roleSnapshot, uidSnapshot] = await Promise.all([
                roleQuery.get(),
                uidQuery.get() // Always fetch UID-specific ones
            ]);

            const roleNotifs = roleSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            const uidNotifs = uidSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

            // Combine and remove duplicates using a Map (keeps the latest based on insertion order, UID overwrites Role)
            let combinedMap = new Map();
            roleNotifs.forEach(n => combinedMap.set(n.id, n));
            uidNotifs.forEach(n => combinedMap.set(n.id, n)); // Overwrites if ID already exists

            allNotifications = Array.from(combinedMap.values());

            // Sort manually AFTER fetching and combining
            allNotifications.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));

            // Apply limit *after* sorting the combined list
            allNotifications = allNotifications.slice(0, parseInt(limit));

            // Filter for unread if requested
            if (unreadOnly === 'true') {
                allNotifications = allNotifications.filter(n => !n.isRead);
            }

            return res.status(200).json({ success: true, data: allNotifications });
        }

        // ============================================
        // POST - Create a new notification (system use)
        // ============================================
        if (req.method === 'POST') {
            const {
                type,
                recipientRole,
                recipientUid,
                message,
                projectId,
                proposalId,
                variationId,
                notes,
                priority = 'normal'
            } = req.body;

            // Basic validation
            if (!type || !recipientRole || !message) {
                 return res.status(400).json({ success: false, error: 'Missing required fields: type, recipientRole, message' });
            }

            const notificationData = {
                type,
                recipientRole,
                recipientUid: recipientUid || null,
                message,
                projectId: projectId || null,
                proposalId: proposalId || null,
                variationId: variationId || null,
                notes: notes || null,
                priority,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                createdBy: req.user.name, // Log who triggered the notification creation
                createdByRole: req.user.role,
                isRead: false
            };

            const docRef = await db.collection('notifications').add(notificationData);

            return res.status(201).json({
                success: true,
                data: { id: docRef.id, ...notificationData }
            });
        }

        // ============================================
        // PUT - Mark a notification as read
        // ============================================
        if (req.method === 'PUT') {
            const { id } = req.query; // Get ID from query parameters

             // Get isRead status from the request body
             const { isRead } = req.body;

             if (isRead === undefined) {
                 return res.status(400).json({ success: false, error: 'Missing isRead status in request body' });
             }

            if (!id) {
                return res.status(400).json({
                    success: false,
                    error: 'Notification ID required in query parameters (e.g., /api/notifications?id=YOUR_ID)'
                });
            }

            const notificationRef = db.collection('notifications').doc(id);
            const notificationDoc = await notificationRef.get();

            if (!notificationDoc.exists) {
                return res.status(404).json({
                    success: false,
                    error: 'Notification not found'
                });
            }

            // --- Authorization Check ---
            const notificationData = notificationDoc.data();
            const isRecipientByUid = notificationData.recipientUid === req.user.uid;
            const isRecipientByRole = notificationData.recipientRole === req.user.role && !notificationData.recipientUid;

            if (!isRecipientByUid && !isRecipientByRole) {
                return res.status(403).json({ success: false, error: 'You do not have permission to modify this notification.' });
            }
            // --- End Authorization Check ---


            await notificationRef.update({
                isRead: Boolean(isRead), // Ensure it's a boolean
                readAt: Boolean(isRead) ? admin.firestore.FieldValue.serverTimestamp() : null // Set read time only if marking read
            });

            return res.status(200).json({
                success: true,
                message: `Notification marked as ${Boolean(isRead) ? 'read' : 'unread'}`
            });
        }

        // ============================================
        // DELETE - Clear notifications (can be enhanced later)
        // ============================================
        if (req.method === 'DELETE') {
            // This example clears ALL notifications for the user (role + specific)
            // Consider adding filters (e.g., clear only read) in the future
            const userRole = req.user.role;
            const userUid = req.user.uid;

            let batch = db.batch();
            let count = 0;
            const MAX_BATCH_SIZE = 499; // Firestore batch limit is 500 writes
            let currentBatchSize = 0;

            // --- Query setup ---
            // Notifications specifically for this user UID
            const uidQuery = db.collection('notifications').where('recipientUid', '==', userUid);
            // Notifications for this user's role (without a specific UID)
            const roleQuery = db.collection('notifications').where('recipientRole', '==', userRole).where('recipientUid', '==', null);


             // --- Execute queries and batch deletes ---
            const processSnapshot = async (snapshot) => {
                 for (const doc of snapshot.docs) {
                    batch.delete(doc.ref);
                    count++;
                    currentBatchSize++;
                    // Commit batch if it reaches size limit
                    if (currentBatchSize >= MAX_BATCH_SIZE) {
                        await batch.commit();
                        batch = db.batch(); // Start a new batch
                        currentBatchSize = 0;
                        console.log(`Committed batch of ${MAX_BATCH_SIZE} deletes...`);
                    }
                 }
            };

            console.log(`Deleting notifications for UID: ${userUid}`);
            const uidSnapshot = await uidQuery.get();
            await processSnapshot(uidSnapshot);

            console.log(`Deleting role-based notifications for Role: ${userRole}`);
            const roleSnapshot = await roleQuery.get();
            await processSnapshot(roleSnapshot);


            // Commit any remaining deletes in the last batch
            if (currentBatchSize > 0) {
                console.log(`Committing final batch of ${currentBatchSize} deletes...`);
                await batch.commit();
            }

            console.log(`Successfully deleted ${count} notifications.`);
            return res.status(200).json({
                success: true,
                message: `${count} notifications cleared`
            });
        }

        // ============================================
        // Fallback for unhandled methods
        // ============================================
        return res.status(405).json({ success: false, error: 'Method not allowed' });

    } catch (error) {
        console.error('Notifications API error:', error);
        return res.status(500).json({
            success: false,
            error: 'Internal Server Error',
            message: error.message
        });
    }
};

module.exports = allowCors(handler);
