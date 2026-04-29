// api/bdm-analytics.js
// BDM analytics report (weekly / monthly / quarterly / yearly).
// Restricted to COO and Director.
//
// Returns per-BDM aggregations of:
//   - quotes uploaded (proposals with pricing)
//   - projects won (status = 'won')
//   - project values (won)
//   - variation values (approved variations on the BDM's projects)
//   - new clients (first-ever proposal for that client by that BDM)
// Plus a flat list of all quote uploads (date + value) per BDM and per period.

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
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }
    return await fn(req, res);
};

// ---------- helpers ----------------------------------------------------------

function toJsDate(ts) {
    if (!ts) return null;
    if (ts.toDate) return ts.toDate();
    if (ts._seconds != null) return new Date(ts._seconds * 1000);
    if (ts.seconds != null) return new Date(ts.seconds * 1000);
    if (typeof ts === 'string' || typeof ts === 'number') {
        const d = new Date(ts);
        return isNaN(d) ? null : d;
    }
    return null;
}

// ISO week number (1..53). Returns { year, week }.
function isoWeek(d) {
    const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    // Thursday in current week determines the year.
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
    if (granularity === 'quarter') {
        const q = Math.floor(d.getMonth() / 3) + 1;
        return `${y}-Q${q}`;
    }
    if (granularity === 'month') {
        const m = String(d.getMonth() + 1).padStart(2, '0');
        return `${y}-${m}`;
    }
    if (granularity === 'week') {
        const { year, week } = isoWeek(d);
        return `${year}-W${String(week).padStart(2, '0')}`;
    }
    if (granularity === 'day') {
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    }
    return null;
}

function num(v) {
    const n = parseFloat(v);
    return isNaN(n) ? 0 : n;
}

// Pick the first numeric field that exists. Used to be flexible about which
// field a variation's monetary value is stored under (different parts of the
// app have used different names over time).
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

// ---------- currency normalization to INR ----------------------------------
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

// ---------- main handler -----------------------------------------------------

