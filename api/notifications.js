// api/notifications.js - Updated with BDM isolation
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
        // Verify user token for all requests
        await util.promisify(verifyToken)(req, res);

        // ============================================
        // GET - Fetch notifications for the logged-in user
        // ============================================
        if (req.method === 'GET') {
            const { unreadOnly, limit = 20 } = req.query;
            const userRole = req.user.role;
            const userUid = req.user.uid;

            let allNotifications = [];

            // ============================================
            // BDM ISOLATION - Only their own notifications
            // ============================================
            if (userRole === 'bdm') {
                // For BDMs, ONLY fetch notifications specifically for their UID
                // Do NOT fetch role-based notifications
                const uidQuery = db.collection('notifications')
                    .where('recipientUid', '==', userUid)
                    .limit(parseInt(limit));

                const uidSnapshot = await uidQuery.get();
                allNotifications = uidSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

                // Sort manually by createdAt
                allNotifications.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));

                // Apply limit after sorting
                allNotifications = allNotifications.slice(0, parseInt(limit));

                console.log(`📬 BDM (${req.user.name}) notifications: ${allNotifications.length} found`);
            }
            // ============================================
            // ALL OTHER ROLES - Get both role-based and UID-specific
            // ============================================
            else {
                // Base query setup
                let baseQuery = db.collection('notifications')
                                 .limit(parseInt(limit));

                // Role-based notifications (for their role, without specific UID)
                let roleQuery = baseQuery.where('recipientRole', '==', userRole);
                
                // UID-specific notifications
                let uidQuery = baseQuery.where('recipientUid', '==', userUid);

                // Execute queries in parallel
                const [roleSnapshot, uidSnapshot] = await Promise.all([
                    roleQuery.get(),
                    uidQuery.get()
                ]);

                const roleNotifs = roleSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
                const uidNotifs = uidSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

                // Combine and remove duplicates using a Map
                let combinedMap = new Map();
                roleNotifs.forEach(n => combinedMap.set(n.id, n));
                uidNotifs.forEach(n => combinedMap.set(n.id, n)); // Overwrites if ID already exists

                allNotifications = Array.from(combinedMap.values());

                // Sort manually AFTER fetching and combining
                allNotifications.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));

                // Apply limit *after* sorting the combined list
                allNotifications = allNotifications.slice(0, parseInt(limit));

                console.log(`📬 ${userRole.toUpperCase()} (${req.user.name}) notifications: ${allNotifications.length} found`);
            }

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
                createdBy: req.user.name,
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
            const { id } = req.query;
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

            // BDM special check - must match UID
            if (req.user.role === 'bdm' && !isRecipientByUid) {
                return res.status(403).json({ 
                    success: false, 
                    error: 'Access denied. You can only modify your own notifications.' 
                });
            }

            if (!isRecipientByUid && !isRecipientByRole) {
                return res.status(403).json({ 
                    success: false, 
                    error: 'You do not have permission to modify this notification.' 
                });
            }
            // --- End Authorization Check ---

            await notificationRef.update({
                isRead: Boolean(isRead),
                readAt: Boolean(isRead) ? admin.firestore.FieldValue.serverTimestamp() : null
            });

            return res.status(200).json({
                success: true,
                message: `Notification marked as ${Boolean(isRead) ? 'read' : 'unread'}`
            });
        }

        // ============================================
        // DELETE - Clear notifications
        // ============================================
        if (req.method === 'DELETE') {
            const userRole = req.user.role;
            const userUid = req.user.uid;

            let batch = db.batch();
            let count = 0;
            const MAX_BATCH_SIZE = 499;
            let currentBatchSize = 0;

            const processSnapshot = async (snapshot) => {
                for (const doc of snapshot.docs) {
                    batch.delete(doc.ref);
                    count++;
                    currentBatchSize++;
                    if (currentBatchSize >= MAX_BATCH_SIZE) {
                        await batch.commit();
                        batch = db.batch();
                        currentBatchSize = 0;
                        console.log(`Committed batch of ${MAX_BATCH_SIZE} deletes...`);
                    }
                }
            };

            // ============================================
            // BDM ISOLATION - Only delete their own notifications
            // ============================================
            if (userRole === 'bdm') {
                console.log(`Deleting BDM notifications for UID: ${userUid}`);
                const uidQuery = db.collection('notifications').where('recipientUid', '==', userUid);
                const uidSnapshot = await uidQuery.get();
                await processSnapshot(uidSnapshot);
            }
            // ============================================
            // ALL OTHER ROLES - Delete both role-based and UID-specific
            // ============================================
            else {
                // Notifications specifically for this user UID
                console.log(`Deleting notifications for UID: ${userUid}`);
                const uidQuery = db.collection('notifications').where('recipientUid', '==', userUid);
                const uidSnapshot = await uidQuery.get();
                await processSnapshot(uidSnapshot);

                // Role-based notifications (without specific UID)
                console.log(`Deleting role-based notifications for Role: ${userRole}`);
                const roleQuery = db.collection('notifications')
                    .where('recipientRole', '==', userRole)
                    .where('recipientUid', '==', null);
                const roleSnapshot = await roleQuery.get();
                await processSnapshot(roleSnapshot);
            }

            // Commit any remaining deletes
            if (currentBatchSize > 0) {
                console.log(`Committing final batch of ${currentBatchSize} deletes...`);
                await batch.commit();
            }

            console.log(`Successfully deleted ${count} notifications for ${req.user.name} (${userRole})`);
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
