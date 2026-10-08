'use strict';
const router = require('express').Router();
const admin = require('./_firebase-admin');
const { verifyToken, requireRole } = require('../middleware/auth');
const { buildReport } = require('../lib/sales-report');

// Read by document ID, so legacy records lacking dates are not silently dropped.
async function readCollection(name) {
    const rows = [];
    let last;
    for (;;) {
        let query = admin.firestore().collection(name).orderBy(admin.firestore.FieldPath.documentId()).limit(1000);
        if (last) query = query.startAfter(last);
        const page = await query.get();
        rows.push(...page.docs.map(doc => ({ ...doc.data(), id: doc.id })));
        if (page.size < 1000) return rows;
        if (rows.length >= 20000) throw new Error('Sales report collection exceeds the supported reporting size.');
        last = page.docs[page.docs.length - 1];
    }
}
router.use(verifyToken, requireRole(['sales_monitor', 'coo', 'director']));
router.get('/', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
        const [users, projects, proposals, variations, entries] = await Promise.all(
            ['users', 'projects', 'proposals', 'variations', 'bdm_entries'].map(readCollection));
        res.json({ success: true, data: buildReport({ users, projects, proposals, variations, entries }) });
    } catch (error) {
        console.error('Sales monitor read failed:', error);
        res.status(503).json({ success: false, error: 'Sales data could not be loaded completely. Please retry or contact your administrator.' });
    }
});
router.all('/', (req, res) => res.status(405).json({ success: false, error: 'Sales monitoring is read-only.' }));
module.exports = router;
