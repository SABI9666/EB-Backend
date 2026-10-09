'use strict';
// Values remain in their original currencies. Manual uploads are a separate ledger.
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
function buildReport({ users, projects, proposals, variations, entries }) {
    const byUid = new Map(users.map(u => [u.id, u]));
    const byEmail = new Map(users.filter(u => u.email).map(u => [u.email.trim().toLowerCase(), u]));
    const proposalMap = new Map(proposals.map(p => [p.id, p]));
    const projectMap = new Map(projects.map(p => [p.id, p]));
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
    const represented = new Set();
    for (const p of projects) {
        const proposal = proposalMap.get(p.proposalId) || p.proposal || {};
        const won = p.wonDate || proposal.wonDate;
        // Legacy project creation does not copy wonDate; use its linked won proposal.
        if (!won && proposal.status !== 'won' && p.status !== 'won') continue;
        if (p.proposalId) represented.add(p.proposalId);
        const hasPO = amount(p.poValue, proposal.poValue, proposal.poDetails?.value) !== null;
        add('projects', 'won', p, { ...proposal, ...p },
            hasPO ? amount(p.poValue, proposal.poValue, proposal.poDetails?.value) : amount(p.quoteValue, p.projectValue, p.value, p.pricing?.quoteValue, proposal.pricing?.quoteValue),
            hasPO ? p.poCurrency || proposal.poCurrency || proposal.poDetails?.currency : p.currency || p.pricing?.currency || proposal.pricing?.currency,
            won, p);
    }
    for (const p of proposals) {
        if (p.status === 'won' && !represented.has(p.id)) {
            const hasPO = amount(p.poValue, p.poDetails?.value) !== null;
            add('projects', 'won', p, p, hasPO ? amount(p.poValue, p.poDetails?.value) : amount(p.pricing?.quoteValue),
                hasPO ? p.poCurrency || p.poDetails?.currency : p.pricing?.currency, p.wonDate, p);
        }
        if (amount(p.pricing?.quoteValue) !== null) add('projects', 'quote', p, p, amount(p.pricing.quoteValue), p.pricing.currency,
            p.pricing.pricedAt || p.pricing.lastEditedAt || p.submittedToClientAt || p.createdAt, p);
    }
    for (const v of variations) {
        if (v.status !== 'approved') continue;
        const p = projectMap.get(v.parentProjectId || v.projectId) || {};
        const proposal = proposalMap.get(p.proposalId) || {};
        add('projects', 'variation', v, { ...proposal, ...p }, amount(v.approvedValue, v.value, v.amount, v.quoteValue, v.totalValue, v.variationValue),
            v.currency || p.currency, v.approvedAt || v.updatedAt, { ...p, id: p.id || v.parentProjectId || v.id });
    }
    for (const e of entries) {
        if (!['quote', 'won', 'variation'].includes(e.type)) continue;
        add('manual', e.type, e, e, amount(e.value), e.currency, e.date || e.createdAt, e);
    }
    return { rows, bdms: users.filter(u => u.role === 'bdm').map(u => ({ id: u.id, name: u.name || u.displayName || u.email || 'Unnamed BDM' })),
        generatedAt: new Date().toISOString(),
        basis: 'Booked sales = won project / PO value + approved variations. This is not invoiced revenue or cash collected. Manual BDM uploads are reported separately and are never added to project records.' };
}
module.exports = { buildReport };
