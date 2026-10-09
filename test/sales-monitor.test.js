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
test('report uses linked proposal PO, counts a win once, separates currencies and manual uploads', () => {
    const { rows } = buildReport(fixture);
    const won = rows.filter(r => r.source === 'projects' && r.kind === 'won');
    assert.equal(won.length, 1); assert.equal(won[0].value, 100); assert.equal(won[0].currency, 'CAD');
    assert.equal(won[0].date, '2026-10-01'); assert.equal(won[0].bdmName, 'Alice');
    const variations = rows.filter(r => r.kind === 'variation');
    assert.equal(variations.length, 1); assert.equal(variations[0].value, 0);
    const manual = rows.find(r => r.source === 'manual');
    assert.equal(manual.bdmUid, 'alice'); assert.equal(manual.value, 100); assert.equal(manual.currency, 'USD');
    assert.equal(rows.filter(r => r.kind === 'quote').length, 1);
});
test('unconverted wins, missing metadata, zero values and unassigned BDM remain visible', () => {
    const data = buildReport({ users: [], projects: [], variations: [], entries: [], proposals: [{ id: 'p', status: 'won', poValue: 0 }] });
    assert.equal(data.rows.length, 1);
    assert.equal(data.rows[0].value, 0); assert.equal(data.rows[0].date, null);
    assert.equal(data.rows[0].currency, 'UNSPECIFIED'); assert.equal(data.rows[0].bdmUid, 'unassigned');
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
