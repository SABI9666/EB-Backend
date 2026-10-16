'use strict';
// Values remain in their original currencies.
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
// BDM sales come from the values BDMs enter in "Upload Quote / Won" (bdm_entries).
// Uploads started in April 2026, so proposals marked won between 1 Dec 2025 and
// 31 Mar 2026 fill the earlier months. Proposal quotes and later proposal wins are never read.
const PROPOSAL_WINS_FROM = '2025-12-01', PROPOSAL_WINS_BEFORE = '2026-04-01';
function buildReport({ users, entries, projects = [], proposals = [], purchaseProjects = [] }) {
    const byUid = new Map(users.map(u => [u.id, u]));
    const byEmail = new Map(users.filter(u => u.email).map(u => [u.email.trim().toLowerCase(), u]));
    const rows = [];
    function add(source, kind, record, owner, value, currency, eventDate, project, status) {
        const email = String(owner.bdmEmail || owner.createdByEmail || '').trim().toLowerCase();
        const uid = owner.bdmUid || owner.createdByUid || '';
        const user = byUid.get(uid) || byEmail.get(email);
        rows.push({ id: `${source}:${kind}:${record.id}`, source, kind,
            bdmUid: user ? user.id : uid || email || 'unassigned',
            bdmName: (user && (user.name || user.displayName || user.email)) || owner.bdmName || owner.createdByName || 'Unassigned',
            projectId: project.id || record.id,
            projectName: project.projectName || project.name || record.parentProjectName || 'Unnamed project',
            projectNumber: project.projectNumber || project.projectCode || project.pricing?.projectNumber || '',
            client: project.clientCompany || project.clientName || record.clientCompany || '',
            value, currency: String(currency || 'UNSPECIFIED').trim().toUpperCase(),
            date: date(eventDate), status: status || record.status || kind });
    }
    const proposalMap = new Map(proposals.map(p => [p.id, p]));
    const inWindow = d => { const day = date(d); return !!day && day >= PROPOSAL_WINS_FROM && day < PROPOSAL_WINS_BEFORE; };
    const represented = new Set();
    for (const p of projects) {
        const proposal = proposalMap.get(p.proposalId) || p.proposal || {};
        const won = p.wonDate || proposal.wonDate;
        if (p.proposalId) represented.add(p.proposalId);
        if (!inWindow(won)) continue;
        const po = amount(p.poValue, proposal.poValue, proposal.poDetails?.value);
        add('proposals', 'won', p, { ...proposal, ...p },
            po !== null ? po : amount(p.quoteValue, p.projectValue, p.value, p.pricing?.quoteValue, proposal.pricing?.quoteValue),
            po !== null ? p.poCurrency || proposal.poCurrency || proposal.poDetails?.currency : p.currency || p.pricing?.currency || proposal.pricing?.currency,
            won, p, 'won');
    }
    for (const p of proposals) {
        if (p.status !== 'won' || represented.has(p.id) || !inWindow(p.wonDate)) continue;
        const po = amount(p.poValue, p.poDetails?.value);
        add('proposals', 'won', p, p, po !== null ? po : amount(p.pricing?.quoteValue),
            po !== null ? p.poCurrency || p.poDetails?.currency : p.pricing?.currency, p.wonDate, p, 'won');
    }
    for (const e of entries) {
        if (!['quote', 'won', 'variation'].includes(e.type)) continue;
        add('manual', e.type, e, e, amount(e.value), e.currency, e.date || e.createdAt, e);
    }
    // Purchase portal projects are separate from BDM sales: only the initial approved
    // sales value and award date are reported, never project costs.
    for (const p of purchaseProjects) {
        if (!p.sales || !p.sales.include) continue;
        add('purchase', 'purchase', p, { bdmUid: 'purchase-portal', bdmName: 'Purchase portal' }, amount(p.sales.value), p.sales.currency, p.sales.date,
            { id: p.id, projectName: p.name, projectNumber: p.projectNumber, clientCompany: p.client }, 'approved');
    }
    // Same figures as the COO analytics proposal charts: proposals marked won since 1 Dec 2025,
    // at their quoted value, dated by won date (or last update). Shown only as charts.
    const proposalWins = proposals.filter(p => p.status === 'won').map(p => {
        const user = byUid.get(p.createdByUid);
        return { date: date(p.wonDate) || date(p.updatedAt), bdmName: p.createdByName || (user && (user.name || user.displayName)) || 'Unknown', value: amount(p.pricing?.quoteValue) || 0 };
    }).filter(p => p.date && p.date >= PROPOSAL_WINS_FROM);
    return { rows, proposalWins, bdms: users.filter(u => u.role === 'bdm').map(u => ({ id: u.id, name: u.name || u.displayName || u.email || 'Unnamed BDM' })),
        generatedAt: new Date().toISOString(),
        basis: 'BDM sales = won value + variations entered by BDMs in Upload Quote / Won; quotes are the quote values entered there. Proposals marked won from 1 Dec 2025 to 31 Mar 2026 are added because uploads started in April 2026; other proposal values are never included. This is not invoiced revenue or cash collected. Purchase portal projects are a separate source (initial approved sales value at the award / PO date) and are not attributed to any BDM.' };
}
module.exports = { buildReport };
