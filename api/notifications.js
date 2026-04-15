// api/notifications.js - Updated with BDM isolation + markAllRead endpoint
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
                const uidQuery = db.collection('notifications')
                    .where('recipientUid', '==', userUid)
                    .limit(parseInt(limit));

                const uidSnapshot = await uidQuery.get();
                allNotifications = uidSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

                allNotifications.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
                allNotifications = allNotifications.slice(0, parseInt(limit));

                console.log(`📬 BDM (${req.user.name}) notifications: ${allNotifications.length} found`);
            }
            // ============================================
            // ALL OTHER ROLES - Get both role-based and UID-specific
            // ============================================
            else {
                let baseQuery = db.collection('notifications').limit(parseInt(limit));

                let roleQuery = baseQuery.where('recipientRole', '==', userRole);
                let uidQuery = baseQuery.where('recipientUid', '==', userUid);

                const [roleSnapshot, uidSnapshot] = await Promise.all([
                    roleQuery.get(),
                    uidQuery.get()
                ]);

                const roleNotifs = roleSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
                const uidNotifs = uidSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

                let combinedMap = new Map();
                roleNotifs.forEach(n => combinedMap.set(n.id, n));
                uidNotifs.forEach(n => combinedMap.set(n.id, n));

                allNotifications = Array.from(combinedMap.values());
                allNotifications.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
                allNotifications = allNotifications.slice(0, parseInt(limit));

                console.log(`📬 ${userRole.toUpperCase()} (${req.user.name}) notifications: ${allNotifications.length} found`);
            }

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
        // PUT - Mark notification(s) as read
        // ============================================
        if (req.method === 'PUT') {
            const { id, markAllRead } = req.query;
            const userRole = req.user.role;
            const userUid = req.user.uid;

            // ============================================
            // markAllRead=true - Mark ALL unread notifications as read
            // ============================================
            if (markAllRead === 'true') {
                let unreadDocs = [];

                if (userRole === 'bdm') {
                    const uidSnap = await db.collection('notifications')
                        .where('recipientUid', '==', userUid)
                        .where('isRead', '==', false)
                        .get();
                    unreadDocs = uidSnap.docs;
                } else {
                    const [roleSnap, uidSnap] = await Promise.all([
                        db.collection('notifications')
                            .where('recipientRole', '==', userRole)
                            .where('isRead', '==', false)
                            .get(),
                        db.collection('notifications')
                            .where('recipientUid', '==', userUid)
                            .where('isRead', '==', false)
                            .get()
                    ]);

                    const docMap = new Map();
                    roleSnap.docs.forEach(d => docMap.set(d.id, d));
                    uidSnap.docs.forEach(d => docMap.set(d.id, d));
                    unreadDocs = Array.from(docMap.values());
                }

                if (unreadDocs.length === 0) {
                    return res.status(200).json({ success: true, message: 'No unread notifications to update', count: 0 });
                }

                const readAt = admin.firestore.FieldValue.serverTimestamp();
                let batch = db.batch();
                let batchCount = 0;
                let totalUpdated = 0;

                for (const doc of unreadDocs) {
                    batch.update(doc.ref, { isRead: true, readAt });
                    batchCount++;
                    totalUpdated++;
                    if (batchCount >= 499) {
                        await batch.commit();
                        batch = db.batch();
                        batchCount = 0;
                    }
                }

                if (batchCount > 0) {
                    await batch.commit();
                }

                console.log(`✅ Marked ${totalUpdated} notifications as read for ${req.user.name} (${userRole})`);
                return res.status(200).json({
                    success: true,
                    message: `${totalUpdated} notifications marked as read`,
                    count: totalUpdated
                });
            }

            // ============================================
            // Single notification update (existing logic)
            // ============================================
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

            const notificationData = notificationDoc.data();
            const isRecipientByUid = notificationData.recipientUid === req.user.uid;
            const isRecipientByRole = notificationData.recipientRole === req.user.role && !notificationData.recipientUid;

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

            if (userRole === 'bdm') {
                console.log(`Deleting BDM notifications for UID: ${userUid}`);
                const uidQuery = db.collection('notifications').where('recipientUid', '==', userUid);
                const uidSnapshot = await uidQuery.get();
                await processSnapshot(uidSnapshot);
            } else {
                console.log(`Deleting notifications for UID: ${userUid}`);
                const uidQuery = db.collection('notifications').where('recipientUid', '==', userUid);
                const uidSnapshot = await uidQuery.get();
                await processSnapshot(uidSnapshot);

                console.log(`Deleting role-based notifications for Role: ${userRole}`);
                const roleQuery = db.collection('notifications')
                    .where('recipientRole', '==', userRole)
                    .where('recipientUid', '==', null);
                const roleSnapshot = await roleQuery.get();
                await processSnapshot(roleSnapshot);
            }

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
