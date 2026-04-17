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

const serializeTimestamp = (ts) => {
    if (!ts) return null;
    const d = parseDate(ts);
    return (d && !isNaN(d.getTime())) ? d.toISOString() : null;
};
const serializeEntry = (id, data) => ({
    id, ...data,
    date: serializeTimestamp(data.date),
    createdAt: serializeTimestamp(data.createdAt),
    updatedAt: serializeTimestamp(data.updatedAt)
});

