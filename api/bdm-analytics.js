// api/bdm-analytics.js
// BDM analytics aggregator: per-BDM × per-period roll-up of quotes,
// project wins and approved variations sourced from proposals,
// projects, variations and bdm_entries collections.
// Restricted to COO and Director.
//
// Sources:
//   1. proposals collection — once a proposal has COO pricing it counts
//      as a quote (regardless of follow-up status changes).
//   2. projects collection — wins (with date attribution).
//   3. variations collection — approved variations.
//   4. bdm_entries collection — manual quote/won uploads from BDMs
//
// Lifetime totals are computed independently of the from/to filter so the
// COO/Director always sees a real number even when the selected window is
// empty.

const util = require('util');
const { db, verifyToken } = require('./_firebase-admin');

// ---------- helpers ----------

function toJsDate(ts) {
    if (!ts) return null;
    if (ts instanceof Date) return isNaN(ts.getTime()) ? null : ts;
    if (ts.toDate) return ts.toDate();
    if (ts._seconds != null) return new Date(ts._seconds * 1000);
    if (ts.seconds != null) return new Date(ts.seconds * 1000);
    if (typeof ts === 'string' || typeof ts === 'number') {
        const d = new Date(ts);
        return isNaN(d) ? null : d;
    }
    return null;
}

function isoWeek(d) {
    const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
    return { year: date.getUTCFullYear(), week };
}

function periodKey(date, granularity) {
    const d = toJsDate(date);
    if (!d) return null;
    const y = d.getFullYear();
    if (granularity === 'year') return `${y}`;
    if (granularity === 'quarter') return `${y}-Q${Math.floor(d.getMonth() / 3) + 1}`;
    if (granularity === 'month') return `${y}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (granularity === 'week') {
        const { year, week } = isoWeek(d);
        return `${year}-W${String(week).padStart(2, '0')}`;
    }
    if (granularity === 'day') return `${y}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return null;
}

function num(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }

function pickAmount(obj, keys) {
    if (!obj) return 0;
    for (const k of keys) {
        if (obj[k] != null && obj[k] !== '') {
            const n = num(obj[k]);
            if (n) return n;
        }
    }
    return 0;
}

const CURRENCY_TO_INR = {
    INR: 1, USD: 83.5, AUD: 55.0, NZD: 51.0, EUR: 90.0,
    GBP: 105.0, SGD: 62.0, AED: 22.7, CAD: 61.0, JPY: 0.55
};

function toInr(value, currency) {
    const v = num(value);
    if (!v) return 0;
    const c = String(currency || '').trim().toUpperCase();
    if (!c) return v;
    const rate = CURRENCY_TO_INR[c];
    return rate != null ? v * rate : v;
}

