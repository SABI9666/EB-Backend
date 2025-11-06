// api/activities.js - Complete activities handler
const admin = require('./_firebase-admin');
const { verifyToken } = require('../middleware/auth');
const util = require('util');

const db = admin.firestore();

const allowCors = fn => async (req, res) => {
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }
    return await fn(req, res);
};

const handler = async (req, res) => {
    if (req.method === 'GET') {
        try {
            await util.promisify(verifyToken)(req, res);
            const { limit = 20, proposalId } = req.query;
            const userRole = req.user.role;
            const userUid = req.user.uid;
            
            let query = db.collection('activities').orderBy('timestamp', 'desc');

            if (proposalId) {
                // Check if BDM can access this proposal's activities
                if (userRole === 'bdm') {
                    const proposalDoc = await db.collection('proposals').doc(proposalId).get();
                    if (!proposalDoc.exists || proposalDoc.data().createdByUid !== userUid) {
                        return res.status(403).json({ 
                            success: false, 
                            error: 'Access denied. You can only view activities for your own proposals.' 
                        });
                    }
                }
                query = query.where('proposalId', '==', proposalId);
            } else if (userRole === 'bdm') {
                // For BDMs viewing all activities, filter to only their proposals
                const proposalsSnapshot = await db.collection('proposals')
                    .where('createdByUid', '==', userUid)
                    .get();
                const proposalIds = proposalsSnapshot.docs.map(doc => doc.id);
                
                if (proposalIds.length === 0) {
                    return res.status(200).json({ success: true, data: [] });
                }
                
                // Firestore 'in' operator supports max 10 items
                if (proposalIds.length <= 10) {
                    query = query.where('proposalId', 'in', proposalIds);
                } else {
                    // For more than 10 proposals, fetch more and filter
                    const snapshot = await query.limit(parseInt(limit) * 2).get();
                    const activities = snapshot.docs
                        .map(doc => ({ id: doc.id, ...doc.data() }))
                        .filter(activity => proposalIds.includes(activity.proposalId))
                        .slice(0, parseInt(limit));
                    
                    return res.status(200).json({ success: true, data: activities });
                }
            }

            const snapshot = await query.limit(parseInt(limit)).get();
            const activities = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

            return res.status(200).json({ success: true, data: activities });
        } catch (error) {
            console.error('Activities API error:', error);
            return res.status(500).json({ success: false, error: 'Internal Server Error', message: error.message });
        }
    } else {
        return res.status(405).json({ success: false, error: 'Method not allowed' });
    }
};

module.exports = allowCors(handler);
