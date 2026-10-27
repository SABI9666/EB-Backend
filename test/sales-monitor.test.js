const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { buildReport } = require('../lib/sales-report');
const fixture = {
    users: [{ id: 'alice', role: 'bdm', name: 'Alice', email: 'alice@example.com' }],
    proposals: [
        { id: 'p1', status: 'won', createdByUid: 'alice', projectName: 'Bridge', clientCompany: 'Acme', wonDate: '2026-10-01', poNumber: 'PO-1', poValue: 100, poCurrency: 'CAD', pricing: { quoteValue: 120, currency: 'CAD', pricedAt: '2026-09-30', projectNumber: 'EB-1' } },
        { id: 'p2', status: 'submitted_to_client', createdByEmail: 'ALICE@example.com', projectName: 'Shed', pricing: { quoteValue: 50, currency: 'USD', pricedAt: '2026-09-15' } },
        { id: 'p3', status: 'pending_estimation', createdByUid: 'alice', projectName: 'Draft' }
    ],
    accountVariations: [
        { id: 'v1', bdmUid: 'alice', bdmName: 'Alice', variationValue: 20, currency: 'inr', projectName: 'Bridge', referenceCode: 'VAR-1', status: 'submitted', createdAt: '2026-10-02' },
        { id: 'v2', bdmUid: 'alice', variationValue: 99, currency: 'INR', status: 'rejected', createdAt: '2026-10-02' }
    ],
    purchase_projects: []
};
test('won = P.O. value the BDM entered; RFQ = estimator quote value; variations from Accounts', () => {
    const { rows } = buildReport({ ...fixture, purchaseProjects: [] });
    const pick = kind => rows.filter(r => r.kind === kind).map(r => [r.source, r.bdmUid, r.projectName, r.value, r.currency, r.date, r.reference]);
    assert.deepEqual(pick('won'), [['proposals', 'alice', 'Bridge', 100, 'CAD', '2026-10-01', 'PO-1']]);
    assert.deepEqual(pick('rfq'), [['estimator', 'alice', 'Bridge', 120, 'CAD', '2026-09-30', ''], ['estimator', 'alice', 'Shed', 50, 'USD', '2026-09-15', '']]);
    assert.deepEqual(pick('variation'), [['accounts', 'alice', 'Bridge', 20, 'INR', '2026-10-02', 'VAR-1']]);
    assert.equal(rows.length, 4);
});
test('won proposal without a P.O. value stays visible and flagged; unknown owner is Unassigned', () => {
    const { rows } = buildReport({ users: [], proposals: [{ id: 'p', status: 'won', poValue: '' }] });
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].value, rows[0].date, rows[0].currency, rows[0].bdmUid, rows[0].status], [null, null, 'UNSPECIFIED', 'unassigned', 'won · no P.O. value']);
});
test('approved purchase projects are a separate, non-BDM source at their initial sales value', () => {
    const purchaseProjects = [
        { id: 'pp1', projectNumber: 'EB-101', name: 'Plant shed', client: 'Acme', projectValue: 999, sales: { include: true, value: 500, currency: 'INR', date: '2026-10-05' } },
        { id: 'pp2', projectNumber: 'EB-102', name: 'Pending', projectValue: 300, sales: null },
        { id: 'pp3', projectNumber: 'EB-103', name: 'Excluded', sales: { include: false, value: 200, currency: 'INR', date: '2026-10-05' } }
    ];
    const rows = buildReport({ users: fixture.users, purchaseProjects }).rows;
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].kind, rows[0].value, rows[0].currency, rows[0].date, rows[0].projectNumber, rows[0].client, rows[0].bdmName], ['purchase', 500, 'INR', '2026-10-05', 'EB-101', 'Acme', 'Purchase portal']);
});
const identities = {
    sales: { role: 'director', email: 'sales.edanbrook@outlook.com' },
    mixed: { role: 'bdm', email: ' SALES.EDANBROOK@OUTLOOK.COM ' },
    forged: { role: 'sales_monitor', email: 'other@example.com' },
    suspended: { role: 'sales_monitor', email: 'sales.edanbrook@outlook.com', status: 'suspended' },
    coo: { role: 'coo', email: 'coo@edanbrook.com' },
    director: { role: 'director', email: 'director@edanbrook.com' },
    bdm: { role: 'bdm', email: 'alice@example.com' },
    purchase: { role: 'purchase', email: 'anwar@edanbrook.in' }
};
let failCollection = false;
const firestore = () => ({ collection: name => ({
    doc: uid => ({ get: async () => ({ exists: !!identities[uid], data: () => ({ name: uid, ...identities[uid] }) }) }),
    orderBy() { return this; }, limit() { return this; }, startAfter() { return this; },
    async get() {
        if (failCollection) throw new Error('Database unavailable');
        const rows = fixture[name] || [];
        return { size: rows.length, docs: rows.map(r => ({ id: r.id, data: () => r })) };
    }
}) });
firestore.FieldPath = { documentId: () => '__name__' };
require.cache[require.resolve('../api/_firebase-admin')] = { exports: { apps: [{}], firestore, auth: () => ({ verifyIdToken: async token => {
    if (!identities[token]) throw new Error('Bad token');
    return { uid: token, email: identities[token].email };
} }) } };
test('API only allows intended monitoring identities and rejects every sales mutation / other route', async t => {
    const app = express(); const { verifyToken } = require('../middleware/auth');
    app.use('/api/sales-monitor', require('../api/sales-monitor'));
    app.use('/api/projects', verifyToken, (req, res) => res.json({ success: true }));
    app.use('/api/purchases', verifyToken, (req, res) => res.json({ success: true }));
    app.use('/api/users', verifyToken, (req, res) => res.json({ success: true }));
    const server = app.listen(0); await new Promise(resolve => server.once('listening', resolve)); t.after(() => server.close());
    const call = (token, path = 'sales-monitor', method = 'GET') => fetch(`http://127.0.0.1:${server.address().port}/api/${path}`, { method, headers: token ? { Authorization: 'Bearer ' + token } : {} });
    assert.equal((await call(null)).status, 401);
    for (const token of ['sales', 'mixed', 'coo', 'director']) {
        const response = await call(token); assert.equal(response.status, 200, token);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        const result = await response.json(); assert.equal(result.data.rows.length, 4);
    }
    for (const token of ['forged', 'suspended', 'bdm', 'purchase']) assert.equal((await call(token)).status, 403, token);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']) assert.equal((await call('sales', 'sales-monitor', method)).status, 403, method);
    for (const path of ['projects', 'users', 'purchases', 'sales-monitor/other']) assert.equal((await call('sales', path)).status, 403, path);
    assert.equal((await call('sales', 'sales-monitor/?x=1')).status, 200);
    assert.equal((await call('purchase', 'purchases')).status, 200);
    assert.equal((await call('coo', 'projects')).status, 200);
    failCollection = true;
    assert.equal((await call('sales')).status, 503);
    failCollection = false;
});
