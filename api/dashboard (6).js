// api/dashboard.js - Dashboard data handler (Serverless compatible)
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
        await util.promisify(verifyToken)(req, res);

        if (req.method === 'GET') {
            const { role, stats } = req.query;
            
            // If stats endpoint is requested
            if (stats === 'true') {
                const statsData = {};
                const collections = ['proposals', 'projects', 'tasks', 'submissions', 'payments'];
                
                for (const collection of collections) {
                    try {
                        const snapshot = await db.collection(collection).get();
                        statsData[collection] = snapshot.size;
                    } catch (error) {
                        console.log(`ℹ️ ${collection} collection error:`, error.message);
                        statsData[collection] = 0;
                    }
                }

                return res.status(200).json({
                    success: true,
                    data: statsData,
                    timestamp: new Date().toISOString()
                });
            }
            
            // If role-specific dashboard is requested
            if (role) {
                return await getRoleDashboard(req, res, role);
            }

            // Default dashboard
            console.log('📊 Dashboard data requested');

            // Initialize counters
            let totalProposals = 0;
            let activeProjects = 0;
            let pendingTasks = 0;
            let totalValue = 0;
            let recentActivities = [];

            try {
                // Get proposals count
                const proposalsSnapshot = await db.collection('proposals').get();
                totalProposals = proposalsSnapshot.size;

                // Calculate total value from proposals
                proposalsSnapshot.forEach(doc => {
                    const data = doc.data();
                    if (data.estimatedValue) {
                        totalValue += parseFloat(data.estimatedValue) || 0;
                    }
                });
            } catch (error) {
                console.log('ℹ️ Proposals collection not found or error:', error.message);
            }

            try {
                // Get active projects count
                const projectsSnapshot = await db.collection('projects')
                    .where('status', '==', 'active')
                    .get();
                activeProjects = projectsSnapshot.size;
            } catch (error) {
                console.log('ℹ️ Projects collection not found or error:', error.message);
            }

            try {
                // Get pending tasks count
                const tasksSnapshot = await db.collection('tasks')
                    .where('status', '==', 'pending')
                    .get();
                pendingTasks = tasksSnapshot.size;
            } catch (error) {
                console.log('ℹ️ Tasks collection not found or error:', error.message);
            }

            try {
                // Get recent activities (last 10)
                const activitiesSnapshot = await db.collection('activities')
                    .orderBy('timestamp', 'desc')
                    .limit(10)
                    .get();

                activitiesSnapshot.forEach(doc => {
                    const data = doc.data();
                    recentActivities.push({
                        id: doc.id,
                        description: data.description || data.details || 'Activity',
                        user: data.user || data.performedByName || 'System',
                        timestamp: data.timestamp || data.createdAt || new Date().toISOString(),
                        status: data.status || 'completed',
                        type: data.type || 'general'
                    });
                });
            } catch (error) {
                console.log('ℹ️ Activities collection not found or error:', error.message);
            }

            // Build response
            const dashboardData = {
                success: true,
                data: {
                    totalProposals,
                    activeProjects,
                    pendingTasks,
                    totalValue,
                    recentActivities,
                    lastUpdated: new Date().toISOString()
                },
                timestamp: new Date().toISOString()
            };

            console.log('✅ Dashboard data prepared:', {
                proposals: totalProposals,
                projects: activeProjects,
                tasks: pendingTasks,
                activities: recentActivities.length
            });

            return res.status(200).json(dashboardData);
        }

        return res.status(405).json({ success: false, error: 'Method not allowed' });
        
    } catch (error) {
        console.error('❌ Dashboard error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to load dashboard',
            message: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error',
            data: {
                totalProposals: 0,
                activeProjects: 0,
                pendingTasks: 0,
                totalValue: 0,
                recentActivities: []
            }
        });
    }
};

async function getRoleDashboard(req, res, role) {
    try {
        console.log(`📊 Loading dashboard for role: ${role}`);

        let dashboardData = {
            success: true,
            role: role,
            data: {},
            timestamp: new Date().toISOString()
        };

        switch (role) {
            case 'estimator':
                const estimatorProposals = await db.collection('proposals')
                    .where('status', 'in', ['pending', 'in_review'])
                    .get();
                
                dashboardData.data = {
                    pendingProposals: estimatorProposals.size,
                    message: 'Estimator dashboard'
                };
                break;

            case 'coo':
            case 'director':
                const allProposals = await db.collection('proposals').get();
                const allProjects = await db.collection('projects').get();
                
                dashboardData.data = {
                    totalProposals: allProposals.size,
                    totalProjects: allProjects.size,
                    message: 'Executive dashboard'
                };
                break;

            case 'designer':
            case 'design_lead':
                const designTasks = await db.collection('tasks')
                    .where('designerUid', '==', req.user.uid)
                    .get();
                
                dashboardData.data = {
                    designTasks: designTasks.size,
                    message: 'Design dashboard'
                };
                break;

            case 'accounts':
                const payments = await db.collection('payments').get();
                
                dashboardData.data = {
                    totalPayments: payments.size,
                    message: 'Accounts dashboard'
                };
                break;

            case 'bdm':
                const bdmProposals = await db.collection('proposals')
                    .where('createdByUid', '==', req.user.uid)
                    .get();
                
                dashboardData.data = {
                    myProposals: bdmProposals.size,
                    message: 'BDM dashboard'
                };
                break;

            default:
                dashboardData.data = {
                    message: 'Generic dashboard'
                };
        }

        return res.status(200).json(dashboardData);

    } catch (error) {
        console.error('Role dashboard error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to load role-specific dashboard'
        });
    }
}

module.exports = allowCors(handler);
