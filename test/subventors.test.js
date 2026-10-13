const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const records = new Map(), uploads = [];
let sequence = 0;
const ref = path => ({ path, id: path.split('/').pop(), async get() { const d = records.get(path); return { exists: !!d, id: this.id, data: () => structuredClone(d) }; } });
const collection = name => ({
    doc: id => ref(name + '/' + id),
    add: async data => { const r = ref(name + '/auto' + (++sequence)); records.set(r.path, data); return r; },
    where() { return this; }, orderBy() { return this; },
    async get() { return { docs: [], size: 0, forEach() {} }; }
});
const database = { collection, runTransaction: async fn => {
    const writes = [];
    await fn({ get: r => r.get(), update: (r, data) => writes.push(() => records.set(r.path, { ...records.get(r.path), ...data })) });
    writes.forEach(w => w());
} };
const firestore = () => database;
firestore.FieldValue = { serverTimestamp: () => 'ts', arrayUnion: (...a) => a };
require.cache[require.resolve('../api/_firebase-admin')] = { exports: {
    apps: [{}], firestore,
    auth: () => ({ verifyIdToken: async token => ({ uid: token, email: token + '@test.local' }) }),
    storage: () => ({ bucket: () => ({ name: 'bucket', file: path => ({ save: async () => uploads.push(path), makePublic: async () => {} }) }) })
} };
records.set('users/acct', { name: 'Accounts', role: 'accounts', status: 'active' });
records.set('users/bdm', { name: 'BDM', role: 'bdm', status: 'active' });
const app = express(); app.use(express.json({ limit: '5mb' })); app.use('/api/subventors', require('../api/subventors'));

test('Accounts can edit every entered subvendor detail and correct payments; totals follow', async t => {
    const server = app.listen(0); await new Promise(r => server.once('listening', r)); t.after(() => server.close());
    const put = (body, token = 'acct') => fetch(`http://127.0.0.1:${server.address().port}/api/subventors/s1`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
    records.set('subventors/s1', { vendorName: 'Ravi', vendorCompany: 'Old Co', poAmount: 1000, poCurrency: 'INR', totalPaid: 400, balanceDue: 600, paymentStatus: 'partial',
        paymentHistory: [{ amount: 400, paymentDate: '2026-09-01', recordedAt: 'r1' }] });

    assert.equal((await put({ action: 'edit_details', data: { vendorCompany: 'x' } }, 'bdm')).status, 403);
    assert.equal((await put({ action: 'edit_details', data: { vendorCompany: '  ' } })).status, 400);
    assert.equal((await put({ action: 'edit_details', data: { poAmount: -5 } })).status, 400);

    let res = await put({ action: 'edit_details', data: { vendorCompany: ' New Co ', vendorGST: '29ABC', vendorBankDetails: 'HDFC 123', poNumber: 'PO-9',
        poDate: '2026-09-10', poAmount: '400', poCurrency: 'usd', poDescription: 'Steel', paymentTerms: '30 days', clientCompany: 'Client',
        poFileBase64: Buffer.from('%PDF').toString('base64'), poFileName: 'po.pdf' } });
    assert.equal(res.status, 200);
    let s = records.get('subventors/s1');
    assert.equal(s.vendorCompany, 'New Co'); assert.equal(s.vendorBankDetails, 'HDFC 123'); assert.equal(s.poCurrency, 'USD');
    assert.equal(s.poAmount, 400); assert.equal(s.balanceDue, 0); assert.equal(s.paymentStatus, 'paid', 'Lower P.O. amount recalculates status');
    assert.match(s.poFileUrl, /po\.pdf$/); assert.equal(uploads.length, 1);

    assert.equal((await put({ action: 'edit_payment', data: { index: 0, recordedAt: 'stale', amount: 100 } })).status, 409);
    res = await put({ action: 'edit_payment', data: { index: 0, recordedAt: 'r1', amount: 150, paymentDate: '2026-09-05', referenceNo: 'UTR1' } });
    assert.equal(res.status, 200);
    s = records.get('subventors/s1');
    assert.equal(s.totalPaid, 150); assert.equal(s.balanceDue, 250); assert.equal(s.paymentStatus, 'partial');
    assert.equal(s.paymentHistory[0].referenceNo, 'UTR1'); assert.equal(s.lastPaymentDate, '2026-09-05');

    res = await put({ action: 'delete_payment', data: { index: 0, recordedAt: 'r1' } });
    s = records.get('subventors/s1');
    assert.equal(res.status, 200); assert.equal(s.paymentHistory.length, 0); assert.equal(s.totalPaid, 0); assert.equal(s.paymentStatus, 'pending');
    assert.ok([...records.keys()].some(k => k.startsWith('activities/')), 'Edits are logged');
});
