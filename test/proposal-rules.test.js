const { test } = require('node:test');
const assert = require('node:assert/strict');
const { findDuplicateProposal, findDuplicatePo, parseWonDate } = require('../lib/proposal-rules');

const list = [
    { id: 'a', projectName: 'Bridge  Expansion – Phase 1', clientCompany: 'ACME Ltd.', status: 'submitted_to_client' },
    { id: 'b', projectName: 'Old Shed', clientCompany: 'Acme', status: 'lost' },
    { id: 'c', projectName: 'Tower', clientCompany: 'Beta', status: 'won', poNumber: 'PO-2026/001' }
];
test('same project and client is a duplicate, ignoring case, spacing and punctuation', () => {
    assert.equal(findDuplicateProposal(list, { projectName: 'bridge expansion phase 1', clientCompany: 'acme ltd' }).id, 'a');
    assert.equal(findDuplicateProposal(list, { projectName: 'Bridge Expansion Phase 1', clientCompany: 'Other client' }), null);
    assert.equal(findDuplicateProposal(list, { projectName: 'Bridge Expansion Phase 1', clientCompany: 'Acme Ltd' }, 'a'), null, 'editing itself is fine');
});
test('lost / rejected proposals do not block a new one', () => {
    assert.equal(findDuplicateProposal(list, { projectName: 'old shed', clientCompany: 'ACME' }), null);
});
test('a P.O. number can be on one won proposal only', () => {
    assert.equal(findDuplicatePo(list, 'po 2026 001').id, 'c');
    assert.equal(findDuplicatePo(list, 'PO-2026/001', 'c'), null, 'updating its own P.O. is fine');
    assert.equal(findDuplicatePo(list, 'PO-9'), null);
});
test('won date must be a real, non-future date', () => {
    const now = new Date('2026-10-27T10:00:00Z');
    assert.equal(parseWonDate('2026-10-20', now).text, '2026-10-20');
    assert.equal(parseWonDate('2026-10-20T08:00:00.000Z', now).text, '2026-10-20', 'ISO timestamps use their date');
    assert.equal(parseWonDate('2026-10-20', now).date.toISOString(), '2026-10-20T12:00:00.000Z');
    assert.match(parseWonDate('2026-11-05', now).error, /future/);
    assert.match(parseWonDate('2026-02-30', now).error, /valid/);
    assert.match(parseWonDate('', now).error, /YYYY-MM-DD/);
    assert.match(parseWonDate('2019-12-31', now).error, /past/);
});
