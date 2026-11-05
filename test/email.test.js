// sendEmailNotification against a mocked Resend client and Firestore: recipients and sender.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sent = [];
require.cache[require.resolve('resend')] = { exports: { Resend: class { constructor() { this.emails = { send: async msg => { sent.push(msg); return { data: { id: 'm' + sent.length } }; } }; } } } };
const users = [
    { role: 'coo', email: 'coo@edanbrook.com' }, { role: 'director', email: 'director@edanbrook.com' },
    { role: 'estimator', email: 'max@edanbrook.com' }, { role: 'bdm', email: 'sabin@edanbrook.com' }
];
const firestore = () => ({ collection: () => ({
    where: (field, op, roles) => ({ get: async () => ({ docs: users.filter(u => roles.includes(u.role)).map(u => ({ data: () => u })) }) }),
    doc: () => ({ get: async () => ({ exists: false }) })
}) });
require.cache[require.resolve('../api/_firebase-admin')] = { exports: { firestore } };
process.env.RESEND_API_KEY = 'test';
const { sendEmailNotification } = require('../api/email');

test('a new proposal emails Maxwell (estimator), COO, Director and the BDM, once each', async () => {
    sent.length = 0;
    const result = await sendEmailNotification('proposal.created', { projectName: 'Bridge', clientName: 'Acme', createdBy: 'Sabin', createdByEmail: 'sabin@edanbrook.com', proposalId: 'p1' });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.deepEqual(sent.map(m => m.to[0]).sort(), ['coo@edanbrook.com', 'director@edanbrook.com', 'max@edanbrook.com', 'sabin@edanbrook.com']);
    assert.match(sent[0].subject, /Bridge/);
});
test('invoice emails go out from the Accounts sender (regression: undefined isInvoiceEvent stopped every email)', async () => {
    sent.length = 0;
    const result = await sendEmailNotification('invoice.saved', { projectName: 'Bridge', bdmEmail: 'sabin@edanbrook.com' });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.ok(sent.every(m => /accounts@edanbrook\.com/.test(m.from)));
});
