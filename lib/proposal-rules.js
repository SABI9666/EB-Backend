'use strict';
// Guards against duplicate proposals / wins and validates BDM-entered won dates.

// Statuses that no longer block a new proposal for the same project and client.
const CLOSED = ['lost', 'rejected', 'cancelled', 'canceled'];
const key = value => String(value || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim();

// An open proposal (any BDM) for the same project name and client company.
function findDuplicateProposal(proposals, { projectName, clientCompany }, excludeId) {
    const name = key(projectName), client = key(clientCompany);
    if (!name || !client) return null;
    return proposals.find(p => p.id !== excludeId && !CLOSED.includes(String(p.status || '').toLowerCase()) &&
        key(p.projectName) === name && key(p.clientCompany) === client) || null;
}

// Another won proposal already carrying this P.O. number.
function findDuplicatePo(proposals, poNumber, excludeId) {
    const po = key(poNumber);
    if (!po) return null;
    return proposals.find(p => p.id !== excludeId && p.status === 'won' && key(p.poNumber || p.poDetails?.poNumber) === po) || null;
}

// Won date entered by the BDM: a real calendar date (YYYY-MM-DD), not in the future, not before 2020.
// Stored at 12:00 UTC so it shows as the same day in every timezone the team works in.
function parseWonDate(value, now = new Date()) {
    const text = String(value || '').trim().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return { error: 'Won date must be a date (YYYY-MM-DD).' };
    const date = new Date(text + 'T12:00:00Z');
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== text) return { error: 'Won date is not a valid calendar date.' };
    if (text > new Date(now.getTime() + 14 * 3600 * 1000).toISOString().slice(0, 10)) return { error: 'Won date cannot be in the future.' };
    if (text < '2020-01-01') return { error: 'Won date is too far in the past.' };
    return { date, text };
}

module.exports = { findDuplicateProposal, findDuplicatePo, parseWonDate, normalizeKey: key };
