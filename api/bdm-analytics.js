// api/bdm-analytics.js
// BDM analytics report (weekly / monthly / quarterly / yearly).
// Restricted to COO and Director.
//
// Sources (in this order, merged together):
//   1. proposals.pricing.* — set by COO pricing portal
//   2. projects collection — wins recorded by Director portal
//   3. variations collection — approved variations
//   4. bdm_entries collection — manual quote/won uploads from BDMs
//      (the COO portal isn't the only source of truth; BDM/COO/Director can
//      file quotes directly via /api/bdm-entries — those flow in here too)

const admin = require('./_firebase-admin');
const { verifyToken } = require('../middleware/auth');
const util = require('util');

const db = admin.firestore();

const allowCors = (fn) => async (req, res) => {
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization'
    );
    if (req.method === 'OPTIONS') { res.status(200).end(); return; }
    return await fn(req, res);
};

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
        // Only count a project as won when it has an explicit wonDate.
        // Without this, every in-progress project (which always has a
        // createdAt / updatedAt) would be bucketed as a "win" in the
        // week / month it was created — inflating the per-period
        // numProjectsWon / projectValue numbers in the charts.
        for (const proj of projects) {
            const bdmUid = proj.bdmUid || (proj.proposal && proj.proposal.createdByUid);
            if (!bdmUid) continue;
            const wonDate = toJsDate(proj.wonDate);
            if (!wonDate) continue;
            const rawValue = num(proj.quoteValue) || num(proj.projectValue) || num(proj.value) || num(proj.pricing && proj.pricing.quoteValue);
            const currency = proj.currency || (proj.pricing && proj.pricing.currency) || '';
            bumpLifetime(bdmUid, proj.bdmName || '', 'win', toInr(rawValue, currency));
            if (wonDate < fromDate || wonDate > toDate) continue;
            winsInRange += 1;
            const stats = ensure(bdmUid, proj.bdmName || '');
            const key = periodKey(wonDate, granularity);
            if (!key) continue;
            const period = ensurePeriod(stats, key);
            const projClient = proj.clientCompany || proj.clientName || '';
            period.wonProjects.push({
                projectId: proj.id, source: 'projects_collection',
                proposalId: proj.proposalId || '', date: wonDate.toISOString(),
                projectName: proj.projectName || proj.name || '',
                clientCompany: projClient, currency: 'INR',
                value: toInr(rawValue, currency),
                originalCurrency: currency, originalValue: rawValue
            });
            if (projClient && stats.firstClientSeen[projClient] == null) {
                stats.firstClientSeen[projClient] = wonDate.getTime();
            }
        }

        for (const stats of Object.values(bdmStats)) {
            for (const period of Object.values(stats.periods)) {
                period.quotes.forEach((q) => {
                    if (!q.clientCompany) return;
                    const firstMs = stats.firstClientSeen[q.clientCompany];
                    if (firstMs && new Date(q.date).getTime() === firstMs) {
                        period.newClients.add(q.clientCompany);
                    }
                });
            }
        }

        // ---------- variations ----------
        const projectIdToBdm = {};
        for (const p of proposals) {
            if (p.projectId && p.createdByUid) {
                projectIdToBdm[p.projectId] = { bdmUid: p.createdByUid, bdmName: p.createdByName || '' };
            }
        }
        function resolveOwner(parentProjectId) {
            if (!parentProjectId) return null;
            if (projectIdToBdm[parentProjectId]) return projectIdToBdm[parentProjectId];
            const proj = projectById[parentProjectId];
            if (proj && proj.bdmUid) {
                projectIdToBdm[parentProjectId] = { bdmUid: proj.bdmUid, bdmName: proj.bdmName || '' };
                return projectIdToBdm[parentProjectId];
            }
            return null;
        }

        for (const v of variations) {
            if (v.status !== 'approved') continue;
            const approvedAt = toJsDate(v.approvedAt) || toJsDate(v.updatedAt);
            const rawValue = pickAmount(v, ['value', 'approvedValue', 'amount', 'quoteValue', 'totalValue', 'variationValue']);
            const currency = v.currency || '';
            const owner = resolveOwner(v.parentProjectId);
            if (owner) bumpLifetime(owner.bdmUid, owner.bdmName, 'variation', toInr(rawValue, currency));
            if (!approvedAt || approvedAt < fromDate || approvedAt > toDate) continue;
            variationsInRange += 1;
            if (!owner) continue;
            const stats = ensure(owner.bdmUid, owner.bdmName);
            const key = periodKey(approvedAt, granularity);
            if (!key) continue;
            const period = ensurePeriod(stats, key);
            period.variations.push({
                variationId: v.id, source: 'variations_collection',
                date: approvedAt.toISOString(),
                variationCode: v.variationCode || '',
                projectName: v.parentProjectName || '',
                clientCompany: v.clientCompany || '',
                estimatedHours: num(v.estimatedHours),
                currency: 'INR', value: toInr(rawValue, currency),
                originalCurrency: currency, originalValue: rawValue
            });
        }

        // ---------- merge bdm_entries (manual uploads) ----------
        // Each manual entry adds a quote/win/variation row directly. We use
        // the same per-period structures so cards / lifetime totals / Excel
        // download all reflect the manual data without further plumbing.
        for (const e of manualEntries) {
            // bdmUid is the canonical owner. Fall back through every
            // identity field we ever stored so an entry written with an
            // older identifier still attributes to the right BDM record.
            // Order: stored bdmUid (preferred) -> createdByUid -> stored
            // email mapped via bdmEmailToUid -> createdByEmail mapped the
            // same way -> the raw email itself as a last-resort key.
            const storedBdmEmail = String(e.bdmEmail || '').toLowerCase();
            const storedCreatedEmail = String(e.createdByEmail || '').toLowerCase();
            const bdmUid =
                e.bdmUid ||
                e.createdByUid ||
                bdmEmailToUid[storedBdmEmail] ||
                bdmEmailToUid[storedCreatedEmail] ||
                storedBdmEmail ||
                storedCreatedEmail ||
                '';
            if (!bdmUid) continue;
            const entryDate = toJsDate(e.date) || toJsDate(e.createdAt);
            if (!entryDate) continue;

            const rawValue = num(e.value);
            const currency = e.currency || 'INR';
            const valueInr = toInr(rawValue, currency);
            const stats = ensure(bdmUid, e.bdmName);

            // Lifetime tally — ignores from/to filter, like the other sources.
            if (e.type === 'quote') bumpLifetime(bdmUid, e.bdmName, 'quote', valueInr);
            else if (e.type === 'won') bumpLifetime(bdmUid, e.bdmName, 'win', valueInr);
            else if (e.type === 'variation') bumpLifetime(bdmUid, e.bdmName, 'variation', valueInr);

            const client = (e.clientCompany || '').trim();
            if (client) {
                const lb = lifetimePerBdm[bdmUid];
                if (lb && !lb.clients.has(client)) {
                    lb.clients.add(client); lb.numNewClients += 1; lifetimeTotals.numNewClients += 1;
                }
            }

            // In-window assignment to a period bucket.
            if (entryDate < fromDate || entryDate > toDate) continue;
            const key = periodKey(entryDate, granularity);
            if (!key) continue;
            const period = ensurePeriod(stats, key);

            if (e.type === 'quote') {
                manualQuotesInRange += 1;
                period.quotes.push({
                    proposalId: e.id, source: 'manual_entry',
                    date: entryDate.toISOString(),
                    pricedAt: null, pricedByName: e.createdByName || '',
                    projectName: e.projectName || '', clientCompany: client,
                    projectNumber: e.projectNumber || '',
                    currency: 'INR', value: valueInr,
                    originalCurrency: currency, originalValue: rawValue,
                    status: 'manual'
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
                    (p[key] || []).forEach((rec) => {
                        out.push(Object.assign({ bdmUid: b.bdmUid, bdmName: b.bdmName, period: p.period }, rec));
                    });
                });
            });
            return out;
        };

        if (section === 'quotes') {
            return res.status(200).json({
                success: true,
                data: {
                    section: 'quotes', granularity,
                    from: fromDate.toISOString(), to: toDate.toISOString(),
                    quotes: flattenDetail('quotes'),
                    meta: { quotesInRange, manualQuotesInRange, currencyMode: 'INR', truncated }
                }
            });
        }
        if (section === 'wins') {
            return res.status(200).json({
                success: true,
                data: {
                    section: 'wins', granularity,
                    from: fromDate.toISOString(), to: toDate.toISOString(),
                    wonProjects: flattenDetail('wonProjects'),
                    meta: { winsInRange, manualWinsInRange, currencyMode: 'INR', truncated }
                }
            });
        }
        if (section === 'variations') {
            return res.status(200).json({
                success: true,
                data: {
                    section: 'variations', granularity,
                    from: fromDate.toISOString(), to: toDate.toISOString(),
                    variations: flattenDetail('variations'),
                    meta: { variationsInRange, manualVariationsInRange, currencyMode: 'INR', truncated }
                }
            });
        }

        return res.status(200).json({
            success: true,
            data: {
                section, granularity,
                from: fromDate.toISOString(), to: toDate.toISOString(),
                periodKeys: Array.from(allPeriodKeys).sort(),
                bdms: result, totals: grandTotals,
                lifetime: { totals: lifetimeTotals, bdms: lifetimeBdms, currency: 'INR' },
                meta: {
                    proposalsScanned,
                    projectsScanned: projects.length,
                    variationsScanned: variations.length,
                    manualEntriesScanned: manualEntries.length,
                    quotesInRange, winsInRange, variationsInRange,
                    manualQuotesInRange, manualWinsInRange, manualVariationsInRange,
                    bdmCount: result.length, currencyMode: 'INR',
                    sources: ['proposals', 'projects', 'variations', 'bdm_entries'],
                    winsSource: 'projects collection + bdm_entries',
                    truncated, fxRates: CURRENCY_TO_INR
                }
            }
        });
    } catch (error) {
        console.error('BDM analytics API error:', error);
        return res.status(500).json({
            success: false,
            error: 'Internal Server Error',
            message: error.message
        });
    }
};

module.exports = allowCors(handler);
module.exports.config = { maxDuration: 60, memory: 1024 };
