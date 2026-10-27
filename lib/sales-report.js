'use strict';
// Single sales analysis report for the sales portal and COO / Director.
// Values remain in their original currencies; the page converts for display.
//   won       - proposals a BDM marked won: the P.O. value entered when clicking "Won", on the won date
//   variation - variations uploaded by Accounts against a BDM (accountVariations)
//   purchase  - purchase portal projects: initial approved sales value, not attributed to any BDM
//   rfq       - quote value uploaded by the estimator on the proposal (pricing); reported, never added to sales
const REPORT_FROM = '2025-12-01';
const INACTIVE_VARIATION = ['rejected', 'cancelled', 'canceled', 'deleted', 'void'];

function date(value) {
    if (!value) return null;
    const d = value.toDate ? value.toDate() : new Date(value.seconds != null ? value.seconds * 1000 : value._seconds != null ? value._seconds * 1000 : value);
    return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : null;
}
function amount(...values) {
    for (const value of values) {
        if (value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))) return Number(value);
    }
    return null;
}
function buildReport({ users, proposals = [], accountVariations = [], purchaseProjects = [] }) {
    const byUid = new Map(users.map(u => [u.id, u]));
    const byEmail = new Map(users.filter(u => u.email).map(u => [u.email.trim().toLowerCase(), u]));
    const rows = [];
    function add(source, kind, record, owner, value, currency, eventDate, details, status) {
        const email = String(owner.email || '').trim().toLowerCase();
        const user = byUid.get(owner.uid) || byEmail.get(email);
        rows.push({ id: `${kind}:${record.id}`, source, kind,
            bdmUid: user ? user.id : owner.uid || email || 'unassigned',
            bdmName: (user && (user.name || user.displayName || user.email)) || owner.name || 'Unassigned',
            projectName: details.projectName || 'Unnamed project',
            projectNumber: details.projectNumber || '',
            client: details.client || '',
            reference: details.reference || '',
            value, currency: String(currency || 'UNSPECIFIED').trim().toUpperCase(),
            date: date(eventDate), status: status || kind });
    }
    const proposalDetails = p => ({ projectName: p.projectName, projectNumber: p.pricing?.projectNumber || p.projectNumber || '',
        client: p.clientCompany || p.clientName || '' });
    const proposalOwner = p => ({ uid: p.createdByUid, email: p.createdByEmail, name: p.createdByName });
    for (const p of proposals) {
        if (p.status === 'won') {
            const po = amount(p.poValue, p.poDetails?.value);
            add('proposals', 'won', p, proposalOwner(p), po, p.poCurrency || p.poDetails?.currency, p.wonDate || p.poAddedAt,
                { ...proposalDetails(p), reference: p.poNumber || p.poDetails?.poNumber || '' }, po === null ? 'won · no P.O. value' : 'won');
        }
        const quote = amount(p.pricing?.quoteValue);
        if (quote !== null) add('estimator', 'rfq', p, proposalOwner(p), quote, p.pricing.currency, p.pricing.pricedAt || p.pricing.lastEditedAt,
            { ...proposalDetails(p), reference: p.pricing.quoteNumber || '' }, String(p.status || 'priced').replace(/_/g, ' '));
    }
    for (const v of accountVariations) {
        if (INACTIVE_VARIATION.includes(String(v.status || '').toLowerCase())) continue;
        add('accounts', 'variation', v, { uid: v.bdmUid, email: v.bdmEmail, name: v.bdmName }, amount(v.variationValue), v.currency, v.createdAt,
            { projectName: v.projectName || v.description, reference: v.referenceCode || '' }, 'uploaded by accounts');
    }
    for (const p of purchaseProjects) {
        if (!p.sales || !p.sales.include) continue;
        add('purchase', 'purchase', p, { uid: 'purchase-portal', name: 'Purchase portal' }, amount(p.sales.value), p.sales.currency, p.sales.date,
            { projectName: p.name, projectNumber: p.projectNumber, client: p.client }, 'approved');
    }
    return { rows, from: REPORT_FROM,
        bdms: users.filter(u => u.role === 'bdm').map(u => ({ id: u.id, name: u.name || u.displayName || u.email || 'Unnamed BDM' })),
        generatedAt: new Date().toISOString(),
        basis: 'Sales = P.O. value entered when a BDM marks a proposal won + variations uploaded by Accounts for that BDM + purchase portal project value (shown separately, not attributed to BDMs). RFQ value is the estimator\'s quote value and is not added to sales. Not invoiced revenue or cash collected.' };
}
module.exports = { buildReport, REPORT_FROM };
