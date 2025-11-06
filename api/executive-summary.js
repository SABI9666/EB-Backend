// api/executive-summary.js
// This is the NEW file to power the Executive Timesheet Monitoring dashboard.

const admin = require('./_firebase-admin'); // <-- FIXED PATH
const { verifyToken } = require('../middleware/auth'); // <-- FIXED PATH
const util = require('util');

const db = admin.firestore();

// Standard CORS helper function
const allowCors = fn => async (req, res) => {
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*'); // Adjust this for production if needed
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With, Accept, Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }
    return await fn(req, res);
};

const handler = async (req, res) => {
    try {
        // 1. Authenticate the user
        await util.promisify(verifyToken)(req, res);

        // 2. Authorize: Only allow executive roles
        const allowedRoles = ['coo', 'director', 'design_lead'];
        if (!req.user || !allowedRoles.includes(req.user.role)) {
            return res.status(403).json({ 
                success: false, 
                error: 'Permission Denied. Executive access required.' 
            });
        }

        // 3. Handle GET request
        if (req.method === 'GET') {
            const { fromDate, toDate } = req.query;

            // 4. Validate Date Inputs
            if (!fromDate || !toDate) {
                return res.status(400).json({ 
                    success: false, 
                    error: 'Both fromDate and toDate are required.' 
                });
            }

            const fromTimestamp = admin.firestore.Timestamp.fromDate(new Date(fromDate));
            const toDateObj = new Date(toDate);
            toDateObj.setDate(toDateObj.getDate() + 1); // Go to end of the day
            const toTimestamp = admin.firestore.Timestamp.fromDate(toDateObj);

            // 5. Query Firestore for projects
            // We fetch all projects that have allocated hours.
            const projectsRef = db.collection('projects');
            const snapshot = await projectsRef
                .where('allocatedHours', '>', 0)
                .get();

            if (snapshot.empty) {
                return res.status(200).json({
                    success: true,
                    data: {
                        totalProjects: 0,
                        onTrackProjects: 0,
                        atRiskProjects: 0,
                        exceededProjects: 0,
                        totalHoursAllocated: 0,
                        totalHoursLogged: 0,
                    }
                });
            }

            // 6. Aggregate the Data
            let summary = {
                totalProjects: 0,
                onTrackProjects: 0,
                atRiskProjects: 0,
                exceededProjects: 0,
                totalHoursAllocated: 0,
                totalHoursLogged: 0,
            };

            // We also need to get timesheets within the date range
            const timesheetSnapshot = await db.collection('timesheets')
                .where('date', '>=', fromTimestamp)
                .where('date', '<=', toTimestamp)
                .get();

            // Create a map of hours logged per project *within the date range*
            const hoursLoggedByProject = {};
            timesheetSnapshot.docs.forEach(doc => {
                const entry = doc.data();
                const projectId = entry.projectId;
                if (!hoursLoggedByProject[projectId]) {
                    hoursLoggedByProject[projectId] = 0;
                }
                hoursLoggedByProject[projectId] += (entry.hours || 0);
            });

            // Now loop through projects to categorize them
            snapshot.docs.forEach(doc => {
                const project = doc.data();
                const projectId = doc.id;

                // Only count projects that had hours logged in this period
                if (hoursLoggedByProject[projectId] > 0) {
                    const allocated = project.allocatedHours || 0;
                    // Use the project's *total* hours logged for budget calculation
                    const totalLoggedOnProject = project.hoursLogged || 0; 

                    summary.totalProjects++;
                    summary.totalHoursAllocated += allocated;
                    summary.totalHoursLogged += totalLoggedOnProject; // Use total logged for this metric

                    // Categorize based on *total* budget usage
                    if (allocated > 0) {
                        const budgetUsed = (totalLoggedOnProject / allocated) * 100;
                        
                        if (budgetUsed <= 70) {
                            summary.onTrackProjects++;
                        } else if (budgetUsed > 70 && budgetUsed <= 100) {
                            summary.atRiskProjects++;
                        } else if (budgetUsed > 100) {
                            summary.exceededProjects++;
                        }
                    } else {
                        // If 0 hours allocated, but hours were logged, count as 'Exceeded'
                        if (totalLoggedOnProject > 0) {
                            summary.exceededProjects++;
                        }
                    }
                }
            });

            // 7. Send the successful response
            return res.status(200).json({ success: true, data: summary });
        }

        return res.status(405).json({ success: false, error: 'Method not allowed' });

    } catch (error) {
        console.error('Executive Summary API error:', error);
        return res.status(500).json({
            success: false,
            error: 'Internal Server Error',
            message: error.message
        });
    }
};

module.exports = allowCors(handler);