const handler = async (req, res) => {
    try {
        await util.promisify(verifyToken)(req, res);

        if (!['coo', 'director'].includes(req.user.role)) {
            return res.status(403).json({
                success: false,
                error: 'BDM analytics is restricted to COO and Director.'
            });
        }

        if (req.method !== 'GET') {
            return res.status(405).json({ success: false, error: 'Method not allowed' });
        }

        const { granularity = 'month', from, to } = req.query;
        if (!['day', 'week', 'month', 'quarter', 'year'].includes(granularity)) {
            return res.status(400).json({ success: false, error: 'Invalid granularity' });
        }

        // Sectioned response. Default = `summary` returns lifetime totals plus
        // per-BDM / per-period numeric rollups (no per-record arrays).
        // `quotes` / `wins` / `variations` return only that flat detail list.
        const section = String(req.query.section || 'summary').toLowerCase();
        if (!['summary', 'quotes', 'wins', 'variations', 'all'].includes(section)) {
            return res.status(400).json({ success: false, error: 'Invalid section' });
        }

        const now = new Date();
        const fromDate = from ? new Date(from) : new Date(now.getFullYear() - 5, 0, 1);
        const toDate = to ? new Date(to) : now;
        if (!isNaN(fromDate)) fromDate.setUTCHours(0, 0, 0, 0);
        if (!isNaN(toDate)) toDate.setUTCHours(23, 59, 59, 999);

        // KEY DESIGN CHANGE — bounded reads via .orderBy().limit() so the
        // function does fixed-size I/O regardless of workspace size. This is
        // what fixes the persistent "Stream idle timeout".
        const SCAN_LIMIT = Math.max(50, Math.min(parseInt(req.query.limit, 10) || 1500, 5000));

        const [bdmsSnap, proposalsSnap, projectsSnap, variationsSnap] = await Promise.all([
            db.collection('users').where('role', '==', 'bdm').get(),
            db.collection('proposals').orderBy('updatedAt', 'desc').limit(SCAN_LIMIT).get(),
            db.collection('projects').orderBy('createdAt', 'desc').limit(SCAN_LIMIT).get(),
            db.collection('variations').orderBy('updatedAt', 'desc').limit(SCAN_LIMIT).get()
        ]);

        const truncated = {
            proposals: proposalsSnap.size >= SCAN_LIMIT,
            projects: projectsSnap.size >= SCAN_LIMIT,
            variations: variationsSnap.size >= SCAN_LIMIT,
            scanLimit: SCAN_LIMIT
        };

        const bdmMap = {};
        bdmsSnap.forEach((doc) => {
            const u = doc.data();
            bdmMap[doc.id] = {
                bdmUid: doc.id,
                bdmName: u.name || u.displayName || u.email || 'Unknown',
                bdmEmail: u.email || ''
            };
        });

        const proposals = proposalsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
        const projects = projectsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
        const variations = variationsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

        const projectById = {};
        projects.forEach((proj) => { projectById[proj.id] = proj; });

        if (req.query.debug === 'raw') {
            return res.status(200).json({
                success: true,
                debug: 'raw',
                counts: {
                    proposals: proposals.length,
                    projects: projects.length,
                    variations: variations.length,
                    bdms: Object.keys(bdmMap).length
                },
                samples: {
                    proposals: proposals.slice(0, 3),
                    projects: projects.slice(0, 3),
                    variations: variations.slice(0, 3),
                    bdms: Object.values(bdmMap).slice(0, 3)
                },
                truncated
            });
        }

        // ---------- per-BDM accumulator ----------
        const bdmStats = {};
        function ensure(bdmUid, bdmName) {
            if (!bdmStats[bdmUid]) {
                bdmStats[bdmUid] = {
                    bdmUid,
                    bdmName: bdmName || (bdmMap[bdmUid] && bdmMap[bdmUid].bdmName) || 'Unknown',
                    bdmEmail: (bdmMap[bdmUid] && bdmMap[bdmUid].bdmEmail) || '',
                    periods: {},
                    firstClientSeen: {}
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

        // ---------- bucket proposals into quotes ----------
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

            // QUOTE = proposal that the COO portal has actually priced.
            // pricing.* is set by the `add_pricing`/`update_pricing` actions.
            const QUOTE_STATUSES = new Set(['priced', 'pricing_complete', 'won', 'lost']);
            const hasCooPricing = p.pricing && (
                p.pricing.quoteValue != null ||
                p.pricing.pricedAt ||
                p.pricing.lastEditedAt ||
                p.pricing.pricedBy
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
                        lb.clients.add(client);
                        lb.numNewClients += 1;
                        lifetimeTotals.numNewClients += 1;
                    }
                }
            }

            if (hasPricing && quoteDate && quoteDate >= fromDate && quoteDate <= toDate) {
                quotesInRange += 1;
                const rawValue = num(p.pricing && p.pricing.quoteValue);
                const currency = (p.pricing && p.pricing.currency) || '';
                const projectNumber = (p.pricing && p.pricing.projectNumber) || '';
                const valueInr = toInr(rawValue, currency);
                const key = periodKey(quoteDate, granularity);
                if (key) {
                    const period = ensurePeriod(stats, key);
                    period.quotes.push({
                        proposalId: p.id,
                        date: quoteDate.toISOString(),
                        pricedAt: pricedAt ? pricedAt.toISOString() : null,
                        pricedByName: (p.pricing && p.pricing.pricedByName) || '',
                        projectName: p.projectName || '',
                        clientCompany: client,
                        projectNumber,
                        currency: 'INR',
                        value: valueInr,
                        originalCurrency: currency,
                        originalValue: rawValue,
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

        // ---------- bucket wins from PROJECTS ----------
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
                projectId: proj.id,
                proposalId: proj.proposalId || '',
                date: wonDate.toISOString(),
                projectName: proj.projectName || proj.name || '',
                clientCompany: projClient,
                currency: 'INR',
                value: toInr(rawValue, currency),
                originalCurrency: currency,
                originalValue: rawValue
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

        // ---------- bucket variations ----------
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
                variationId: v.id,
                date: approvedAt.toISOString(),
                variationCode: v.variationCode || '',
                projectName: v.parentProjectName || '',
                clientCompany: v.clientCompany || '',
                estimatedHours: num(v.estimatedHours),
                currency: 'INR',
                value: toInr(rawValue, currency),
                originalCurrency: currency,
                originalValue: rawValue
            });
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
                        numQuotes: period.quotes.length,
                        quoteValueTotal,
                        numProjectsWon: period.wonProjects.length,
                        projectValue,
                        variationValue,
                        totalValue: projectValue + variationValue,
                        numNewClients: period.newClients.size
                    };
                    if (section === 'all' || section === 'quotes') row.quotes = period.quotes;
                    if (section === 'all' || section === 'wins') row.wonProjects = period.wonProjects;
                    if (section === 'all' || section === 'variations') row.variations = period.variations;
                    return row;
                });
            const overall = periodRows.reduce((acc, r) => {
                acc.numQuotes += r.numQuotes;
                acc.quoteValueTotal += r.quoteValueTotal;
                acc.numProjectsWon += r.numProjectsWon;
                acc.projectValue += r.projectValue;
                acc.variationValue += r.variationValue;
                acc.totalValue += r.totalValue;
                acc.numNewClients += r.numNewClients;
                return acc;
            }, { numQuotes: 0, quoteValueTotal: 0, numProjectsWon: 0, projectValue: 0, variationValue: 0, totalValue: 0, numNewClients: 0 });
            return {
                bdmUid: stats.bdmUid,
                bdmName: stats.bdmName,
                bdmEmail: stats.bdmEmail,
                overall,
                periods: periodRows
            };
        });
        result.sort((a, b) => b.overall.projectValue - a.overall.projectValue);

        const grandTotals = result.reduce((acc, b) => {
            acc.numQuotes += b.overall.numQuotes;
            acc.quoteValueTotal += b.overall.quoteValueTotal;
            acc.numProjectsWon += b.overall.numProjectsWon;
            acc.projectValue += b.overall.projectValue;
            acc.variationValue += b.overall.variationValue;
            acc.totalValue += b.overall.totalValue;
            acc.numNewClients += b.overall.numNewClients;
            return acc;
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
                        out.push(Object.assign({
                            bdmUid: b.bdmUid, bdmName: b.bdmName, period: p.period
                        }, rec));
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
                    meta: { quotesInRange, currencyMode: 'INR', truncated }
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
                    meta: { winsInRange, currencyMode: 'INR', truncated }
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
                    meta: { variationsInRange, currencyMode: 'INR', truncated }
                }
            });
        }

        return res.status(200).json({
            success: true,
            data: {
                section, granularity,
                from: fromDate.toISOString(), to: toDate.toISOString(),
                periodKeys: Array.from(allPeriodKeys).sort(),
                bdms: result,
                totals: grandTotals,
                lifetime: { totals: lifetimeTotals, bdms: lifetimeBdms, currency: 'INR' },
                meta: {
                    proposalsScanned,
                    projectsScanned: projects.length,
                    variationsScanned: variations.length,
                    quotesInRange, winsInRange, variationsInRange,
                    bdmCount: result.length,
                    currencyMode: 'INR',
                    winsSource: 'projects collection',
                    truncated,
                    fxRates: CURRENCY_TO_INR
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

// Vercel function configuration. Default 10s ceiling is too tight; bump to 60s
// with 1024MB memory so we never trip stream-idle on cold starts.
module.exports.config = { maxDuration: 60, memory: 1024 };
