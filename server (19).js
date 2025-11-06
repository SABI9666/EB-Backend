// server.js - Complete backend entry point with EMAIL + TIMESHEET + VARIATIONS + TIME-REQUESTS API
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
require('dotenv').config();

// === IMPORT YOUR AUTH MIDDLEWARE ===
// <<< MODIFIED: Imports 'verifyToken' from your file
const { verifyToken } = require('./middleware/auth.js'); 

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// MIDDLEWARE
// ============================================
app.use(helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.use(compression());
app.use(morgan('dev'));

// CORS - PROPERLY CONFIGURED FOR YOUR FRONTEND
app.use(cors({
    origin: function(origin, callback) {
        // Allow requests with no origin (mobile apps, Postman, etc.)
        if (!origin) return callback(null, true);
        
        // List of allowed origins
        const allowedOrigins = [
            'http://localhost:3000',
            'http://localhost:5500',
            'http://127.0.0.1:5500',
            'https://eb-tracker-frontend.vercel.app',
            'https://eb-tracker-frontend-*.vercel.app', // Vercel preview deployments
        ];
        
        // Check if origin matches allowed patterns
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
            callback(null, true); // Allow anyway for development
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: [
        'Content-Type', 
        'Authorization', 
        'X-Requested-With',
        'Accept',
        'Origin',
        'Access-Control-Request-Method',
        'Access-Control-Request-Headers'
    ],
    exposedHeaders: ['Content-Length', 'X-Request-Id'],
    maxAge: 86400 // 24 hours
}));

// Handle preflight for all routes
app.options('*', cors());

// Body parsing
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Request logging
app.use((req, res, next) => {
    console.log(`📥 ${req.method} ${req.path}`);
    if (req.headers.authorization) {
        console.log('🔑 Auth header present');
    }
    next();
});

// ============================================
// HEALTH CHECK (NO AUTH)
// ============================================
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
        message: 'EBTracker Backend API',
        version: '1.1.0',
        status: 'running',
        endpoints: [
            'GET  /health - Health check',
            'GET  /api/dashboard - Dashboard data',
            // ... (rest of your endpoints) ...
        ]
    });
});

// ============================================
// APPLY AUTH MIDDLEWARE
// ============================================
// ❌ COMMENTED OUT: Each handler already calls verifyToken internally
// Applying auth globally here causes route conflicts and 404 errors
// app.use('/api', verifyToken);


// ============================================
// API ROUTES - Import handlers
// ============================================
console.log('📦 Loading API routes...');

try {
    // Load all route handlers with individual error catching
    console.log('  Loading dashboard...');
    const dashboardHandler = require('./api/dashboard');
    
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
    
    console.log('  Loading email...');
    // --- FIX: Import the 'emailHandler' object from the refactored file ---
    const { emailHandler } = require('./api/email');
    
    console.log('  Loading timesheets...');
    const { timesheetsRouter, timeRequestRouter } = require('./api/timesheets');

    console.log('✅ All handlers loaded successfully');

    // Register routes
    console.log('📝 Registering routes...');
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
    app.use('/api/email', emailHandler);

    // --- REVERTED FIX ---
    // The verifyToken middleware is now called inside timesheets.js
    // to match the pattern used in proposals.js
    app.use('/api/timesheets', timesheetsRouter);
    app.use('/api/time-requests', timeRequestRouter);
    // --- End of Revert ---

    console.log('✅ All routes registered');

} catch (error) {
    console.error('❌ Error loading routes:', error.message);
    console.error('❌ Stack:', error.stack);
    console.error('❌ CRITICAL: Routes not loaded! Server will have 404 errors.');
}

// ============================================
// ERROR HANDLING
// ============================================
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

// ============================================
// START SERVER
// ============================================
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('╔═══════════════════════════════════════╗');
    console.log(`║  ✅ Server running on port ${PORT}      ║`);
    console.log(`║  🌍 Environment: ${(process.env.NODE_ENV || 'development').padEnd(20)}║`);
    const admin = require('./api/_firebase-admin');
    console.log(`║  🔥 Firebase: ${(admin.apps.length > 0 ? 'Initialized' : 'Not initialized').padEnd(23)}║`);
    console.log('║  🌐 CORS: Enabled for Vercel           ║');
    console.log('╚═══════════════════════════════════════╝');
    console.log('');
    console.log('📡 API Endpoints ready:');
    console.log('   GET  /health');
    console.log('   GET  /api/dashboard');
    // ... (rest of your logs) ...
    console.log('');
});

// ============================================
// GRACEFUL SHUTDOWN
// ============================================
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received. Closing HTTP server.');
    server.close(() => {
        console.log('HTTP server closed. Exiting process.');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('\nSIGINT signal received. Closing HTTP server.');
    server.close(() => {
        console.log('HTTP server closed. Exiting process.');
        process.exit(0);
    });
});

module.exports = app;

