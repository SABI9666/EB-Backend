const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { buildReport } = require('../lib/sales-report');
const fixture = {
    users: [{ id: 'alice', role: 'bdm', name: 'Alice', email: 'alice@example.com' }],
    projects: [{ id: 'project1', proposalId: 'proposal1', bdmUid: 'alice', projectName: 'Bridge', quoteValue: 120, currency: 'CAD' }],
    proposals: [{ id: 'proposal1', status: 'won', wonDate: '2026-10-01', createdByUid: 'alice', poValue: 100, poCurrency: 'CAD', pricing: { quoteValue: 120, currency: 'CAD', pricedAt: '2026-09-30' } }],
    variations: [{ id: 'v1', parentProjectId: 'project1', status: 'approved', approvedValue: 0, value: 20, currency: 'CAD', approvedAt: '2026-10-02' }, { id: 'v2', parentProjectId: 'project1', status: 'pending', value: 50 }],
    entries: [{ id: 'entry1', type: 'won', bdmEmail: 'ALICE@example.com', value: 100, currency: 'USD', date: '2026-10-01', projectName: 'Bridge' }]
};
test('BDM figures use uploads; proposal quotes and proposal wins from April 2026 are not read', () => {
    const { rows } = buildReport(fixture);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].source, rows[0].kind, rows[0].bdmUid, rows[0].value, rows[0].currency, rows[0].date], ['manual', 'won', 'alice', 100, 'USD', '2026-10-01']);
    assert.equal(rows.filter(r => r.kind === 'quote').length, 0);
});
test('proposals marked won from Dec 2025 to Mar 2026 are added once, at PO value', () => {
    const proposals = [
        { id: 'p1', status: 'won', wonDate: '2026-02-10', createdByUid: 'alice', poValue: 300, poCurrency: 'INR', pricing: { quoteValue: 400, currency: 'INR' } },
        { id: 'p2', status: 'won', wonDate: '2025-12-01', createdByUid: 'alice', pricing: { quoteValue: 50, currency: 'USD' } },
        { id: 'p3', status: 'won', wonDate: '2025-11-30', createdByUid: 'alice', poValue: 1 },
        { id: 'p4', status: 'won', wonDate: '2026-04-01', createdByUid: 'alice', poValue: 1 },
        { id: 'p5', status: 'won', createdByUid: 'alice', poValue: 1 }
    ];
    const projects = [{ id: 'proj1', proposalId: 'p1', bdmUid: 'alice', projectName: 'Shed' }];
    const rows = buildReport({ users: fixture.users, entries: [], projects, proposals }).rows;
    assert.deepEqual(rows.map(r => [r.source, r.kind, r.projectName, r.value, r.currency, r.date, r.bdmUid]),
        [['proposals', 'won', 'Shed', 300, 'INR', '2026-02-10', 'alice'], ['proposals', 'won', 'Unnamed project', 50, 'USD', '2025-12-01', 'alice']]);
});
test('uploaded quotes, wins and variations are kept; other entry types and missing metadata stay visible', () => {
    const entries = [
        { id: 'q', type: 'quote', bdmUid: 'alice', value: 500, currency: 'INR', date: '2026-10-03' },
        { id: 'v', type: 'variation', bdmUid: 'alice', value: '25', currency: 'inr', date: '2026-10-04' },
        { id: 'x', type: 'note', bdmUid: 'alice', value: 999 },
        { id: 'w', type: 'won', value: 0 }
    ];
    const { rows } = buildReport({ users: fixture.users, entries });
    assert.deepEqual(rows.map(r => [r.kind, r.value, r.currency]), [['quote', 500, 'INR'], ['variation', 25, 'INR'], ['won', 0, 'UNSPECIFIED']]);
    assert.equal(rows[2].date, null); assert.equal(rows[2].bdmUid, 'unassigned');
});
test('approved purchase projects are a separate, non-BDM source at their initial sales value', () => {
    const purchaseProjects = [
        { id: 'pp1', projectNumber: 'EB-101', name: 'Plant shed', client: 'Acme', projectValue: 999, sales: { include: true, value: 500, currency: 'INR', date: '2026-10-05' } },
        { id: 'pp2', projectNumber: 'EB-102', name: 'Pending', projectValue: 300, sales: null },
        { id: 'pp3', projectNumber: 'EB-103', name: 'Excluded', sales: { include: false, value: 200, currency: 'INR', date: '2026-10-05' } }
    ];
    const rows = buildReport({ ...fixture, purchaseProjects }).rows.filter(r => r.source === 'purchase');
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
        const rows = fixture[name === 'bdm_entries' ? 'entries' : name] || [];
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
        const result = await response.json(); assert.equal(result.data.rows.length, 1);
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
