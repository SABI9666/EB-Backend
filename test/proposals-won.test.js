// Exercises api/proposals.js against an in-memory Firestore stand-in: duplicate blocking, won date, P.O. update.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const docs = new Map();
const deleted = [];
const activity = [];
const value = v => (v && v.__op === 'ts') ? new Date('2026-10-27T09:00:00Z') : v;
const collection = name => ({
    doc: id => ({
        get: async () => ({ exists: name === 'proposals' && docs.has(id), id, data: () => docs.get(id) }),
        delete: async () => { deleted.push(id); docs.delete(id); },
        update: async updates => { const d = docs.get(id); for (const [k, v] of Object.entries(updates)) d[k] = v && v.__op === 'union' ? [...(d[k] || []), ...v.items] : value(v); }
    }),
    add: async data => { if (name === 'proposals') { const id = 'new' + docs.size; docs.set(id, data); return { id }; } activity.push(data); return { id: 'x' }; },
    select: () => ({ get: async () => ({ docs: [...docs.entries()].map(([id, d]) => ({ id, data: () => d })) }) }),
    where: () => ({ get: async () => ({ docs: [], empty: true }), limit: () => ({ get: async () => ({ docs: [], empty: true }) }) })
});
const firestore = () => ({ collection });
firestore.FieldValue = { serverTimestamp: () => ({ __op: 'ts' }), arrayUnion: (...items) => ({ __op: 'union', items }) };
firestore.Timestamp = { fromDate: d => d };
require.cache[require.resolve('../api/_firebase-admin')] = { exports: { firestore, storage: () => ({ bucket: () => ({}) }) } };
require.cache[require.resolve('../middleware/auth')] = { exports: { verifyToken: (req, res, next) => { req.user = req.testUser; next(); } } };
require.cache[require.resolve('../api/email')] = { exports: { sendEmailNotification: async () => {} } };
const handler = require('../api/proposals');
const bdm = { uid: 'sabin', role: 'bdm', name: 'Sabin', email: 's@x' };
async function call(method, query, body, user = bdm) {
    let status = 200, json;
    const res = { setHeader() {}, status(s) { status = s; return this; }, json(j) { json = j; return this; }, end() { return this; } };
    await handler({ method, query: query || {}, body, headers: {}, testUser: user }, res);
    return { status, json };
}
test('duplicate proposals and duplicate P.O. numbers are refused', async () => {
    docs.set('p1', { projectName: 'Bridge', clientCompany: 'Acme', status: 'submitted_to_client', createdByUid: 'sabin' });
    const dup = await call('POST', {}, { projectName: ' bridge', clientCompany: 'ACME', projectDescription: 'x' });
    assert.equal(dup.status, 409); assert.match(dup.json.error, /already exists/);
    const ok = await call('POST', {}, { projectName: 'Tower', clientCompany: 'Acme', projectDescription: 'x' });
    assert.equal(ok.status, 201);
    docs.set('p0', { projectName: 'Shed', clientCompany: 'Beta', status: 'won', poNumber: 'PO-7', createdByUid: 'sabin' });
    const samePo = await call('PUT', { id: 'p1' }, { action: 'mark_won', data: { poNumber: 'po 7', poValue: 10, wonDate: '2026-10-05' } });
    assert.equal(samePo.status, 409); assert.match(samePo.json.error, /already recorded/);
});
test('mark won uses the chosen date once; P.O. update keeps it; a second Won click is refused', async () => {
    const won = await call('PUT', { id: 'p1' }, { action: 'mark_won', data: { poNumber: 'PO-1', poValue: 100, poCurrency: 'cad', wonDate: '2026-10-05' } });
    assert.equal(won.status, 200, JSON.stringify(won.json));
    assert.equal(docs.get('p1').status, 'won'); assert.equal(docs.get('p1').wonDate.toISOString(), '2026-10-05T12:00:00.000Z');
    const again = await call('PUT', { id: 'p1' }, { action: 'mark_won', data: { poNumber: 'PO-1', poValue: 100 } });
    assert.equal(again.status, 409);
    const upd = await call('PUT', { id: 'p1' }, { action: 'mark_won', data: { poUpdated: true, poNumber: 'PO-1', poValue: 150, poCurrency: 'CAD' } });
    assert.equal(upd.status, 200); assert.equal(docs.get('p1').poValue, 150);
    assert.equal(docs.get('p1').wonDate.toISOString(), '2026-10-05T12:00:00.000Z', 'P.O. update keeps the won date');
    assert.deepEqual(docs.get('p1').changeLog.map(e => e.action), ['mark_won', 'update_po'], 'P.O. update is logged separately from the win');
    const future = await call('PUT', { id: 'p1' }, { action: 'mark_won', data: { poNumber: 'PO-1', poValue: 1, wonDate: '2099-01-01' } });
    assert.equal(future.status, 409, 'already won wins over a bad date');
});
test('only the owning BDM (or COO / Director) edits the won date, with history', async () => {
    const other = await call('PUT', { id: 'p1' }, { action: 'update_won_date', data: { wonDate: '2026-10-01' } }, { uid: 'gerard', role: 'bdm', name: 'Gerard' });
    assert.equal(other.status, 403);
    const bad = await call('PUT', { id: 'p1' }, { action: 'update_won_date', data: { wonDate: '2099-01-01' } });
    assert.equal(bad.status, 400);
    const ok = await call('PUT', { id: 'p1' }, { action: 'update_won_date', data: { wonDate: '2026-10-01' } });
    assert.equal(ok.status, 200);
    const p = docs.get('p1');
    assert.equal(p.wonDate.toISOString(), '2026-10-01T12:00:00.000Z');
    assert.deepEqual([p.wonDateEdited, p.wonDateEditedBy, p.wonDateHistory[0].from, p.wonDateHistory[0].to], [true, 'Sabin', '2026-10-05', '2026-10-01']);
    const coo = await call('PUT', { id: 'p1' }, { action: 'update_won_date', data: { wonDate: '2026-09-30' } }, { uid: 'c', role: 'coo', name: 'COO' });
    assert.equal(coo.status, 200);
    const notWon = await call('PUT', { id: 'new1' }, { action: 'update_won_date', data: { wonDate: '2026-09-30' } }, { uid: 'c', role: 'coo', name: 'COO' });
    assert.equal(notWon.status, 400);
});
test('a duplicate can be deleted by its BDM, but not once a project exists', async () => {
    docs.set('d1', { projectName: 'Bridge', clientCompany: 'Acme', status: 'won', createdByUid: 'sabin' });
    docs.set('d2', { projectName: 'Bridge', clientCompany: 'Acme', status: 'won', createdByUid: 'sabin', projectCreated: true, projectId: 'pr1' });
    assert.equal((await call('DELETE', { id: 'd2' })).status, 409);
    assert.equal((await call('DELETE', { id: 'd1' }, undefined, { uid: 'gerard', role: 'bdm', name: 'Gerard' })).status, 403);
    assert.equal((await call('DELETE', { id: 'd1' })).status, 200);
    assert.deepEqual(deleted, ['d1']);
});
