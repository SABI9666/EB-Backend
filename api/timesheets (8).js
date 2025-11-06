// timesheets (7).js - CORRECTED
const express = require('express');
const admin = require('./_firebase-admin'); // <<< THIS IS THE FIX (removed curly braces)
const db = admin.firestore(); // This will now work
const { FieldValue } = require('firebase-admin/firestore');

// --- FIX: Import verifyToken and util ---
const { verifyToken } = require('../middleware/auth');
const util = require('util');
// --- End of Fix ---

const timesheetsRouter = express.Router();
const timeRequestRouter = express.Router();

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Aggregates total logged hours for a project.
 * This is a helper to avoid recalculating totals manually.
 * @param {string} projectId The ID of the project to aggregate.
 * @returns {Promise<number>} Total hours logged.
 */
const getAggregatedProjectHours = async (projectId) => {
    try {
        const timesheetsSnapshot = await db.collection('timesheets')
            .where('projectId', '==', projectId)
            .get();
        
        if (timesheetsSnapshot.empty) {
            return 0;
        }

        let totalHours = 0;
        timesheetsSnapshot.forEach(doc => {
            totalHours += doc.data().hours || 0;
        });

        return totalHours;
    } catch (error) {
        console.error(`Error aggregating hours for project ${projectId}:`, error);
        return 0;
    }
};

/**
 * Updates the 'hoursLogged' field on a project document.
 * @param {string} projectId The ID of the project to update.
 */
const updateProjectHoursLogged = async (projectId) => {
    try {
        const totalHours = await getAggregatedProjectHours(projectId);
        await db.collection('projects').doc(projectId).update({
            hoursLogged: totalHours
        });
        console.log(`Updated project ${projectId} to ${totalHours} logged hours.`);
    } catch (error)
    {
        console.error(`Error updating project ${projectId} hours:`, error);
    }
};


// ============================================
// TIMESHEETS ROUTER (/api/timesheets)
// ============================================

/**
 * GET /api/timesheets
 * Handles:
 * 1. ?action=executive_dashboard (for COO/Director)
 * 2. ?projectId=... (for getting a project's timesheets)
 * 3. No query (for a designer getting their own timesheets)
 */
