const express = require('express');
const admin = require('./_firebase-admin');
const db = admin.firestore();
const { FieldValue } = require('firebase-admin/firestore');
const { verifyToken } = require('../middleware/auth');
const util = require('util');

const timesheetsRouter = express.Router();
const timeRequestRouter = express.Router();

const getAggregatedProjectHours = async (projectId) => {
    try {
        const timesheetsSnapshot = await db.collection('timesheets')
            .where('projectId', '==', projectId)
            .get();
        
        if (timesheetsSnapshot.empty) return 0;

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

const updateProjectHoursLogged = async (projectId) => {
    try {
        const totalHours = await getAggregatedProjectHours(projectId);
        await db.collection('projects').doc(projectId).update({
            hoursLogged: totalHours
        });
        console.log(`Updated project ${projectId} to ${totalHours} logged hours.`);
    } catch (error) {
        console.error(`Error updating project ${projectId} hours:`, error);
    }
};

const getWeekStart = (date) => {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    return new Date(d.setDate(diff));
};

const getMonthStart = (date) => {
    const d = new Date(date);
    return new Date(d.getFullYear(), d.getMonth(), 1);
};

const formatWeekLabel = (weekStart) => {
    const start = new Date(weekStart);
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${months[start.getMonth()]} ${start.getDate()}-${end.getDate()}`;
};

const formatMonthLabel = (monthStart) => {
    const d = new Date(monthStart);
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 
                    'July', 'August', 'September', 'October', 'November', 'December'];
    return `${months[d.getMonth()]} ${d.getFullYear()}`;
};

const parseDate = (dateValue) => {
    if (!dateValue) return null;
    
    if (dateValue.seconds !== undefined) {
        return new Date(dateValue.seconds * 1000);
    } else if (dateValue._seconds !== undefined) {
        return new Date(dateValue._seconds * 1000);
    } else if (typeof dateValue === 'string') {
        return new Date(dateValue);
    } else if (dateValue instanceof Date) {
        return dateValue;
    } else if (typeof dateValue === 'number') {
        return new Date(dateValue);
    }
    return null;
};

timesheetsRouter.get('/', async (req, res) => {
    
    try {
        await util.promisify(verifyToken)(req, res);
    } catch (error) {
        console.error("Auth error in GET /api/timesheets:", error);
        return res.status(401).json({ success: false, error: 'Authentication failed', message: error.message });
    }

    const { action, projectId } = req.query;
    const designerUid = req.user.uid;
    const userRole = req.user.role;

    if (action === 'executive_dashboard') {
        try {
            const projectsSnapshot = await db.collection('projects').get();
            const timesheetsSnapshot = await db.collection('timesheets').get();
            const designersSnapshot = await db.collection('users').where('role', '==', 'designer').get();

            let allTimesheets = [];
            timesheetsSnapshot.forEach(doc => allTimesheets.push({ id: doc.id, ...doc.data() }));

            let allDesigners = {};
            designersSnapshot.forEach(doc => {
                allDesigners[doc.id] = { id: doc.id, ...doc.data(), totalHours: 0, projectsWorkedOn: new Set() };
            });

            let projectHours = {};
            projectsSnapshot.forEach(doc => {
                const data = doc.data();
                projectHours[doc.id] = {
                    id: doc.id,
                    ...data,
                    allocatedHours: data.maxAllocatedHours || 0,
                    hoursLogged: 0,
                };
            });

            allTimesheets.forEach(ts => {
                if (projectHours[ts.projectId]) {
                    projectHours[ts.projectId].hoursLogged += ts.hours || 0;
                }
                if (allDesigners[ts.designerUid]) {
                    allDesigners[ts.designerUid].totalHours += ts.hours || 0;
                    allDesigners[ts.designerUid].projectsWorkedOn.add(ts.projectId);
                }
            });

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
                const statusKey = p.status || 'unknown';
                analytics.projectStatusDistribution[statusKey] = (analytics.projectStatusDistribution[statusKey] || 0) + 1;
                
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
                    p.isExceeded = false;
                    p.exceededBy = 0;
                    p.percentageUsed = 0;
                }
            });

            metrics.averageHoursPerProject = projects.length > 0 ? (metrics.totalLoggedHours / projects.length) : 0;

            return res.status(200).json({
                success: true,
                data: { metrics, projects, designers: designers.map(d => ({
                    name: d.name, email: d.email, totalHours: d.totalHours, projectsWorkedOn: d.projectsWorkedOn,
                })), analytics }
            });

        } catch (error) {
            console.error('Error in GET /timesheets (executive_dashboard):', error);
            return res.status(500).json({ success: false, error: error.message });
        }
    }

    if (action === 'all') {
        if (!['coo', 'director', 'hr', 'bdm'].includes(userRole)) {
            return res.status(403).json({ success: false, error: 'Access denied. Management only.' });
        }
        
        try {
            const timesheets = [];
            const snapshot = await db.collection('timesheets')
                .orderBy('date', 'desc')
                .get();
            
            snapshot.forEach(doc => {
                const data = doc.data();
                timesheets.push({ id: doc.id, ...data, date: data.date });
            });
            
            return res.status(200).json({ success: true, data: timesheets });
        } catch (error) {
            console.error('Error in GET /timesheets (all):', error);
            return res.status(500).json({ success: false, error: error.message });
        }
    }

    if (action === 'designer_weekly_report') {
        if (!['coo', 'director', 'hr', 'bdm'].includes(userRole)) {
            return res.status(403).json({ success: false, error: 'Access denied. Management only.' });
        }
        
        try {
            const timesheetsSnapshot = await db.collection('timesheets').get();
            const designersSnapshot = await db.collection('users').where('role', '==', 'designer').get();
            
            const designerLookup = {};
            designersSnapshot.forEach(doc => {
                const data = doc.data();
                designerLookup[doc.id] = { uid: doc.id, name: data.name, email: data.email };
            });
            
            const designerMap = {};
            const weeklyBreakdown = {};
            const monthlyBreakdown = {};
            
            timesheetsSnapshot.forEach(doc => {
                const entry = doc.data();
                const dUid = entry.designerUid;
                const designerName = entry.designerName || designerLookup[dUid]?.name || 'Unknown';
                const designerEmail = entry.designerEmail || designerLookup[dUid]?.email || '';
                const hours = parseFloat(entry.hours) || 0;
                
                const entryDate = parseDate(entry.date);
                if (!entryDate || isNaN(entryDate.getTime())) return;
                
                const weekStart = getWeekStart(entryDate);
                const weekKey = weekStart.toISOString().split('T')[0];
                const monthStart = getMonthStart(entryDate);
                const monthKey = monthStart.toISOString().split('T')[0];
                const dayKey = entryDate.toISOString().split('T')[0];
                
                if (!designerMap[dUid]) {
                    designerMap[dUid] = {
                        uid: dUid,
                        name: designerName,
                        email: designerEmail,
                        totalHours: 0,
                        weeklyHours: {},
                        monthlyHours: {},
                        dailyHours: {},
                        projectsWorked: new Set(),
                        workingDays: new Set()
                    };
                }
                
                designerMap[dUid].totalHours += hours;
                designerMap[dUid].weeklyHours[weekKey] = (designerMap[dUid].weeklyHours[weekKey] || 0) + hours;
                designerMap[dUid].monthlyHours[monthKey] = (designerMap[dUid].monthlyHours[monthKey] || 0) + hours;
                designerMap[dUid].dailyHours[dayKey] = (designerMap[dUid].dailyHours[dayKey] || 0) + hours;
                designerMap[dUid].workingDays.add(dayKey);
                if (entry.projectId) {
                    designerMap[dUid].projectsWorked.add(entry.projectId);
                }
                
                if (!weeklyBreakdown[weekKey]) {
                    weeklyBreakdown[weekKey] = { total: 0, designerCount: new Set() };
                }
                weeklyBreakdown[weekKey].total += hours;
                weeklyBreakdown[weekKey].designerCount.add(dUid);
                
                if (!monthlyBreakdown[monthKey]) {
                    monthlyBreakdown[monthKey] = { total: 0, designerCount: new Set() };
                }
                monthlyBreakdown[monthKey].total += hours;
                monthlyBreakdown[monthKey].designerCount.add(dUid);
            });
            
            const designerStats = Object.values(designerMap).map(d => {
                const weeks = Object.keys(d.weeklyHours);
                const months = Object.keys(d.monthlyHours);
                const totalWeeks = weeks.length || 1;
                const totalMonths = months.length || 1;
                const avgWeeklyHours = d.totalHours / totalWeeks;
                const avgMonthlyHours = d.totalHours / totalMonths;
                const uniqueDays = d.workingDays.size;
                const avgDailyHours = uniqueDays > 0 ? d.totalHours / uniqueDays : 0;
                
                return {
                    uid: d.uid,
                    name: d.name,
                    email: d.email,
                    totalHours: Math.round(d.totalHours * 100) / 100,
                    weeksActive: totalWeeks,
                    monthsActive: totalMonths,
                    avgWeeklyHours: Math.round(avgWeeklyHours * 100) / 100,
                    avgMonthlyHours: Math.round(avgMonthlyHours * 100) / 100,
                    avgDailyHours: Math.round(avgDailyHours * 100) / 100,
                    projectsWorked: d.projectsWorked.size,
                    uniqueWorkingDays: uniqueDays,
                    weeklyHours: d.weeklyHours,
                    monthlyHours: d.monthlyHours
                };
            }).sort((a, b) => b.totalHours - a.totalHours);
            
            const weeklyTotals = Object.entries(weeklyBreakdown)
                .map(([week, data]) => ({
                    week,
                    weekLabel: formatWeekLabel(new Date(week)),
                    total: Math.round(data.total * 100) / 100,
                    designerCount: data.designerCount.size,
                    avgPerDesigner: Math.round((data.total / data.designerCount.size) * 100) / 100
                }))
                .sort((a, b) => new Date(b.week) - new Date(a.week))
                .slice(0, 16)
                .reverse();
            
            const monthlyTotals = Object.entries(monthlyBreakdown)
                .map(([month, data]) => ({
                    month,
                    monthLabel: formatMonthLabel(new Date(month)),
                    total: Math.round(data.total * 100) / 100,
                    designerCount: data.designerCount.size,
                    avgPerDesigner: Math.round((data.total / data.designerCount.size) * 100) / 100
                }))
                .sort((a, b) => new Date(b.month) - new Date(a.month))
                .slice(0, 12)
                .reverse();
            
            const summary = {
                totalDesigners: designerStats.length,
                totalHoursAllTime: Math.round(designerStats.reduce((sum, d) => sum + d.totalHours, 0) * 100) / 100,
                avgHoursPerDesigner: designerStats.length > 0 
                    ? Math.round((designerStats.reduce((sum, d) => sum + d.totalHours, 0) / designerStats.length) * 100) / 100
                    : 0,
                weeksTracked: weeklyTotals.length,
                monthsTracked: monthlyTotals.length
            };
            
            return res.status(200).json({
                success: true,
                data: { designers: designerStats, weeklyTotals, monthlyTotals, summary }
            });
            
        } catch (error) {
            console.error('Error in GET /timesheets (designer_weekly_report):', error);
            return res.status(500).json({ success: false, error: error.message });
        }
    }

    if (action === 'my_analytics') {
        try {
            const timesheets = [];
            const snapshot = await db.collection('timesheets')
                .where('designerUid', '==', designerUid)
                .orderBy('date', 'desc')
                .get();
            
            snapshot.forEach(doc => timesheets.push({ id: doc.id, ...doc.data() }));
            
            const dailyHours = {};
            const weeklyHours = {};
            const monthlyHours = {};
            const projectHours = {};
            let totalHours = 0;
            const workingDays = new Set();
            
            timesheets.forEach(entry => {
                const hours = parseFloat(entry.hours) || 0;
                const entryDate = parseDate(entry.date);
                if (!entryDate || isNaN(entryDate.getTime())) return;
                
                const dayKey = entryDate.toISOString().split('T')[0];
                const weekStart = getWeekStart(entryDate);
                const weekKey = weekStart.toISOString().split('T')[0];
                const monthStart = getMonthStart(entryDate);
                const monthKey = monthStart.toISOString().split('T')[0];
                
                totalHours += hours;
                workingDays.add(dayKey);
                
                if (!dailyHours[dayKey]) {
                    dailyHours[dayKey] = { date: dayKey, hours: 0, entries: [] };
                }
                dailyHours[dayKey].hours += hours;
                dailyHours[dayKey].entries.push({
                    projectName: entry.projectName || 'Unknown',
                    projectCode: entry.projectCode || '',
                    hours: hours,
                    description: entry.description || ''
                });
                
                if (!weeklyHours[weekKey]) {
                    weeklyHours[weekKey] = { 
                        week: weekKey, 
                        weekLabel: formatWeekLabel(weekStart), 
                        hours: 0, 
                        daysWorked: new Set(),
                        projects: new Set()
                    };
                }
                weeklyHours[weekKey].hours += hours;
                weeklyHours[weekKey].daysWorked.add(dayKey);
                if (entry.projectId) weeklyHours[weekKey].projects.add(entry.projectId);
                
                if (!monthlyHours[monthKey]) {
                    monthlyHours[monthKey] = { 
                        month: monthKey, 
                        monthLabel: formatMonthLabel(monthStart), 
                        hours: 0,
                        daysWorked: new Set(),
                        projects: new Set()
                    };
                }
                monthlyHours[monthKey].hours += hours;
                monthlyHours[monthKey].daysWorked.add(dayKey);
                if (entry.projectId) monthlyHours[monthKey].projects.add(entry.projectId);
                
                const projKey = entry.projectId || 'unknown';
                if (!projectHours[projKey]) {
                    projectHours[projKey] = {
                        projectId: entry.projectId,
                        projectName: entry.projectName || 'Unknown',
                        projectCode: entry.projectCode || '',
                        hours: 0,
                        entries: 0
                    };
                }
                projectHours[projKey].hours += hours;
                projectHours[projKey].entries += 1;
            });
            
            const dailyData = Object.values(dailyHours)
                .sort((a, b) => new Date(b.date) - new Date(a.date))
                .slice(0, 30);
            
            const weeklyData = Object.values(weeklyHours)
                .map(w => ({
                    ...w,
                    daysWorked: w.daysWorked.size,
                    projects: w.projects.size,
                    avgPerDay: w.daysWorked.size > 0 ? Math.round((w.hours / w.daysWorked.size) * 100) / 100 : 0
                }))
                .sort((a, b) => new Date(b.week) - new Date(a.week))
                .slice(0, 12);
            
            const monthlyData = Object.values(monthlyHours)
                .map(m => ({
                    ...m,
                    daysWorked: m.daysWorked.size,
                    projects: m.projects.size,
                    avgPerDay: m.daysWorked.size > 0 ? Math.round((m.hours / m.daysWorked.size) * 100) / 100 : 0
                }))
                .sort((a, b) => new Date(b.month) - new Date(a.month))
                .slice(0, 12);
            
            const projectData = Object.values(projectHours)
                .sort((a, b) => b.hours - a.hours);
            
            const uniqueDays = workingDays.size;
            const uniqueWeeks = Object.keys(weeklyHours).length;
            const uniqueMonths = Object.keys(monthlyHours).length;
            
            const summary = {
                totalHours: Math.round(totalHours * 100) / 100,
                totalWorkingDays: uniqueDays,
                totalWeeks: uniqueWeeks,
                totalMonths: uniqueMonths,
                totalProjects: Object.keys(projectHours).length,
                avgDailyHours: uniqueDays > 0 ? Math.round((totalHours / uniqueDays) * 100) / 100 : 0,
                avgWeeklyHours: uniqueWeeks > 0 ? Math.round((totalHours / uniqueWeeks) * 100) / 100 : 0,
                avgMonthlyHours: uniqueMonths > 0 ? Math.round((totalHours / uniqueMonths) * 100) / 100 : 0
            };
            
            const today = new Date();
            const thisWeekKey = getWeekStart(today).toISOString().split('T')[0];
            const thisMonthKey = getMonthStart(today).toISOString().split('T')[0];
            
            const currentPeriod = {
                todayHours: dailyHours[today.toISOString().split('T')[0]]?.hours || 0,
                thisWeekHours: weeklyHours[thisWeekKey]?.hours || 0,
                thisMonthHours: monthlyHours[thisMonthKey]?.hours || 0
            };
            
            return res.status(200).json({
                success: true,
                data: {
                    summary,
                    currentPeriod,
                    daily: dailyData,
                    weekly: weeklyData.reverse(),
                    monthly: monthlyData.reverse(),
                    byProject: projectData
                }
            });
            
        } catch (error) {
            console.error('Error in GET /timesheets (my_analytics):', error);
            return res.status(500).json({ success: false, error: error.message });
        }
    }

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

timesheetsRouter.post('/', async (req, res) => {
    
    try {
        await util.promisify(verifyToken)(req, res);
    } catch (error) {
        console.error("Auth error in POST /api/timesheets:", error);
        return res.status(401).json({ success: false, error: 'Authentication failed', message: error.message });
    }

    try {
        const { projectId, date, hours, description } = req.body;
        const { uid, name, email } = req.user;

        if (!projectId || !date || !hours || !description) {
            return res.status(400).json({ success: false, error: 'Missing required fields.' });
        }

        const projectDoc = await db.collection('projects').doc(projectId).get();
        if (!projectDoc.exists) {
            return res.status(404).json({ success: false, error: 'Project not found.' });
        }

        const projectData = projectDoc.data();
        const totalHours = await getAggregatedProjectHours(projectId);

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
            status: 'approved',
            createdAt: FieldValue.serverTimestamp()
        };

        const docRef = await db.collection('timesheets').add(newEntry);
        await updateProjectHoursLogged(projectId);

        return res.status(201).json({ success: true, data: { id: docRef.id, ...newEntry } });

    } catch (error) {
        console.error('Error in POST /timesheets:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

timesheetsRouter.delete('/', async (req, res) => {
    
    try {
        await util.promisify(verifyToken)(req, res);
    } catch (error) {
        console.error("Auth error in DELETE /api/timesheets:", error);
        return res.status(401).json({ success: false, error: 'Authentication failed', message: error.message });
    }

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

        if (data.designerUid !== uid) {
            return res.status(403).json({ success: false, error: 'You are not authorized to delete this entry.' });
        }

        const projectId = data.projectId;
        await docRef.delete();

        if (projectId) {
            await updateProjectHoursLogged(projectId);
        }

        return res.status(200).json({ success: true, message: 'Timesheet entry deleted.' });

    } catch (error) {
        console.error('Error in DELETE /timesheets:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

timeRequestRouter.get('/', async (req, res) => {
    try {
        await util.promisify(verifyToken)(req, res);
    } catch (error) {
        return res.status(401).json({ success: false, error: 'Authentication failed', message: error.message });
    }

    const { status, id } = req.query;
    const { uid, role } = req.user;

    try {
        if (status === 'pending' && (role === 'coo' || role === 'director')) {
            const requests = [];
            const snapshot = await db.collection('time-requests')
                .where('status', '==', 'pending')
                .orderBy('createdAt', 'desc')
                .get();
            
            snapshot.forEach(doc => requests.push({ id: doc.id, ...doc.data() }));
            return res.status(200).json({ success: true, data: requests });
        }

        if (id && (role === 'coo' || role === 'director')) {
            const doc = await db.collection('time-requests').doc(id).get();
            if (!doc.exists) {
                return res.status(404).json({ success: false, error: 'Request not found.' });
            }
            return res.status(200).json({ success: true, data: { id: doc.id, ...doc.data() } });
        }

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

timeRequestRouter.post('/', async (req, res) => {
    try {
        await util.promisify(verifyToken)(req, res);
    } catch (error) {
        return res.status(401).json({ success: false, error: 'Authentication failed', message: error.message });
    }

    try {
        const { projectId, requestedHours, reason, pendingTimesheetData } = req.body;
        const { uid, name, email } = req.user;

        if (!projectId || !requestedHours || !reason) {
            return res.status(400).json({ success: false, error: 'Missing required fields.' });
        }

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

timeRequestRouter.put('/', async (req, res) => {
    try {
        await util.promisify(verifyToken)(req, res);
    } catch (error) {
        return res.status(401).json({ success: false, error: 'Authentication failed', message: error.message });
    }

    try {
        const { id } = req.query;
        const { action, approvedHours, comment, applyToTimesheet } = req.body;
        const { uid, name } = req.user;

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

            await projectRef.update({
                additionalHours: FieldValue.increment(Number(approvedHours))
            });

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
                await updateProjectHoursLogged(requestData.projectId);
            }
        }

        await requestRef.update(updateData);
        return res.status(200).json({ success: true, data: updateData });

    } catch (error) {
        console.error('Error in PUT /time-requests:', error);
        return res.status(500).json({ success: false, error: 'Internal server error.' });
    }
});

module.exports = { timesheetsRouter, timeRequestRouter };