const handler = async (req, res) => {
    try {
        await util.promisify(verifyToken)(req, res);

        if (!['coo', 'director'].includes(req.user.role)) {
            return res.status(403).json({ success: false, error: 'BDM analytics is restricted to COO and Director.' });
        }
        if (req.method !== 'GET') {
            return res.status(405).json({ success: false, error: 'Method not allowed' });
        }

        const { granularity = 'month', from, to } = req.query;
        if (!['day', 'week', 'month', 'quarter', 'year'].includes(granularity)) {
            return res.status(400).json({ success: false, error: 'Invalid granularity' });
        }

        const section = String(req.query.section || 'summary').toLowerCase();
        if (!['summary', 'quotes', 'wins', 'variations', 'all'].includes(section)) {
            return res.status(400).json({ success: false, error: 'Invalid section' });
        }

        const now = new Date();
        const fromDate = from ? new Date(from) : new Date(now.getFullYear() - 5, 0, 1);
        const toDate = to ? new Date(to) : now;
        if (!isNaN(fromDate)) fromDate.setUTCHours(0, 0, 0, 0);
        if (!isNaN(toDate)) toDate.setUTCHours(23, 59, 59, 999);

        // Bounded reads — fixed-size I/O regardless of workspace size.
        const SCAN_LIMIT = Math.max(50, Math.min(parseInt(req.query.limit, 10) || 1500, 5000));

        const [bdmsSnap, proposalsSnap, projectsSnap, variationsSnap, entriesSnap] = await Promise.all([
            db.collection('users').where('role', '==', 'bdm').get(),
            db.collection('proposals').orderBy('updatedAt', 'desc').limit(SCAN_LIMIT).get().catch(() => ({ docs: [], size: 0 })),
            db.collection('projects').orderBy('createdAt', 'desc').limit(SCAN_LIMIT).get().catch(() => ({ docs: [], size: 0 })),
            db.collection('variations').orderBy('updatedAt', 'desc').limit(SCAN_LIMIT).get().catch(() => ({ docs: [], size: 0 })),
            // Manual entries from BDMs / COO / Director via /api/bdm-entries.
            // Soft-fail (returns empty) so missing collection / index doesn't
            // break the whole report.
            db.collection('bdm_entries').orderBy('date', 'desc').limit(SCAN_LIMIT).get().catch(() => ({ docs: [], size: 0 }))
        ]);

        const truncated = {
            proposals: proposalsSnap.size >= SCAN_LIMIT,
            projects: projectsSnap.size >= SCAN_LIMIT,
            variations: variationsSnap.size >= SCAN_LIMIT,
            entries: entriesSnap.size >= SCAN_LIMIT,
            scanLimit: SCAN_LIMIT
        };

        const bdmMap = {};
        // Email -> canonical bdmUid lookup. Lets us re-attribute manual
        // entries that were saved with an email instead of (or in addition
        // to) a Firebase uid back to the right BDM record.
        const bdmEmailToUid = {};
        bdmsSnap.forEach((doc) => {
            const u = doc.data();
            bdmMap[doc.id] = {
                bdmUid: doc.id,
                bdmName: u.name || u.displayName || u.email || 'Unknown',
                bdmEmail: u.email || ''
            };
            const e = String(u.email || '').toLowerCase();
            if (e) bdmEmailToUid[e] = doc.id;
        });

        const proposals = proposalsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
        const projects = projectsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
        const variations = variationsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
        const manualEntries = entriesSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

        const projectById = {};
        projects.forEach((proj) => { projectById[proj.id] = proj; });

        if (req.query.debug === 'raw') {
            return res.status(200).json({
                success: true, debug: 'raw',
                counts: {
                    proposals: proposals.length, projects: projects.length,
                    variations: variations.length, manualEntries: manualEntries.length,
                    bdms: Object.keys(bdmMap).length
                },
                samples: {
                    proposals: proposals.slice(0, 3), projects: projects.slice(0, 3),
                    variations: variations.slice(0, 3), manualEntries: manualEntries.slice(0, 3),
                    bdms: Object.values(bdmMap).slice(0, 3)
                },
                truncated
            });
        }

        const bdmStats = {};
        function ensure(bdmUid, bdmName) {
            if (!bdmStats[bdmUid]) {
                bdmStats[bdmUid] = {
                    bdmUid,
                    bdmName: bdmName || (bdmMap[bdmUid] && bdmMap[bdmUid].bdmName) || 'Unknown',
                    bdmEmail: (bdmMap[bdmUid] && bdmMap[bdmUid].bdmEmail) || '',
                    periods: {}, firstClientSeen: {}
                };
            }
            return bdmStats[bdmUid];
        }
        function ensurePeriod(stats, key) {
            if (!stats.periods[key]) {
                stats.periods[key] = {
                    key, quotes: [], wonProjects: [], variations: [],
                    clients: new Set(), newClients: new Set()
                };
            }
            return stats.periods[key];
        }

        Object.values(bdmMap).forEach((b) => ensure(b.bdmUid, b.bdmName));

        let proposalsScanned = 0, quotesInRange = 0, winsInRange = 0, variationsInRange = 0;
        let manualQuotesInRange = 0, manualWinsInRange = 0, manualVariationsInRange = 0;

        const lifetimeTotals = {
            numQuotes: 0, quoteValueTotal: 0, numProjectsWon: 0,
            projectValue: 0, variationValue: 0, totalValue: 0, numNewClients: 0
        };
        const lifetimePerBdm = {};
        function bumpLifetime(bdmUid, bdmName, kind, valueInr) {
            if (!lifetimePerBdm[bdmUid]) {
                lifetimePerBdm[bdmUid] = {
                    bdmUid,
                    bdmName: bdmName || (bdmMap[bdmUid] && bdmMap[bdmUid].bdmName) || 'Unknown',
                    numQuotes: 0, quoteValueTotal: 0, numProjectsWon: 0,
                    projectValue: 0, variationValue: 0, totalValue: 0,
                    numNewClients: 0, clients: new Set()
                };
            }
            const b = lifetimePerBdm[bdmUid];
            if (kind === 'quote') { b.numQuotes += 1; b.quoteValueTotal += valueInr; lifetimeTotals.numQuotes += 1; lifetimeTotals.quoteValueTotal += valueInr; }
            else if (kind === 'win') { b.numProjectsWon += 1; b.projectValue += valueInr; b.totalValue += valueInr; lifetimeTotals.numProjectsWon += 1; lifetimeTotals.projectValue += valueInr; lifetimeTotals.totalValue += valueInr; }
            else if (kind === 'variation') { b.variationValue += valueInr; b.totalValue += valueInr; lifetimeTotals.variationValue += valueInr; lifetimeTotals.totalValue += valueInr; }
        }
        Object.values(bdmMap).forEach((b) => bumpLifetime(b.bdmUid, b.bdmName, '_seed', 0));

        // ---------- proposals → quotes (COO portal pricing) ----------
        for (const p of proposals) {
            proposalsScanned += 1;
            const bdmUid = p.createdByUid;
            if (!bdmUid) continue;
            const bdmName = p.createdByName;
            const stats = ensure(bdmUid, bdmName);
            const client = (p.clientCompany || '').trim();
            const pricedAt = toJsDate(p.pricing && p.pricing.pricedAt);
            const lastEditedAt = toJsDate(p.pricing && p.pricing.lastEditedAt);
            const submittedAt = toJsDate(p.submittedToClientAt) || toJsDate(p.submittedAt);
            const updatedAt = toJsDate(p.updatedAt);
            const createdAt = toJsDate(p.createdAt);

            const QUOTE_STATUSES = new Set(['priced', 'pricing_complete', 'won', 'lost']);
            const hasCooPricing = p.pricing && (
                p.pricing.quoteValue != null || p.pricing.pricedAt ||
                p.pricing.lastEditedAt || p.pricing.pricedBy
            );
            const hasPricing = hasCooPricing || QUOTE_STATUSES.has(p.status);
            const quoteDate = pricedAt || lastEditedAt || submittedAt || updatedAt || createdAt;

            if (hasPricing) {
                const _rawValue = num(p.pricing && p.pricing.quoteValue);
                const _currency = (p.pricing && p.pricing.currency) || '';
                bumpLifetime(bdmUid, bdmName, 'quote', toInr(_rawValue, _currency));
                if (client) {
                    const lb = lifetimePerBdm[bdmUid];
                    if (lb && !lb.clients.has(client)) {
                        lb.clients.add(client); lb.numNewClients += 1; lifetimeTotals.numNewClients += 1;
                    }
                }
            }
            if (hasPricing && quoteDate && quoteDate >= fromDate && quoteDate <= toDate) {
                quotesInRange += 1;
                const rawValue = num(p.pricing && p.pricing.quoteValue);
                const currency = (p.pricing && p.pricing.currency) || '';
                const valueInr = toInr(rawValue, currency);
                const key = periodKey(quoteDate, granularity);
                if (key) {
                    const period = ensurePeriod(stats, key);
                    period.quotes.push({
                        proposalId: p.id, source: 'coo_portal',
                        date: quoteDate.toISOString(),
                        pricedAt: pricedAt ? pricedAt.toISOString() : null,
                        pricedByName: (p.pricing && p.pricing.pricedByName) || '',
                        projectName: p.projectName || '', clientCompany: client,
                        projectNumber: (p.pricing && p.pricing.projectNumber) || '',
                        currency: 'INR', value: valueInr,
                        originalCurrency: currency, originalValue: rawValue,
                        status: p.status || ''
                    });
                    if (client) period.clients.add(client);
                    const ms = quoteDate.getTime();
                    if (client && (stats.firstClientSeen[client] == null || ms < stats.firstClientSeen[client])) {
                        stats.firstClientSeen[client] = ms;
                    }
                }
            }
        }

        // ---------- projects → wins ----------
        for (const proj of projects) {
            const bdmUid = proj.bdmUid || (proj.proposal && proj.proposal.createdByUid);
            if (!bdmUid) continue;
            const wonDate = toJsDate(proj.wonDate) || toJsDate(proj.createdAt) || toJsDate(proj.updatedAt);
            const rawValue = num(proj.quoteValue) || num(proj.projectValue) || num(proj.value) || num(proj.pricing && proj.pricing.quoteValue);
            const currency = proj.currency || (proj.pricing && proj.pricing.currency) || '';
            bumpLifetime(bdmUid, proj.bdmName || '', 'win', toInr(rawValue, currency));
            if (!wonDate || wonDate < fromDate || wonDate > toDate) continue;
            winsInRange += 1;
            const stats = ensure(bdmUid, proj.bdmName || '');
            const key = periodKey(wonDate, granularity);
            if (!key) continue;
            const period = ensurePeriod(stats, key);
            const projClient = proj.clientCompany || proj.clientName || '';
            period.wonProjects.push({
                projectId: proj.id, source: 'project',
                proposalId: proj.proposalId || (proj.proposal && proj.proposal.id) || '',
                date: wonDate.toISOString(),
                projectName: proj.projectName || proj.name || '',
                clientCompany: projClient,
                currency: 'INR', value: toInr(rawValue, currency),
                originalCurrency: currency, originalValue: rawValue
            });
            if (projClient) {
                period.clients.add(projClient);
                const lb = lifetimePerBdm[bdmUid];
                if (lb && !lb.clients.has(projClient)) {
                    lb.clients.add(projClient); lb.numNewClients += 1; lifetimeTotals.numNewClients += 1;
                }
                const ms = wonDate.getTime();
                if (stats.firstClientSeen[projClient] == null || ms < stats.firstClientSeen[projClient]) {
                    stats.firstClientSeen[projClient] = ms;
                }
            }
        }

        // ---------- variations → approved variations ----------
        for (const v of variations) {
            const isApproved = (v.status || '').toLowerCase() === 'approved' || v.approved === true;
            if (!isApproved) continue;
            const proj = v.projectId ? projectById[v.projectId] : null;
            const bdmUid = v.bdmUid || (proj && proj.bdmUid) || (proj && proj.proposal && proj.proposal.createdByUid);
            if (!bdmUid) continue;
            const approvedAt = toJsDate(v.approvedAt) || toJsDate(v.updatedAt) || toJsDate(v.createdAt);
            const rawValue = pickAmount(v, ['variationValue', 'amount', 'value', 'quoteValue']);
            const vcurrency = v.currency || (proj && proj.currency) || '';
            const valueInr = toInr(rawValue, vcurrency);
            bumpLifetime(bdmUid, (proj && proj.bdmName) || '', 'variation', valueInr);
            if (!approvedAt || approvedAt < fromDate || approvedAt > toDate) continue;
            variationsInRange += 1;
            const stats = ensure(bdmUid, (proj && proj.bdmName) || '');
            const key = periodKey(approvedAt, granularity);
            if (!key) continue;
            const period = ensurePeriod(stats, key);
            const vClient = v.clientCompany || (proj && (proj.clientCompany || proj.clientName)) || '';
            period.variations.push({
                variationId: v.id, source: 'variation',
                projectId: v.projectId || '', date: approvedAt.toISOString(),
                variationCode: v.variationCode || v.code || '',
                projectName: v.projectName || (proj && (proj.projectName || proj.name)) || '',
                clientCompany: vClient,
                estimatedHours: num(v.estimatedHours),
                currency: 'INR', value: valueInr,
                originalCurrency: vcurrency, originalValue: rawValue
            });
        }

        // ---------- bdm_entries → manual quote / won / variation uploads ----------
        for (const e of manualEntries) {
            const entryDate = toJsDate(e.date) || toJsDate(e.createdAt);
            const rawBdmUid = e.bdmUid || e.uid || '';
            const rawEmail = String(e.bdmEmail || e.email || '').toLowerCase();
            // Resolve to a known BDM record. If the entry was saved with
            // only an email, look up the canonical uid so a previously
            // older identifier still attributes to the right BDM record.
            let bdmUid = rawBdmUid;
            if (!bdmUid && rawEmail) bdmUid = bdmEmailToUid[rawEmail] || '';
            if (bdmUid && !bdmMap[bdmUid] && rawEmail) {
                const fallback = bdmEmailToUid[rawEmail];
                if (fallback) bdmUid = fallback;
            }
            if (!bdmUid) continue;
            const bdmName = e.bdmName || (bdmMap[bdmUid] && bdmMap[bdmUid].bdmName) || '';
            const stats = ensure(bdmUid, bdmName);
            const client = (e.clientCompany || '').trim();
            const rawValue = num(e.value);
            const currency = e.currency || 'INR';
            const valueInr = toInr(rawValue, currency);

            // Lifetime tally — ignores from/to filter, like the other sources.
            if (e.type === 'quote') bumpLifetime(bdmUid, bdmName, 'quote', valueInr);
            else if (e.type === 'won') bumpLifetime(bdmUid, bdmName, 'win', valueInr);
            else if (e.type === 'variation') bumpLifetime(bdmUid, bdmName, 'variation', valueInr);
            if (client && (e.type === 'quote' || e.type === 'won')) {
                const lb = lifetimePerBdm[bdmUid];
                if (lb && !lb.clients.has(client)) {
                    lb.clients.add(client); lb.numNewClients += 1; lifetimeTotals.numNewClients += 1;
                }
            }

            // In-window assignment to a period bucket.
            if (!entryDate || entryDate < fromDate || entryDate > toDate) continue;
            const key = periodKey(entryDate, granularity);
            if (!key) continue;
            const period = ensurePeriod(stats, key);
            if (e.type === 'quote') {
                manualQuotesInRange += 1;
                period.quotes.push({
                    proposalId: e.id, source: 'manual_entry',
                    date: entryDate.toISOString(),
                    projectName: e.projectName || '', clientCompany: client,
                    projectNumber: e.projectNumber || '',
                    currency: 'INR', value: valueInr,
                    originalCurrency: currency, originalValue: rawValue,
                    status: e.status || 'manual'
                });
                if (client) period.clients.add(client);
                const ms = entryDate.getTime();
                if (client && (stats.firstClientSeen[client] == null || ms < stats.firstClientSeen[client])) {
                    stats.firstClientSeen[client] = ms;
                    period.newClients.add(client);
                }
            } else if (e.type === 'won') {
                manualWinsInRange += 1;
                period.wonProjects.push({
                    projectId: e.id, source: 'manual_entry',
                    proposalId: '', date: entryDate.toISOString(),
                    projectName: e.projectName || '', clientCompany: client,
                    currency: 'INR', value: valueInr,
                    originalCurrency: currency, originalValue: rawValue
                });
            } else if (e.type === 'variation') {
                manualVariationsInRange += 1;
                period.variations.push({
                    variationId: e.id, source: 'manual_entry',
                    date: entryDate.toISOString(),
                    variationCode: e.projectNumber || '',
                    projectName: e.projectName || '', clientCompany: client,
                    estimatedHours: 0,
                    currency: 'INR', value: valueInr,
                    originalCurrency: currency, originalValue: rawValue
                });
            }
        }

        // ---------- shape response ----------
        const allPeriodKeys = new Set();
        const result = Object.values(bdmStats).map((stats) => {
            const periodRows = Object.values(stats.periods)
                .sort((a, b) => a.key.localeCompare(b.key))
                .map((period) => {
                    allPeriodKeys.add(period.key);
                    const projectValue = period.wonProjects.reduce((s, w) => s + num(w.value), 0);
                    const variationValue = period.variations.reduce((s, v) => s + num(v.value), 0);
                    const quoteValueTotal = period.quotes.reduce((s, q) => s + num(q.value), 0);
                    const row = {
                        period: period.key,
                        numQuotes: period.quotes.length, quoteValueTotal,
                        numProjectsWon: period.wonProjects.length, projectValue,
                        variationValue, totalValue: projectValue + variationValue,
                        numNewClients: period.newClients.size
                    };
                    if (section === 'all' || section === 'quotes') row.quotes = period.quotes;
                    if (section === 'all' || section === 'wins') row.wonProjects = period.wonProjects;
                    if (section === 'all' || section === 'variations') row.variations = period.variations;
                    return row;
                });
            const overall = periodRows.reduce((acc, r) => {
                acc.numQuotes += r.numQuotes; acc.quoteValueTotal += r.quoteValueTotal;
                acc.numProjectsWon += r.numProjectsWon; acc.projectValue += r.projectValue;
                acc.variationValue += r.variationValue; acc.totalValue += r.totalValue;
                acc.numNewClients += r.numNewClients; return acc;
            }, { numQuotes: 0, quoteValueTotal: 0, numProjectsWon: 0, projectValue: 0, variationValue: 0, totalValue: 0, numNewClients: 0 });
            return {
                bdmUid: stats.bdmUid, bdmName: stats.bdmName,
                bdmEmail: stats.bdmEmail, overall, periods: periodRows
            };
        });
        result.sort((a, b) => b.overall.projectValue - a.overall.projectValue);

        const grandTotals = result.reduce((acc, b) => {
            acc.numQuotes += b.overall.numQuotes; acc.quoteValueTotal += b.overall.quoteValueTotal;
            acc.numProjectsWon += b.overall.numProjectsWon; acc.projectValue += b.overall.projectValue;
            acc.variationValue += b.overall.variationValue; acc.totalValue += b.overall.totalValue;
            acc.numNewClients += b.overall.numNewClients; return acc;
        }, { numQuotes: 0, quoteValueTotal: 0, numProjectsWon: 0, projectValue: 0, variationValue: 0, totalValue: 0, numNewClients: 0 });

        const lifetimeBdms = Object.values(lifetimePerBdm)
            .map((b) => ({
                bdmUid: b.bdmUid, bdmName: b.bdmName,
                numQuotes: b.numQuotes, quoteValueTotal: b.quoteValueTotal,
                numProjectsWon: b.numProjectsWon, projectValue: b.projectValue,
                variationValue: b.variationValue, totalValue: b.totalValue,
                numNewClients: b.numNewClients
            }))
            .sort((a, b) => b.totalValue - a.totalValue);

        const flattenDetail = (key) => {
            const out = [];
            result.forEach((b) => {
                (b.periods || []).forEach((p) => {
                    (p[key] || []).forEach((row) => {
                        out.push({
                            bdmUid: b.bdmUid, bdmName: b.bdmName,
                            period: p.period, ...row
                        });
                    });
                });
            });
            return out;
        };

        const PAGE_SIZE = Math.max(50, Math.min(parseInt(req.query.pageSize, 10) || 200, 1000));
        const PAGE = Math.max(1, parseInt(req.query.page, 10) || 1);

        if (section === 'quotes') {
            const all = flattenDetail('quotes')
                .sort((a, b) => new Date(b.date) - new Date(a.date));
            const start = (PAGE - 1) * PAGE_SIZE;
            const slice = all.slice(start, start + PAGE_SIZE);
            return res.status(200).json({
                success: true,
                data: {
                    section: 'quotes', granularity,
                    from: fromDate.toISOString(), to: toDate.toISOString(),
                    totalCount: all.length, page: PAGE, pageSize: PAGE_SIZE,
                    items: slice
                },
                truncated
            });
        }
        if (section === 'wins') {
            const all = flattenDetail('wonProjects')
                .sort((a, b) => new Date(b.date) - new Date(a.date));
            const start = (PAGE - 1) * PAGE_SIZE;
            const slice = all.slice(start, start + PAGE_SIZE);
            return res.status(200).json({
                success: true,
                data: {
                    section: 'wins', granularity,
                    from: fromDate.toISOString(), to: toDate.toISOString(),
                    totalCount: all.length, page: PAGE, pageSize: PAGE_SIZE,
                    items: slice
                },
                truncated
            });
        }
        if (section === 'variations') {
            const all = flattenDetail('variations')
                .sort((a, b) => new Date(b.date) - new Date(a.date));
            const start = (PAGE - 1) * PAGE_SIZE;
            const slice = all.slice(start, start + PAGE_SIZE);
            return res.status(200).json({
                success: true,
                data: {
                    section: 'variations', granularity,
                    from: fromDate.toISOString(), to: toDate.toISOString(),
                    totalCount: all.length, page: PAGE, pageSize: PAGE_SIZE,
                    items: slice
                },
                truncated
            });
        }

        return res.status(200).json({
            success: true,
            data: {
                section, granularity,
                from: fromDate.toISOString(), to: toDate.toISOString(),
                periodKeys: Array.from(allPeriodKeys).sort(),
                totals: grandTotals,
                bdms: result,
                lifetime: { totals: lifetimeTotals, bdms: lifetimeBdms },
                meta: {
                    proposalsScanned, quotesInRange, winsInRange, variationsInRange,
                    manualQuotesInRange, manualWinsInRange, manualVariationsInRange
                }
            },
            truncated
        });
    } catch (err) {
        console.error('[bdm-analytics] error:', err);
        return res.status(500).json({ success: false, error: err.message || 'Internal error' });
    }
};

module.exports = handler;
module.exports.handler = handler;
