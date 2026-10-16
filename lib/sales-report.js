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
// BDM sales come only from the values BDMs enter in "Upload Quote / Won" (bdm_entries).
// Proposal pricing, proposals marked won and project records are deliberately not read.
function buildReport({ users, entries, purchaseProjects = [] }) {
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
    return { rows, bdms: users.filter(u => u.role === 'bdm').map(u => ({ id: u.id, name: u.name || u.displayName || u.email || 'Unnamed BDM' })),
        generatedAt: new Date().toISOString(),
        basis: 'BDM sales = won value + variations entered by BDMs in Upload Quote / Won; quotes are the quote values entered there. Proposal values are never included. This is not invoiced revenue or cash collected. Purchase portal projects are a separate source (initial approved sales value at the award / PO date) and are not attributed to any BDM.' };
}
module.exports = { buildReport };
