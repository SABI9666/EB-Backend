const express = require('express');
const admin = require('./_firebase-admin');
const db = admin.firestore();
const { FieldValue } = require('firebase-admin/firestore');
const { verifyToken } = require('../middleware/auth');
const util = require('util');

const timesheetsRouter = express.Router();
const timeRequestRouter = express.Router();

// ============================================
// NON-PROJECT WORK TYPES (Training / Sample Designing)
// ============================================
const NON_PROJECT_WORK_TYPES = ['training', 'sample_designing'];
const NON_PROJECT_IDS = ['TRAINING', 'SAMPLE_DESIGNING'];

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
            // Fetch subcontracted proposals
            const subcontractedSnapshot = await db.collection('proposals').where('status', '==', 'subcontracted').get();

            let allTimesheets = [];
            timesheetsSnapshot.forEach(doc => allTimesheets.push({ id: doc.id, ...doc.data() }));

            let allDesigners = {};
            designersSnapshot.forEach(doc => {
                allDesigners[doc.id] = { id: doc.id, ...doc.data(), totalHours: 0, projectsWorkedOn: new Set() };
            });

            // Build subcontractor data
            const subcontractorProjects = [];
            const subcontractorRevenueByCurrency = { USD: 0, GBP: 0, CAD: 0, AUD: 0 };
            let totalSubcontractorRevenue = 0;
            subcontractedSnapshot.forEach(doc => {
                const data = doc.data();
                const val = parseFloat(data.pricing?.quoteValue) || 0;
                const rawCurrency = (data.pricing?.currency || 'USD').toUpperCase().trim();
                const cur = rawCurrency === 'POUNDS' || rawCurrency === 'GBP' ? 'GBP'
                    : rawCurrency === 'AUS' || rawCurrency === 'AUD' ? 'AUD'
                    : rawCurrency === 'CAD' ? 'CAD'
                    : rawCurrency === 'USD' ? 'USD'
                    : rawCurrency;
                if (!subcontractorRevenueByCurrency[cur]) subcontractorRevenueByCurrency[cur] = 0;
                subcontractorRevenueByCurrency[cur] += val;
                totalSubcontractorRevenue += val;
                subcontractorProjects.push({
                    projectName: data.projectName || 'N/A',
                    clientCompany: data.clientCompany || 'N/A',
                    quoteValue: val,
                    currency: cur,
                    subcontractorName: data.subcontractorDetails?.name || 'N/A',
                    subcontractorNotes: data.subcontractorDetails?.notes || '',
                    status: 'subcontracted'
                });
            });

            let projectHours = {};
            projectsSnapshot.forEach(doc => {
                const data = doc.data();
                projectHours[doc.id] = {
                    id: doc.id,
                    ...data,
                    allocatedHours: data.maxAllocatedHours || 0,
                    hoursLogged: 0,
                    projectSection: data.projectSection || 'Unassigned',
                    quoteValue: parseFloat(data.quoteValue) || 0,
                    currency: data.currency || 'AED',
                    isAllocated: data.designStatus === 'allocated' || data.status === 'assigned' || data.status === 'in_progress' || data.status === 'completed',
                };
            });

            // Build per-project designer hours map
            // { projectId: { designerUid: { name, email, hours } } }
            const projectDesignerHours = {};

            allTimesheets.forEach(ts => {
                if (projectHours[ts.projectId]) {
                    projectHours[ts.projectId].hoursLogged += ts.hours || 0;
                }
                if (allDesigners[ts.designerUid]) {
                    allDesigners[ts.designerUid].totalHours += ts.hours || 0;
                    allDesigners[ts.designerUid].projectsWorkedOn.add(ts.projectId);
                }
                // Track per-project designer hours
                if (ts.projectId && ts.designerUid) {
                    if (!projectDesignerHours[ts.projectId]) {
                        projectDesignerHours[ts.projectId] = {};
                    }
                    if (!projectDesignerHours[ts.projectId][ts.designerUid]) {
                        projectDesignerHours[ts.projectId][ts.designerUid] = {
                            name: ts.designerName || (allDesigners[ts.designerUid] ? allDesigners[ts.designerUid].name : 'Unknown'),
                            email: allDesigners[ts.designerUid] ? allDesigners[ts.designerUid].email : '',
                            hours: 0
                        };
                    }
                    projectDesignerHours[ts.projectId][ts.designerUid].hours += ts.hours || 0;
                }
            });

            const projects = Object.values(projectHours);
            const designers = Object.values(allDesigners).map(d => ({
                ...d,
                projectsWorkedOn: d.projectsWorkedOn.size,
            }));

            // Section-wise breakdown (only allocated projects)
            const initRevenueByCurrency = () => ({ USD: 0, GBP: 0, CAD: 0, AUD: 0 });
            const sectionBreakdown = {
                Engineering: { count: 0, revenue: 0, revenueByCurrency: initRevenueByCurrency(), hoursAllocated: 0, hoursLogged: 0, projects: [] },
                Rebar: { count: 0, revenue: 0, revenueByCurrency: initRevenueByCurrency(), hoursAllocated: 0, hoursLogged: 0, projects: [] },
                Structural: { count: 0, revenue: 0, revenueByCurrency: initRevenueByCurrency(), hoursAllocated: 0, hoursLogged: 0, projects: [] },
                Unassigned: { count: 0, revenue: 0, revenueByCurrency: initRevenueByCurrency(), hoursAllocated: 0, hoursLogged: 0, projects: [] }
            };

            // Total revenue by currency (only allocated projects)
            const totalRevenueByCurrency = { USD: 0, GBP: 0, CAD: 0, AUD: 0 };

            // Count allocated projects
            const allocatedProjects = projects.filter(p => p.isAllocated);

            let metrics = {
                totalProjects: projects.length,
                allocatedProjects: allocatedProjects.length,
                pendingAllocationProjects: projects.length - allocatedProjects.length,
                subcontractorProjects: subcontractorProjects.length,
                projectsWithTimeline: 0,
                projectsAboveTimeline: 0,
                totalExceededHours: 0,
                totalAllocatedHours: 0,
                totalLoggedHours: 0,
                totalRevenue: 0,
                totalSubcontractorRevenue: totalSubcontractorRevenue,
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

                // Normalize currency key
                const rawCurrency = (p.currency || 'USD').toUpperCase().trim();
                const currencyKey = rawCurrency === 'AED' ? 'AED'
                    : rawCurrency === 'POUNDS' || rawCurrency === 'GBP' ? 'GBP'
                    : rawCurrency === 'AUS' || rawCurrency === 'AUD' || rawCurrency === 'AUS CAD' ? 'AUD'
                    : rawCurrency === 'CAD' ? 'CAD'
                    : rawCurrency;

                // Only include allocated projects in section breakdown and revenue
                if (p.isAllocated) {
                    const section = sectionBreakdown[p.projectSection] || sectionBreakdown['Unassigned'];
                    section.count++;
                    section.revenue += p.quoteValue || 0;
                    section.hoursAllocated += p.allocatedHours || 0;
                    section.hoursLogged += p.hoursLogged || 0;

                    // Add to section currency breakdown
                    if (!section.revenueByCurrency[currencyKey]) section.revenueByCurrency[currencyKey] = 0;
                    section.revenueByCurrency[currencyKey] += p.quoteValue || 0;
                    // Add to total currency breakdown
                    if (!totalRevenueByCurrency[currencyKey]) totalRevenueByCurrency[currencyKey] = 0;
                    totalRevenueByCurrency[currencyKey] += p.quoteValue || 0;

                    // Total revenue (allocated only)
                    metrics.totalRevenue += p.quoteValue || 0;
                }

                // Attach per-project designer hours with allocated hours
                const loggedMap = projectDesignerHours[p.id] || {};
                const allocMap = p.designerHours || {};
                const designerNames = p.assignedDesignerNames || [];
                const designerUids = p.assignedDesigners || [];
                // Merge allocated and logged hours for each designer
                const mergedDesigners = {};
                // Add designers from allocation map
                Object.entries(allocMap).forEach(([uid, allocHrs]) => {
                    const idx = designerUids.indexOf(uid);
                    const name = idx >= 0 && designerNames[idx] ? designerNames[idx] : (allDesigners[uid] ? allDesigners[uid].name : 'Unknown');
                    mergedDesigners[uid] = {
                        name: name,
                        allocatedHours: parseFloat(allocHrs) || 0,
                        hoursLogged: 0
                    };
                });
                // Add/update from logged hours
                Object.entries(loggedMap).forEach(([uid, detail]) => {
                    if (mergedDesigners[uid]) {
                        mergedDesigners[uid].hoursLogged = detail.hours || 0;
                        if (!mergedDesigners[uid].name || mergedDesigners[uid].name === 'Unknown') {
                            mergedDesigners[uid].name = detail.name;
                        }
                    } else {
                        mergedDesigners[uid] = {
                            name: detail.name || 'Unknown',
                            allocatedHours: 0,
                            hoursLogged: detail.hours || 0
                        };
                    }
                });
                p.designerHoursDetail = Object.values(mergedDesigners);

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

            // ============================================
            // Revenue by Period (Monthly, Quarterly, Yearly)
            // ============================================
            const now = new Date();
            const currentYear = now.getFullYear();
            const currentMonth = now.getMonth(); // 0-indexed
            const currentQuarter = Math.floor(currentMonth / 3); // 0-3

            // Helper to get Date from Firestore timestamp
            const toDate = (ts) => {
                if (!ts) return null;
                if (ts.seconds) return new Date(ts.seconds * 1000);
                if (ts._seconds) return new Date(ts._seconds * 1000);
                if (typeof ts === 'string') return new Date(ts);
                if (ts instanceof Date) return ts;
                return null;
            };

            // Initialize period revenue structures
            const initCurrMap = () => ({ USD: 0, GBP: 0, CAD: 0, AUD: 0 });

            // Monthly: last 12 months
            const monthlyRevenue = {};
            for (let i = 0; i < 12; i++) {
                const d = new Date(currentYear, currentMonth - i, 1);
                const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
                monthlyRevenue[key] = { label: d.toLocaleString('en-US', { month: 'short', year: 'numeric' }), revenue: initCurrMap(), count: 0 };
            }

            // Quarterly: last 4 quarters
            const quarterlyRevenue = {};
            for (let i = 0; i < 4; i++) {
                const q = ((currentQuarter - i) % 4 + 4) % 4;
                const y = currentYear - (currentQuarter - i < 0 ? 1 : 0);
                const key = `${y}-Q${q + 1}`;
                const qMonths = ['Jan-Mar', 'Apr-Jun', 'Jul-Sep', 'Oct-Dec'];
                quarterlyRevenue[key] = { label: `Q${q + 1} ${y} (${qMonths[q]})`, revenue: initCurrMap(), count: 0 };
            }

            // Yearly: last 3 years
            const yearlyRevenue = {};
            for (let i = 0; i < 3; i++) {
                const y = currentYear - i;
                yearlyRevenue[y] = { label: String(y), revenue: initCurrMap(), count: 0 };
            }

            // Populate period revenue from allocated projects only
            projects.forEach(p => {
                if (!p.isAllocated) return; // Skip non-allocated projects
                const projectDate = toDate(p.allocationDate) || toDate(p.createdAt);
                if (!projectDate) return;

                const pYear = projectDate.getFullYear();
                const pMonth = projectDate.getMonth();
                const pQuarter = Math.floor(pMonth / 3);
                const val = p.quoteValue || 0;
                if (val <= 0) return;

                const rawCurrency = (p.currency || 'USD').toUpperCase().trim();
                const cur = rawCurrency === 'POUNDS' || rawCurrency === 'GBP' ? 'GBP'
                    : rawCurrency === 'AUS' || rawCurrency === 'AUD' ? 'AUD'
                    : rawCurrency === 'CAD' ? 'CAD'
                    : rawCurrency === 'USD' ? 'USD'
                    : rawCurrency;

                // Monthly
                const mKey = `${pYear}-${String(pMonth + 1).padStart(2, '0')}`;
                if (monthlyRevenue[mKey]) {
                    if (!monthlyRevenue[mKey].revenue[cur]) monthlyRevenue[mKey].revenue[cur] = 0;
                    monthlyRevenue[mKey].revenue[cur] += val;
                    monthlyRevenue[mKey].count++;
                }

                // Quarterly
                const qKey = `${pYear}-Q${pQuarter + 1}`;
                if (quarterlyRevenue[qKey]) {
                    if (!quarterlyRevenue[qKey].revenue[cur]) quarterlyRevenue[qKey].revenue[cur] = 0;
                    quarterlyRevenue[qKey].revenue[cur] += val;
                    quarterlyRevenue[qKey].count++;
                }

                // Yearly
                if (yearlyRevenue[pYear]) {
                    if (!yearlyRevenue[pYear].revenue[cur]) yearlyRevenue[pYear].revenue[cur] = 0;
                    yearlyRevenue[pYear].revenue[cur] += val;
                    yearlyRevenue[pYear].count++;
                }
            });

            const revenuePeriods = {
                monthly: Object.values(monthlyRevenue).reverse(),
                quarterly: Object.values(quarterlyRevenue).reverse(),
                yearly: Object.values(yearlyRevenue).reverse()
            };

            return res.status(200).json({
                success: true,
                data: { metrics, projects, sectionBreakdown, totalRevenueByCurrency, revenuePeriods,
                    subcontractorData: {
                        projects: subcontractorProjects,
                        revenueByCurrency: subcontractorRevenueByCurrency,
                        totalRevenue: totalSubcontractorRevenue,
                        count: subcontractorProjects.length
                    },
                    designers: designers.map(d => ({
                    name: d.name, email: d.email, totalHours: d.totalHours, projectsWorkedOn: d.projectsWorkedOn,
                })), analytics }
            });

        } catch (error) {
            console.error('Error in GET /timesheets (executive_dashboard):', error);
            return res.status(500).json({ success: false, error: error.message });
        }
    }

    if (action === 'all') {
        if (!['coo', 'director', 'hr'].includes(userRole)) {
            return res.status(403).json({ success: false, error: 'Access denied. COO/Director/HR only.' });
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
        if (!['coo', 'director', 'hr'].includes(userRole)) {
            return res.status(403).json({ success: false, error: 'Access denied. COO/Director/HR only.' });
        }

        try {
            const timesheetsSnapshot = await db.collection('timesheets').get();
            const designersSnapshot = await db.collection('users').where('role', '==', 'designer').get();
            const projectsSnapshot = await db.collection('projects').get();

            const designerLookup = {};
            designersSnapshot.forEach(doc => {
                const data = doc.data();
                designerLookup[doc.id] = { uid: doc.id, name: data.name, email: data.email };
            });

            // Build project lookup for names/codes
            const projectLookup = {};
            projectsSnapshot.forEach(doc => {
                const data = doc.data();
                projectLookup[doc.id] = {
                    projectName: data.projectName || 'Unknown',
                    projectCode: data.projectCode || '',
                    clientCompany: data.clientCompany || '',
                    projectSection: data.projectSection || 'Unassigned',
                    designLeadName: data.designLeadName || '',
                    maxAllocatedHours: data.maxAllocatedHours || 0,
                    quoteValue: parseFloat(data.quoteValue) || 0,
                    currency: data.currency || 'USD'
                };
            });

            const designerMap = {};
            const weeklyBreakdown = {};
            const monthlyBreakdown = {};
            // Project-based tracking
            const projectMap = {};

            timesheetsSnapshot.forEach(doc => {
                const entry = doc.data();
                const dUid = entry.designerUid;
                const designerName = entry.designerName || designerLookup[dUid]?.name || 'Unknown';
                const designerEmail = entry.designerEmail || designerLookup[dUid]?.email || '';
                const hours = parseFloat(entry.hours) || 0;
                const projectId = entry.projectId || 'UNKNOWN';
                const projectName = entry.projectName || projectLookup[projectId]?.projectName || 'Unknown Project';

                const entryDate = parseDate(entry.date);
                if (!entryDate || isNaN(entryDate.getTime())) return;

                const weekStart = getWeekStart(entryDate);
                const weekKey = weekStart.toISOString().split('T')[0];
                const monthStart = getMonthStart(entryDate);
                const monthKey = monthStart.toISOString().split('T')[0];
                const dayKey = entryDate.toISOString().split('T')[0];

                // --- Project-based tracking ---
                if (!projectMap[projectId]) {
                    const pInfo = projectLookup[projectId] || {};
                    projectMap[projectId] = {
                        projectId,
                        projectName: pInfo.projectName || projectName,
                        projectCode: pInfo.projectCode || '',
                        clientCompany: pInfo.clientCompany || '',
                        projectSection: pInfo.projectSection || 'Unassigned',
                        designLeadName: pInfo.designLeadName || '',
                        maxAllocatedHours: pInfo.maxAllocatedHours || 0,
                        quoteValue: pInfo.quoteValue || 0,
                        currency: pInfo.currency || 'USD',
                        totalHours: 0,
                        designers: {},
                        monthlyHours: {},
                        weeklyHours: {}
                    };
                }
                projectMap[projectId].totalHours += hours;

                // Per-designer within project
                if (!projectMap[projectId].designers[dUid]) {
                    projectMap[projectId].designers[dUid] = {
                        name: designerName,
                        email: designerEmail,
                        totalHours: 0,
                        monthlyHours: {}
                    };
                }
                projectMap[projectId].designers[dUid].totalHours += hours;
                projectMap[projectId].designers[dUid].monthlyHours[monthKey] = (projectMap[projectId].designers[dUid].monthlyHours[monthKey] || 0) + hours;

                // Project monthly total
                projectMap[projectId].monthlyHours[monthKey] = (projectMap[projectId].monthlyHours[monthKey] || 0) + hours;
                // Project weekly total
                projectMap[projectId].weeklyHours[weekKey] = (projectMap[projectId].weeklyHours[weekKey] || 0) + hours;
                
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

            // Build project-based report
            const allMonthKeys = [...new Set(Object.values(projectMap).flatMap(p => Object.keys(p.monthlyHours)))].sort();
            const projectReport = Object.values(projectMap).map(p => ({
                projectId: p.projectId,
                projectName: p.projectName,
                projectCode: p.projectCode,
                clientCompany: p.clientCompany,
                projectSection: p.projectSection,
                designLeadName: p.designLeadName,
                maxAllocatedHours: p.maxAllocatedHours,
                quoteValue: p.quoteValue,
                currency: p.currency,
                totalHours: Math.round(p.totalHours * 100) / 100,
                monthlyHours: p.monthlyHours,
                designers: Object.values(p.designers).map(d => ({
                    name: d.name,
                    email: d.email,
                    totalHours: Math.round(d.totalHours * 100) / 100,
                    monthlyHours: d.monthlyHours
                })).sort((a, b) => b.totalHours - a.totalHours)
            })).sort((a, b) => b.totalHours - a.totalHours);

            return res.status(200).json({
                success: true,
                data: { designers: designerStats, weeklyTotals, monthlyTotals, summary, projectReport, allMonthKeys }
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
        const { projectId, date, hours, description, workType, isNonProjectWork } = req.body;
        const { uid, name, email } = req.user;

        // Validate common required fields
        if (!date || !hours || !description) {
            return res.status(400).json({ success: false, error: 'Missing required fields (date, hours, description).' });
        }

        // ============================================
        // HANDLE NON-PROJECT WORK (Training / Sample Designing)
        // ============================================
        if (isNonProjectWork || NON_PROJECT_WORK_TYPES.includes(workType) || NON_PROJECT_IDS.includes(projectId)) {
            console.log(`📚 Logging non-project work: ${workType || projectId} for ${name}`);
            
            const isTraining = workType === 'training' || projectId === 'TRAINING';
            const workTypeLabel = isTraining ? 'Training' : 'Sample Designing';
            
            const newEntry = {
                projectId: isTraining ? 'TRAINING' : 'SAMPLE_DESIGNING',
                projectName: workTypeLabel,
                projectCode: isTraining ? 'TRAINING' : 'SAMPLE',
                workType: isTraining ? 'training' : 'sample_designing',
                isNonProjectWork: true,
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
            console.log(`✅ Non-project timesheet created: ${docRef.id}`);
            
            return res.status(201).json({ success: true, data: { id: docRef.id, ...newEntry } });
        }

        // ============================================
        // HANDLE PROJECT WORK (Original Logic - Unchanged)
        // ============================================
        if (!projectId) {
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

// ============================================
// PUT - Update/Edit Timesheet Entry
// Allows designers to edit their own pending entries (hours, project, date, description)
// ============================================
timesheetsRouter.put('/', async (req, res) => {
    
    try {
        await util.promisify(verifyToken)(req, res);
    } catch (error) {
        console.error("Auth error in PUT /api/timesheets:", error);
        return res.status(401).json({ success: false, error: 'Authentication failed', message: error.message });
    }

    try {
        const { id } = req.query;
        const { uid, name, email } = req.user;
        const { projectId, hours, date, description } = req.body;

        if (!id) {
            return res.status(400).json({ success: false, error: 'Missing timesheet ID.' });
        }

        const docRef = db.collection('timesheets').doc(id);
        const doc = await docRef.get();

        if (!doc.exists) {
            return res.status(404).json({ success: false, error: 'Timesheet entry not found.' });
        }

        const existingData = doc.data();

        // Only the owner can edit their entry
        if (existingData.designerUid !== uid) {
            return res.status(403).json({ success: false, error: 'You are not authorized to edit this entry.' });
        }

        const oldProjectId = existingData.projectId;
        const oldHours = existingData.hours || 0;

        // Build update object
        const updateData = {
            updatedAt: FieldValue.serverTimestamp()
        };

        // Update hours if provided
        if (hours !== undefined && hours !== null) {
            const newHours = Number(hours);
            if (isNaN(newHours) || newHours <= 0) {
                return res.status(400).json({ success: false, error: 'Invalid hours value.' });
            }
            if (newHours > 24) {
                return res.status(400).json({ success: false, error: 'Hours cannot exceed 24 per entry.' });
            }
            updateData.hours = newHours;
        }

        // Update date if provided
        if (date) {
            updateData.date = new Date(date);
        }

        // Update description if provided
        if (description !== undefined) {
            updateData.description = description;
        }

        // Update project if provided (project change)
        let newProjectId = oldProjectId;
        if (projectId && projectId !== oldProjectId) {
            // Validate new project exists and designer has access
            if (!NON_PROJECT_IDS.includes(projectId)) {
                const projectDoc = await db.collection('projects').doc(projectId).get();
                if (!projectDoc.exists) {
                    return res.status(404).json({ success: false, error: 'New project not found.' });
                }
                const projectData = projectDoc.data();
                
                // Check if designer is assigned to this project
                const assignedDesigners = projectData.assignedDesigners || [];
                const assignedDesignerUids = projectData.assignedDesignerUids || [];
                if (!assignedDesigners.includes(uid) && !assignedDesignerUids.includes(uid)) {
                    return res.status(403).json({ success: false, error: 'You are not assigned to this project.' });
                }

                updateData.projectId = projectId;
                updateData.projectName = projectData.projectName;
                updateData.projectCode = projectData.projectCode || '';
                newProjectId = projectId;
            } else {
                // Handle non-project work types (Training, Sample Designing)
                updateData.projectId = projectId;
                updateData.projectName = projectId === 'TRAINING' ? 'Training' : 'Sample Designing';
                updateData.projectCode = projectId;
                newProjectId = projectId;
            }
        }

        // Perform the update
        await docRef.update(updateData);

        // Update hours logged on affected projects
        // If project changed, update both old and new project hours
        if (newProjectId !== oldProjectId) {
            // Update old project (decrease hours)
            if (oldProjectId && !NON_PROJECT_IDS.includes(oldProjectId)) {
                await updateProjectHoursLogged(oldProjectId);
            }
            // Update new project (increase hours)
            if (newProjectId && !NON_PROJECT_IDS.includes(newProjectId)) {
                await updateProjectHoursLogged(newProjectId);
            }
        } else if (updateData.hours !== undefined && updateData.hours !== oldHours) {
            // Same project but hours changed
            if (oldProjectId && !NON_PROJECT_IDS.includes(oldProjectId)) {
                await updateProjectHoursLogged(oldProjectId);
            }
        }

        console.log(`✅ Timesheet ${id} updated by ${name}`);
        return res.status(200).json({ 
            success: true, 
            message: 'Timesheet entry updated successfully.',
            data: { id, ...existingData, ...updateData }
        });

    } catch (error) {
        console.error('Error in PUT /timesheets:', error);
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

        // Only update project hours for real projects (not Training/Sample Designing)
        if (projectId && !NON_PROJECT_IDS.includes(projectId)) {
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