timesheetsRouter.get('/', async (req, res) => {
    
    // --- FIX: Add internal auth check ---
    try {
        await util.promisify(verifyToken)(req, res);
    } catch (error) {
        console.error("Auth error in GET /api/timesheets:", error);
        return res.status(401).json({ success: false, error: 'Authentication failed', message: error.message });
    }
    // --- End of Fix ---

    const { action, projectId } = req.query;
    const designerUid = req.user.uid; // From auth middleware

    // 1. ================== EXECUTIVE DASHBOARD ==================
    if (action === 'executive_dashboard') {
        try {
            // --- 1. Fetch all raw data ---
            const projectsSnapshot = await db.collection('projects').get();
            const timesheetsSnapshot = await db.collection('timesheets').get();
            const designersSnapshot = await db.collection('users').where('role', '==', 'designer').get();

            let allTimesheets = [];
            timesheetsSnapshot.forEach(doc => allTimesheets.push({ id: doc.id, ...doc.data() }));

            let allDesigners = {};
            designersSnapshot.forEach(doc => {
                allDesigners[doc.id] = { id: doc.id, ...doc.data(), totalHours: 0, projectsWorkedOn: new Set() };
            });

            // --- 2. Process Timesheets into Projects ---
            let projectHours = {}; // { projectId: { logged: number, allocated: number, ... } }

            projectsSnapshot.forEach(doc => {
                const data = doc.data();
                projectHours[doc.id] = {
                    id: doc.id,
                    ...data,
                    // ===============================================================
                    //  THE FIX: Read 'maxAllocatedHours' from the project document
                    // ===============================================================
                    allocatedHours: data.maxAllocatedHours || 0, 
                    hoursLogged: 0, // Will be calculated next
                };
            });

            // Aggregate logged hours from timesheets
            allTimesheets.forEach(ts => {
                if (projectHours[ts.projectId]) {
                    projectHours[ts.projectId].hoursLogged += ts.hours || 0;
                }
                // Also aggregate designer stats
                if (allDesigners[ts.designerUid]) {
                    allDesigners[ts.designerUid].totalHours += ts.hours || 0;
                    allDesigners[ts.designerUid].projectsWorkedOn.add(ts.projectId);
                }
            });

            // --- 3. Calculate Metrics and Format Data ---
            const projects = Object.values(projectHours);
            const designers = Object.values(allDesigners).map(d => ({
                ...d,
                projectsWorkedOn: d.projectsWorkedOn.size,
            }));

            let metrics = {
                totalProjects: projects.length,
                projectsWithTimeline: 0,
                projectsAboveTimeline: 0,
                totalExceededHours: 0,
                totalAllocatedHours: 0,
                totalLoggedHours: 0,
            };

            let analytics = {
                exceededProjects: [],
                withinTimelineProjects: [],
                projectStatusDistribution: {},
                designerDuration: designers.sort((a, b) => b.totalHours - a.totalHours),
            };

            projects.forEach(p => {
                // Tally status for pie chart
                const statusKey = p.status || 'unknown';
                analytics.projectStatusDistribution[statusKey] = (analytics.projectStatusDistribution[statusKey] || 0) + 1;
                
                // Calculate timeline metrics
                if (p.allocatedHours > 0) {
                    metrics.projectsWithTimeline += 1;
                    metrics.totalAllocatedHours += p.allocatedHours;
                    metrics.totalLoggedHours += p.hoursLogged;

                    p.percentageUsed = p.allocatedHours > 0 ? (p.hoursLogged / p.allocatedHours * 100) : 0;
                    
                    if (p.hoursLogged > p.allocatedHours) {
                        p.isExceeded = true;
                        p.exceededBy = p.hoursLogged - p.allocatedHours;
                        metrics.projectsAboveTimeline += 1;
                        metrics.totalExceededHours += p.exceededBy;
                        analytics.exceededProjects.push(p);
                    } else {
                        p.isExceeded = false;
                        p.exceededBy = 0;
                        analytics.withinTimelineProjects.push(p);
                    }
                } else {
                    // Project has no timeline
                    p.isExceeded = false;
                    p.exceededBy = 0;
                    p.percentageUsed = 0;
                }
            });

            metrics.averageHoursPerProject = projects.length > 0 ? (metrics.totalLoggedHours / projects.length) : 0;

            // --- 4. Send Response ---
            return res.status(200).json({
                success: true,
                data: {
                    metrics,
                    projects,
                    designers: designers.map(d => ({ // Send only what's needed
                        name: d.name,
                        email: d.email,
                        totalHours: d.totalHours,
                        projectsWorkedOn: d.projectsWorkedOn,
                    })),
                    analytics
                }
            });

        } catch (error) {
            console.error('Error in GET /timesheets (executive_dashboard):', error);
            return res.status(500).json({ success: false, error: error.message });
        }
    }

    // 2. ================== GET TIMESHEETS FOR ONE PROJECT ==================
    if (projectId) {
        try {
            const timesheets = [];
            const snapshot = await db.collection('timesheets')
                .where('projectId', '==', projectId)
                .orderBy('date', 'desc')
                .get();
            
            snapshot.forEach(doc => timesheets.push({ id: doc.id, ...doc.data() }));
            return res.status(200).json({ success: true, data: timesheets });
        } catch (error) {
            console.error('Error in GET /timesheets (projectId):', error);
            return res.status(500).json({ success: false, error: error.message });
        }
    }

    // 3. ================== GET MY TIMESHEETS (DESIGNER) ==================
    try {
        const timesheets = [];
        const snapshot = await db.collection('timesheets')
            .where('designerUid', '==', designerUid)
            .orderBy('date', 'desc')
            .get();
        
        snapshot.forEach(doc => timesheets.push({ id: doc.id, ...doc.data() }));
        return res.status(200).json({ success: true, data: timesheets });
    } catch (error) {
        console.error('Error in GET /timesheets (designer):', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});


/**
 * POST /api/timesheets
 * A designer logs new hours.
 */
timesheetsRouter.post('/', async (req, res) => {
    
    // --- FIX: Add internal auth check ---
    try {
        await util.promisify(verifyToken)(req, res);
    } catch (error) {
        console.error("Auth error in POST /api/timesheets:", error);
        return res.status(401).json({ success: false, error: 'Authentication failed', message: error.message });
    }
    // --- End of Fix ---

    try {
        const { projectId, date, hours, description } = req.body;
        const { uid, name, email } = req.user;

        if (!projectId || !date || !hours || !description) {
            return res.status(400).json({ success: false, error: 'Missing required fields.' });
        }

        // --- 1. Get Project and Current Hours ---
        const projectDoc = await db.collection('projects').doc(projectId).get();
        if (!projectDoc.exists) {
            return res.status(404).json({ success: false, error: 'Project not found.' });
        }

        const projectData = projectDoc.data();
        const totalHours = await getAggregatedProjectHours(projectId);

        // --- 2. Check Allocation ---
        const allocatedHours = projectData.maxAllocatedHours || 0;
        const additionalHours = projectData.additionalHours || 0;
        const totalAllocation = allocatedHours + additionalHours;

        if (totalHours + hours > totalAllocation && totalAllocation > 0) {
            return res.status(200).json({
                success: false,
                exceedsAllocation: true,
                totalHours: totalHours,
                allocatedHours: totalAllocation,
                exceededBy: (totalHours + hours) - totalAllocation
            });
        }

        // --- 3. Add Timesheet Entry ---
        const newEntry = {
            projectId,
            projectName: projectData.projectName,
            projectCode: projectData.projectCode,
            date: new Date(date),
            hours: Number(hours),
            description,
            designerUid: uid,
            designerName: name,
            designerEmail: email,
            status: 'approved', // Auto-approved if within budget
            createdAt: FieldValue.serverTimestamp()
        };

        const docRef = await db.collection('timesheets').add(newEntry);

        // --- 4. Update Project's hoursLogged (denormalized) ---
        await updateProjectHoursLogged(projectId);

        return res.status(201).json({ success: true, data: { id: docRef.id, ...newEntry } });

    } catch (error) {
        console.error('Error in POST /timesheets:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * DELETE /api/timesheets?id=...
 * A designer deletes one of their own timesheet entries.
 */
timesheetsRouter.delete('/', async (req, res) => {
    
    // --- FIX: Add internal auth check ---
    try {
        await util.promisify(verifyToken)(req, res);
    } catch (error) {
        console.error("Auth error in DELETE /api/timesheets:", error);
        return res.status(401).json({ success: false, error: 'Authentication failed', message: error.message });
    }
    // --- End of Fix ---

    try {
        const { id } = req.query;
        const { uid } = req.user;

        if (!id) {
            return res.status(400).json({ success: false, error: 'Missing timesheet ID.' });
        }

        const docRef = db.collection('timesheets').doc(id);
        const doc = await docRef.get();

        if (!doc.exists) {
            return res.status(404).json({ success: false, error: 'Timesheet entry not found.' });
        }

        const data = doc.data();

        // Only allow designer to delete their own entry
        if (data.designerUid !== uid) {
            return res.status(403).json({ success: false, error: 'You are not authorized to delete this entry.' });
        }

        // Store projectId before deleting
        const projectId = data.projectId;

        // Delete the entry
        await docRef.delete();

        // Update the project's total logged hours
        if (projectId) {
            await updateProjectHoursLogged(projectId);
        }

        return res.status(200).json({ success: true, message: 'Timesheet entry deleted.' });

    } catch (error) {
        console.error('Error in DELETE /timesheets:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});


// ============================================
// TIME REQUESTS ROUTER (/api/time-requests)
// ============================================

/**
 * GET /api/time-requests
 * Handles:
 * 1. ?status=pending (for COO/Director)
 * 2. ?id=... (for COO/Director single view)
 * 3. No query (for a designer getting their own requests)
 */
timeRequestRouter.get('/', async (req, res) => {

    // --- FIX: Add internal auth check ---
    try {
        await util.promisify(verifyToken)(req, res);
    } catch (error) {
        console.error("Auth error in GET /api/time-requests:", error);
        return res.status(401).json({ success: false, error: 'Authentication failed', message: error.message });
    }
    // --- End of Fix ---

    const { status, id } = req.query;
    const { uid, role } = req.user; // This will now work

    try {
        // 1. ================== COO: Get Pending Requests ==================
        if (status === 'pending' && (role === 'coo' || role === 'director')) {
            const requests = [];
            const snapshot = await db.collection('time-requests')
                .where('status', '==', 'pending')
                .orderBy('createdAt', 'desc')
                .get();
            
            snapshot.forEach(doc => requests.push({ id: doc.id, ...doc.data() }));
            return res.status(200).json({ success: true, data: requests });
        }

        // 2. ================== COO: Get Single Request ==================
        if (id && (role === 'coo' || role === 'director')) {
            const doc = await db.collection('time-requests').doc(id).get();
            if (!doc.exists) {
                return res.status(404).json({ success: false, error: 'Request not found.' });
            }
            return res.status(200).json({ success: true, data: { id: doc.id, ...doc.data() } });
        }

        // 3. ================== Designer: Get My Requests ==================
        const requests = [];
        const snapshot = await db.collection('time-requests')
            .where('designerUid', '==', uid)
            .orderBy('createdAt', 'desc')
            .get();
            
        snapshot.forEach(doc => requests.push({ id: doc.id, ...doc.data() }));
        return res.status(200).json({ success: true, data: requests });

    } catch (error) {
        console.error('Error in GET /time-requests:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/time-requests
 * A designer requests additional hours for a project.
 */
timeRequestRouter.post('/', async (req, res) => {
    
    // --- FIX: Add internal auth check ---
    try {
        await util.promisify(verifyToken)(req, res);
    } catch (error) {
        console.error("Auth error in POST /api/time-requests:", error);
        return res.status(401).json({ success: false, error: 'Authentication failed', message: error.message });
    }
    // --- End of Fix ---

    try {
        const { projectId, requestedHours, reason, pendingTimesheetData } = req.body;
        const { uid, name, email } = req.user;

        if (!projectId || !requestedHours || !reason) {
            return res.status(400).json({ success: false, error: 'Missing required fields.' });
        }

        // Get project info
        const projectDoc = await db.collection('projects').doc(projectId).get();
        if (!projectDoc.exists) {
            return res.status(404).json({ success: false, error: 'Project not found.' });
        }
        const projectData = projectDoc.data();
        const currentHoursLogged = await getAggregatedProjectHours(projectId);

        const newRequest = {
            designerUid: uid,
            designerName: name,
            designerEmail: email,
            projectId,
            projectName: projectData.projectName,
            projectCode: projectData.projectCode,
            clientCompany: projectData.clientCompany,
            designLeadName: projectData.designLeadName || null,
            requestedHours: Number(requestedHours),
            reason,
            currentHoursLogged,
            currentAllocatedHours: (projectData.maxAllocatedHours || 0) + (projectData.additionalHours || 0),
            status: 'pending',
            pendingTimesheetData: pendingTimesheetData || null,
            createdAt: FieldValue.serverTimestamp()
        };

        const docRef = await db.collection('time-requests').add(newRequest);

        return res.status(201).json({ success: true, data: { id: docRef.id } });

    } catch (error) {
        console.error('Error in POST /time-requests:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * PUT /api/time-requests?id=...
 * COO/Director approves or rejects a time request.
 */
timeRequestRouter.put('/', async (req, res) => {
    
    // --- FIX: Add internal auth check ---
    try {
        await util.promisify(verifyToken)(req, res);
    } catch (error) {
        console.error("Auth error in PUT /api/time-requests:", error);
        return res.status(401).json({ success: false, error: 'Authentication failed', message: error.message });
    }
    // --- End of Fix ---

    try {
        const { id } = req.query;
        const { action, approvedHours, comment, applyToTimesheet } = req.body;
        const { uid, name } = req.user; // Reviewer

        if (!id || !action) {
            return res.status(400).json({ success: false, error: 'Missing request ID or action.' });
        }

        const requestRef = db.collection('time-requests').doc(id);
        const requestDoc = await requestRef.get();

        if (!requestDoc.exists) {
            return res.status(404).json({ success: false, error: 'Time request not found.' });
        }

        const requestData = requestDoc.data();
        const projectRef = db.collection('projects').doc(requestData.projectId);

        const updateData = {
            status: action === 'approve' ? 'approved' : (action === 'reject' ? 'rejected' : 'info_requested'),
            reviewComment: comment || null,
            reviewedBy: name,
            reviewedByUid: uid,
            reviewedAt: FieldValue.serverTimestamp()
        };

        if (action === 'approve') {
            if (!approvedHours || approvedHours <= 0) {
                return res.status(400).json({ success: false, error: 'Invalid approved hours.' });
            }
            updateData.approvedHours = Number(approvedHours);

            // --- 1. Update Project's Additional Hours ---
            await projectRef.update({
                additionalHours: FieldValue.increment(Number(approvedHours))
            });

            // --- 2. If a timesheet was pending, add it now ---
            if (applyToTimesheet && requestData.pendingTimesheetData) {
                const tsData = requestData.pendingTimesheetData;
                const newEntry = {
                    ...tsData,
                    date: new Date(tsData.date),
                    hours: Number(tsData.hours),
                    projectId: requestData.projectId,
                    projectName: requestData.projectName,
                    projectCode: requestData.projectCode,
                    designerUid: requestData.designerUid,
                    designerName: requestData.designerName,
                    designerEmail: requestData.designerEmail,
                    status: 'approved',
                    relatedTimeRequestId: id,
                    createdAt: FieldValue.serverTimestamp()
                };
                await db.collection('timesheets').add(newEntry);
                // Trigger an update of the project's logged hours
                await updateProjectHoursLogged(requestData.projectId);
            }
        }

        // --- 3. Update the Time Request itself ---
        await requestRef.update(updateData);

        return res.status(200).json({ success: true, data: updateData });

    } catch (error) {
        console.error('Error in PUT /time-requests:', error);
        // --- THIS IS THE LINE WITH THE SYNTAX ERROR ---
        // I have fixed it to be a proper return statement.
        return res.status(500).json({ 
            success: false, 
            error: 'Internal server error.'
        });
    }
});


// Export both routers
module.exports = {
    timesheetsRouter,
    timeRequestRouter
};
