const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const records = new Map();
let sequence = 0;
class Ref {
    constructor(path) { this.path = path; this.id = path.split('/').pop(); }
    collection(name) { return new Query(this.path + '/' + name); }
    async get() { const data = records.get(this.path); return { exists: !!data, id: this.id, data: () => structuredClone(data) }; }
}
class Query {
    constructor(path) { this.path = path; }
    doc(id = 'doc' + (++sequence)) { return new Ref(this.path + '/' + id); }
    orderBy(key, direction) { this.key = key; this.direction = direction; return this; }
    limit(n) { this.n = n; return this; }
    startAfter(id) { this.after = id; return this; }
    async get() {
        let entries = [...records.entries()].filter(([p]) => p.startsWith(this.path + '/') && p.split('/').length === this.path.split('/').length + 1);
        entries.sort(([a, x], [b, y]) => String(this.key === '__name__' ? a.split('/').pop() : x[this.key]).localeCompare(String(this.key === '__name__' ? b.split('/').pop() : y[this.key])) * (this.direction === 'desc' ? -1 : 1));
        if (this.after) entries = entries.filter(([p]) => p.split('/').pop() > this.after);
        const docs = await Promise.all(entries.slice(0, this.n).map(([p]) => new Ref(p).get()));
        return { docs, size: docs.length };
    }
}
function batch() { const writes = []; return { set: (ref, data) => writes.push(() => records.set(ref.path, data)), update: (ref, data) => writes.push(() => records.set(ref.path, { ...records.get(ref.path), ...data })), get: ref => ref.get(), commit: async () => writes.forEach(fn => fn()) }; }
const database = { collection: name => new Query(name), batch, runTransaction: async fn => { const tx = batch(); await fn(tx); await tx.commit(); } };
const firestore = () => database; firestore.FieldPath = { documentId: () => '__name__' };
const emails = { purchase: 'anwar@edanbrook.in' };
const mock = { firestore, apps: [{}], auth: () => ({ verifyIdToken: async token => ({ uid: token, email: emails[token] || token + '@test.local', email_verified: true }) }) };
require.cache[require.resolve('../api/_firebase-admin')] = { exports: mock };
for (const role of ['coo', 'director', 'bdm', 'purchase']) records.set('users/' + role, { name: role, role, status: 'active' });
const app = express(); app.use(express.json());
app.get('/api/projects', require('../middleware/auth').verifyToken, (req, res) => res.json({ success: true }));
app.use('/api/purchase-projects', require('../api/purchase-projects'));
const project = { projectNumber: 'eb-2026-01', name: 'Plant shed', client: 'Acme', location: 'Chennai', manager: '', description: '', projectValue: 100000, currency: 'INR', awardDate: '2026-10-05', startDate: '2026-10-06', endDate: '', status: 'active', includeInSales: true };
test('purchase projects: approval gates sales value, daily logs keep running totals', async t => {
    const server = app.listen(0); await new Promise(resolve => server.once('listening', resolve)); t.after(() => server.close());
    const url = 'http://127.0.0.1:' + server.address().port + '/api/purchase-projects';
    const call = (role, method, path = '', body) => fetch(url + path, { method, headers: { Authorization: 'Bearer ' + role, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const detail = async path => (await call('coo', 'GET', path)).json();
    // Purchase accounts reach this API but no other legacy API.
    assert.equal((await call('purchase', 'GET')).status, 200);
    assert.equal((await fetch(url.replace('/purchase-projects', '/projects'), { headers: { Authorization: 'Bearer purchase' } })).status, 403);
    assert.equal((await call('bdm', 'GET')).status, 403);
    assert.equal((await call('coo', 'POST', '', project)).status, 403);
    assert.equal((await call('purchase', 'POST', '', { ...project, projectValue: -5 })).status, 400);
    assert.equal((await call('purchase', 'POST', '', { ...project, awardDate: '2026-02-30' })).status, 400);
    let response = await call('purchase', 'POST', '', project);
    assert.equal(response.status, 201);
    const created = (await response.json()).data, path = '/' + created.id;
    assert.equal(created.projectNumber, 'EB-2026-01'); assert.equal(created.sales, null); assert.equal(created.approval.status, 'pending');
    assert.equal((await call('purchase', 'POST', '', { ...project, projectNumber: 'EB-2026-01' })).status, 409);
    // Only management decides; rejection needs a reason.
    assert.equal((await call('purchase', 'POST', path + '/decision', { version: 1, decision: 'approved' })).status, 403);
    assert.equal((await call('director', 'POST', path + '/decision', { version: 1, decision: 'rejected' })).status, 400);
    assert.equal((await call('director', 'POST', path + '/decision', { version: 1, decision: 'approved' })).status, 200);
    assert.equal((await call('coo', 'POST', path + '/decision', { version: 1, decision: 'approved' })).status, 409);
    let data = (await detail(path)).data;
    assert.deepEqual(data.sales, { include: true, value: 100000, currency: 'INR', date: '2026-10-05' });
    // Edits go back for approval while sales keep the approved snapshot.
    assert.equal((await call('purchase', 'PUT', path, { ...project, projectValue: 150000, version: data.version })).status, 400);
    assert.equal((await call('purchase', 'PUT', path, { ...project, projectValue: 150000, version: data.version, note: 'Revised PO' })).status, 200);
    data = (await detail(path)).data;
    assert.equal(data.approval.status, 'pending'); assert.equal(data.projectValue, 150000); assert.equal(data.sales.value, 100000);
    assert.equal((await call('coo', 'POST', path + '/decision', { version: data.version, decision: 'approved' })).status, 200);
    assert.equal((await detail(path)).data.sales.value, 150000);
    // Daily logs: amounts computed server side, totals maintained, removal reverses totals.
    assert.equal((await call('purchase', 'POST', path + '/entries', { type: 'material', date: '2099-01-01', description: 'Cement', quantity: 1, rate: 1 })).status, 400);
    assert.equal((await call('purchase', 'POST', path + '/entries', { type: 'manpower', date: '2026-10-07', description: 'Welder', workers: 0, hours: 8, rate: 900 })).status, 400);
    assert.equal((await call('coo', 'POST', path + '/entries', { type: 'material', date: '2026-10-07', description: 'Cement', quantity: 10, rate: 400 })).status, 403);
    for (const entry of [
        { type: 'material', date: '2026-10-07', description: 'Cement', unit: 'bag', quantity: 10, rate: 400, supplier: 'ACC' },
        { type: 'manpower', date: '2026-10-07', description: 'Welder', workers: 4, hours: 8, rate: 900 },
        { type: 'machinery', date: '2026-10-08', description: 'Crane 25T', units: 1, hours: 6, rate: 2500 }
    ]) assert.equal((await call('purchase', 'POST', path + '/entries', entry)).status, 201);
    let full = await detail(path);
    assert.deepEqual(full.data.totals, { material: 4000, manpower: 3600, machinery: 15000, manDays: 4, manHours: 32, machineHours: 6, entries: 3 });
    assert.equal(full.data.lastEntryDate, '2026-10-08');
    const crane = full.entries.find(e => e.type === 'machinery');
    assert.equal(crane.amount, 15000); assert.equal(crane.currency, 'INR');
    assert.equal((await call('purchase', 'POST', path + '/entries/' + crane.id + '/delete', {})).status, 400);
    assert.equal((await call('purchase', 'POST', path + '/entries/' + crane.id + '/delete', { reason: 'Duplicate' })).status, 200);
    assert.equal((await call('purchase', 'POST', path + '/entries/' + crane.id + '/delete', { reason: 'Again' })).status, 409);
    full = await detail(path);
    assert.equal(full.data.totals.machinery, 0); assert.equal(full.data.totals.entries, 2); assert.equal(full.data.totals.machineHours, 0);
    // Completed projects take no new logs.
    data = full.data;
    assert.equal((await call('purchase', 'PUT', path, { ...project, projectValue: 150000, status: 'completed', version: data.version, note: 'Handed over' })).status, 200);
    assert.equal((await call('purchase', 'POST', path + '/entries', { type: 'material', date: '2026-10-09', description: 'Paint', quantity: 1, rate: 1 })).status, 409);
});
