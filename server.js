// server.js - Complete backend entry point with EMAIL + TIMESHEET + VARIATIONS + TIME-REQUESTS + ALLOCATION-REQUESTS + SCREENING + BDM-ANALYTICS API
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
require('dotenv').config();

const { verifyToken } = require('./middleware/auth.js');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(compression());
app.use(morgan('dev'));

app.use(cors({
    origin: function(origin, callback) {
        if (!origin) return callback(null, true);
        const allowedOrigins = [
            'http://localhost:3000',
            'http://localhost:5500',
            'http://127.0.0.1:5500',
            'https://eb-tracker-frontend.vercel.app',
            'https://eb-tracker-frontend-*.vercel.app',
        ];
        const isAllowed = allowedOrigins.some(allowedOrigin => {
            if (allowedOrigin.includes('*')) {
                const pattern = allowedOrigin.replace('*', '.*');
                return new RegExp(pattern).test(origin);
            }
            return allowedOrigin === origin;
        });
        if (isAllowed || origin.includes('vercel.app')) {
            callback(null, true);
        } else {
            console.log('⚠️ CORS blocked origin:', origin);
            callback(null, true);
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type','Authorization','X-Requested-With','Accept','Origin','Access-Control-Request-Method','Access-Control-Request-Headers'],
    exposedHeaders: ['Content-Length', 'X-Request-Id'],
    maxAge: 86400
}));
app.options('*', cors());

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.use((req, res, next) => {
    console.log(`📥 ${req.method} ${req.path}`);
    if (req.headers.authorization) console.log('🔑 Auth header present');
    next();
});

app.get('/health', (req, res) => {
    const admin = require('./api/_firebase-admin');
    res.json({
        status: 'OK',
        message: 'Backend running',
        firebase: admin.apps.length > 0 ? 'Connected' : 'Not initialized',
        timestamp: new Date().toISOString(),
        cors: 'Enabled'
    });
});

app.get('/', (req, res) => {
    res.json({
        message: 'West EPCM Technology Backend API',
        version: '1.4.1',
        status: 'running',
        endpoints: [
            'GET  /health',
            'GET  /api/dashboard',
            '*    /api/account-variations - Accounts uploads (BDM/value/file)',
            '*    /api/variations',
            '*    /api/proposals',
            '*    /api/projects',
        ]
    });
});

console.log('📦 Loading API routes...');

try {
    console.log('  Loading dashboard...');
    const dashboardHandler = require('./api/dashboard');
    console.log('  Loading email-director-enhancer...');
    require('./api/email-director-enhancer');
    console.log('  Loading proposals...');
    const proposalsHandler = require('./api/proposals');
    console.log('  Loading projects...');
    const projectsHandler = require('./api/projects');
    console.log('  Loading tasks...');
    const tasksHandler = require('./api/tasks');
    console.log('  Loading submissions...');
    const submissionsHandler = require('./api/submissions');
    console.log('  Loading payments...');
    const paymentsHandler = require('./api/payments');
    console.log('  Loading notifications...');
    const notificationsHandler = require('./api/notifications');
    console.log('  Loading activities...');
    const activitiesHandler = require('./api/activities');
    console.log('  Loading files...');
    const filesHandler = require('./api/files');
    console.log('  Loading deliverables...');
    const deliverablesHandler = require('./api/deliverables');
    console.log('  Loading users...');
    const usersHandler = require('./api/users');
    console.log('  Loading variations...');
    const variationsHandler = require('./api/variations');
    console.log('  Loading account-variations...');
    const accountVariationsHandler = require('./api/account-variations');
    console.log('  Loading bdm-analytics...');
    const bdmAnalyticsHandler = require('./api/bdm-analytics');
    console.log('  Loading bdm-entries...');
    const bdmEntriesHandler = require('./api/bdm-entries');
    console.log('  Loading bdm-quote-sync...');
    const bdmQuoteSyncHandler = require('./api/bdm-quote-sync');
    console.log('  Loading email...');
    const { emailHandler } = require('./api/email');
    console.log('  Loading timesheets...');
    const { timesheetsRouter, timeRequestRouter } = require('./api/timesheets');
    console.log('  Loading timesheet-drawing-info...');
    const timesheetDrawingInfoHandler = require('./api/timesheet-drawing-info');
    console.log('  Loading allocation-requests...');
    const allocationRequestsHandler = require('./api/allocation-requests');
    console.log('  Loading leave-requests...');
    const leaveRequestsHandler = require('./api/leave-requests');
    console.log('  Loading screening...');
    const screeningHandler = require('./api/screening');
    console.log('  Loading it-tickets...');
    const itTicketsHandler = require('./api/it-tickets');
    console.log('  Loading migrate-user...');
    const migrateUserHandler = require('./api/migrate-user');
    console.log('  Loading forgot-password...');
    const forgotPasswordHandler = require('./api/forgot-password');
    console.log('  Loading subventors...');
    const subventorsHandler = require('./api/subventors');
    console.log('  Loading daily-expenses...');
    const dailyExpensesHandler = require('./api/daily-expenses');
    console.log('  Loading gst-filing...');
    const gstFilingHandler = require('./api/gst-filing');
    console.log('  Loading petty-cash...');
    const pettyCashHandler = require('./api/petty-cash');

    console.log('✅ All handlers loaded successfully');
    console.log('🔗 Registering routes...');
    app.use('/api/dashboard', dashboardHandler);
    app.use('/api/proposals', proposalsHandler);
    app.use('/api/projects', projectsHandler);
    app.use('/api/tasks', tasksHandler);
    app.use('/api/submissions', submissionsHandler);
    app.use('/api/payments', paymentsHandler);
    app.use('/api/notifications', notificationsHandler);
    app.use('/api/activities', activitiesHandler);
    app.use('/api/files', filesHandler);
    app.use('/api/deliverables', deliverablesHandler);
    app.use('/api/users', usersHandler);
    app.use('/api/variations', variationsHandler);
    app.use('/api/account-variations', accountVariationsHandler);
    app.use('/api/bdm-analytics', bdmAnalyticsHandler);
    app.use('/api/bdm-entries', bdmEntriesHandler);
    app.use('/api/bdm-quote-sync', bdmQuoteSyncHandler);
    app.use('/api/email', emailHandler);
    app.use('/api/timesheets', timesheetsRouter);
    app.use('/api/time-requests', timeRequestRouter);
    app.use('/api/timesheet-drawing-info', timesheetDrawingInfoHandler);
    app.use('/api/allocation-requests', allocationRequestsHandler);
    app.use('/api/leave-requests', leaveRequestsHandler);
    app.use('/api/screening', screeningHandler);
    app.use('/api/it-tickets', itTicketsHandler);
    app.use('/api/migrate-user', migrateUserHandler);
    app.use('/api/forgot-password', forgotPasswordHandler);
    app.use('/api/subventors', subventorsHandler);
    app.use('/api/daily-expenses', dailyExpensesHandler);
    app.use('/api/gst-filing', gstFilingHandler);
    app.use('/api/petty-cash', pettyCashHandler);

    console.log('✅ All routes registered');
} catch (error) {
    console.error('❌ Error loading routes:', error.message);
    console.error('❌ Stack:', error.stack);
}

app.use((req, res, next) => {
    console.log(`❌ 404 - Route not found: ${req.method} ${req.path}`);
    res.status(404).json({
        success: false,
        error: 'Endpoint not found',
        path: req.path,
        method: req.method,
        message: `The endpoint ${req.method} ${req.path} does not exist`
    });
});

app.use((err, req, res, next) => {
    console.error('❌ Server error:', err);
    res.status(500).json({
        success: false,
        error: 'Internal Server Error',
        message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
    });
});

const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log('   *    /api/account-variations');
});

process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
process.on('SIGINT', () => { server.close(() => process.exit(0)); });

module.exports = app;
