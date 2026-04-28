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
// All monetary values in the response are converted to INR so the report is a
// single-currency view. Per-record `originalCurrency` and `originalValue` are
// preserved for reference. Rates are intentionally hardcoded so the endpoint
// has no external dependency; tweak here when desks need a refresh.
const CURRENCY_TO_INR = {
    INR: 1,
    USD: 83.5,
    AUD: 55.0,
    NZD: 51.0,
    EUR: 90.0,
    GBP: 105.0,
    SGD: 62.0,
    AED: 22.7,
    CAD: 61.0,
    JPY: 0.55
};

function toInr(value, currency) {
    const v = num(value);
    if (!v) return 0;
    const c = String(currency || '').trim().toUpperCase();
    if (!c) return v; // blank currency = assume already INR
    const rate = CURRENCY_TO_INR[c];
    return rate != null ? v * rate : v; // unknown currency = pass-through
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

        // Default lookback: 2 years back from today, up to today.
        const now = new Date();
        // When no explicit range is given, look back 5 years so the default
        // view shows historical activity rather than only the last two.
        const fromDate = from
            ? new Date(from)
            : new Date(now.getFullYear() - 5, 0, 1);
        const toDate = to ? new Date(to) : now;

        // Normalize boundaries: from = start-of-day UTC, to = end-of-day UTC.
        // Without this, `to=YYYY-MM-DD` parses to 00:00:00Z and silently
        // excludes every record written after midnight on the chosen end date.
        if (!isNaN(fromDate)) {
            fromDate.setUTCHours(0, 0, 0, 0);
        }
        if (!isNaN(toDate)) {
            toDate.setUTCHours(23, 59, 59, 999);
        }

        // ---------- load BDM users ----------
        const bdmsSnap = await db.collection('users').where('role', '==', 'bdm').get();
        const bdmMap = {};
        bdmsSnap.forEach((doc) => {
            const u = doc.data();
            bdmMap[doc.id] = {
                bdmUid: doc.id,
                bdmName: u.name || u.displayName || u.email || 'Unknown',
                bdmEmail: u.email || ''
            };
        });

        // ---------- load proposals ----------
        // We need every proposal for the lookback range. Filter in-memory because
        // the relevant date isn't always the same field (`pricedAt` vs `wonDate`).
        const proposalsSnap = await db.collection('proposals').get();
        const proposals = proposalsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

        // ---------- load projects ----------
        // Wins are taken from the projects collection (per Director portal),
        // not from proposals.status='won', because projects.{createdAt,bdmUid,
        // quoteValue} are reliably populated for every won deal whereas
        // proposals.wonDate is missing on older records.
        const projectsSnap = await db.collection('projects').get();
        const projects = projectsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

        // ---------- load variations ----------
        const variationsSnap = await db.collection('variations').get();
        const variations = variationsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

        // Index variations by parent project for cheap lookup.
        const variationsByProject = {};
        variations.forEach((v) => {
            const pid = v.parentProjectId;
            if (!pid) return;
            if (!variationsByProject[pid]) variationsByProject[pid] = [];
            variationsByProject[pid].push(v);
        });

        // ---------- debug=raw: dump samples for field-shape inspection -----
        // When the report is unexpectedly empty, hit /api/bdm-analytics?debug=raw
        // to see the actual field names of the first 3 docs of each collection.
        // This is the fastest way to diagnose schema drift without DB access.
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
                }
            });
        }

        // ---------- per-BDM accumulator ----------
        // shape: bdmStats[bdmUid] = {
        //   info, periods: { [key]: { quotes:[], wonProjects:[], variations:[], clients:Set } },
        //   firstClientSeen: { [client]: ms-timestamp }
        // }
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
                    key,
                    quotes: [],
                    wonProjects: [],
                    variations: [],
                    clients: new Set(),
                    newClients: new Set()
                };
            }
            return stats.periods[key];
        }

        // Seed every known BDM up-front so the report lists them all even when
        // they had zero activity in the selected window. Without this, the
        // table can render completely blank when the date range is narrow.
        Object.values(bdmMap).forEach((b) => ensure(b.bdmUid, b.bdmName));

        // ---------- counters for response meta (diagnostics) ----------
        let proposalsScanned = 0;
        let quotesInRange = 0;
        let winsInRange = 0;
        let variationsInRange = 0;

        // ---------- lifetime accumulator (ignores from/to filter) ----------
        // Always populated regardless of the requested window so the report
        // can surface real numbers even when the user's date filter is narrow
        // or there is simply no recent activity.
        const lifetimeTotals = {
            numQuotes: 0,
            quoteValueTotal: 0,
            numProjectsWon: 0,
            projectValue: 0,
            variationValue: 0,
            totalValue: 0,
            numNewClients: 0
        };
        const lifetimePerBdm = {}; // bdmUid -> totals (same shape)
        function bumpLifetime(bdmUid, bdmName, kind, valueInr) {
            if (!lifetimePerBdm[bdmUid]) {
                lifetimePerBdm[bdmUid] = {
                    bdmUid,
                    bdmName: bdmName || (bdmMap[bdmUid] && bdmMap[bdmUid].bdmName) || 'Unknown',
                    numQuotes: 0,
                    quoteValueTotal: 0,
                    numProjectsWon: 0,
                    projectValue: 0,
                    variationValue: 0,
                    totalValue: 0,
                    numNewClients: 0,
                    clients: new Set()
                };
            }
            const b = lifetimePerBdm[bdmUid];
            if (kind === 'quote') { b.numQuotes += 1; b.quoteValueTotal += valueInr; lifetimeTotals.numQuotes += 1; lifetimeTotals.quoteValueTotal += valueInr; }
            else if (kind === 'win') { b.numProjectsWon += 1; b.projectValue += valueInr; b.totalValue += valueInr; lifetimeTotals.numProjectsWon += 1; lifetimeTotals.projectValue += valueInr; lifetimeTotals.totalValue += valueInr; }
            else if (kind === 'variation') { b.variationValue += valueInr; b.totalValue += valueInr; lifetimeTotals.variationValue += valueInr; lifetimeTotals.totalValue += valueInr; }
        }
        // Pre-seed all BDMs in the lifetime map so they always appear, even at zero.
        Object.values(bdmMap).forEach((b) => bumpLifetime(b.bdmUid, b.bdmName, '_seed', 0));

        // ---------- bucket proposals into quotes / wins ----------
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
            const wonDate = toJsDate(p.wonDate);

            // QUOTE = any proposal that's been priced, submitted, or otherwise
            // moved past draft. We accept multiple signals because field names
            // have drifted across releases. Date falls back through the most
            // recent signal we can find.
            const QUOTE_STATUSES = new Set(['priced', 'sent', 'submitted', 'won', 'lost']);
            const hasPricing =
                (p.pricing &&
                    (p.pricing.quoteValue != null ||
                        p.pricing.projectNumber ||
                        p.pricing.pricedAt ||
                        p.pricing.lastEditedAt)) ||
                QUOTE_STATUSES.has(p.status);
            const quoteDate = pricedAt || lastEditedAt || submittedAt || updatedAt || createdAt;

            // Lifetime tally: count every priced proposal regardless of window.
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

                    // Track first-ever client appearance for this BDM (used for "new clients").
                    const ms = quoteDate.getTime();
                    if (
                        client &&
                        (stats.firstClientSeen[client] == null ||
                            ms < stats.firstClientSeen[client])
                    ) {
                        stats.firstClientSeen[client] = ms;
                    }
                }
            }

        }

        // ---------- bucket wins from PROJECTS collection ----------
        // The Director portal records each won deal as a project document with
        // bdmUid / quoteValue / createdAt set at creation time. Reading wins
        // here (instead of from proposals.status='won') is more reliable
        // because proposals.wonDate is not always populated on older records.
        for (const proj of projects) {
            const bdmUid = proj.bdmUid || (proj.proposal && proj.proposal.createdByUid);
            if (!bdmUid) continue;

            const wonDate =
                toJsDate(proj.wonDate) ||
                toJsDate(proj.createdAt) ||
                toJsDate(proj.updatedAt);

            const rawValue =
                num(proj.quoteValue) ||
                num(proj.projectValue) ||
                num(proj.value) ||
                num(proj.pricing && proj.pricing.quoteValue);
            const currency =
                proj.currency ||
                (proj.pricing && proj.pricing.currency) ||
                '';

            // Lifetime tally: every project doc is a win, regardless of window.
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

            // A win from a never-before-seen client is also a "new client"
            // signal, even when the proposal didn't reach this BDM's quote
            // bucket in the same window.
            if (projClient && stats.firstClientSeen[projClient] == null) {
                stats.firstClientSeen[projClient] = wonDate.getTime();
            }
        }

        // After scanning every quote, compute "new clients" per period (this
        // BDM's first quote for that client).
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
        // We need to know which BDM owns each variation's parent project. The
        // parent project's BDM = the proposal that created the project. Build
        // a project -> BDM lookup via proposals.
        const projectIdToBdm = {};
        for (const p of proposals) {
            if (p.projectId && p.createdByUid) {
                projectIdToBdm[p.projectId] = {
                    bdmUid: p.createdByUid,
                    bdmName: p.createdByName || ''
                };
            }
        }

        // Fallback: when no proposal points at a project (older data), read
        // bdmUid directly from the project doc itself.
        async function resolveOwner(parentProjectId) {
            if (!parentProjectId) return null;
            if (projectIdToBdm[parentProjectId]) return projectIdToBdm[parentProjectId];
            try {
                const projDoc = await db.collection('projects').doc(parentProjectId).get();
                if (projDoc.exists) {
                    const proj = projDoc.data() || {};
                    if (proj.bdmUid) {
                        projectIdToBdm[parentProjectId] = {
                            bdmUid: proj.bdmUid,
                            bdmName: proj.bdmName || ''
                        };
                        return projectIdToBdm[parentProjectId];
                    }
                }
            } catch (_) { /* swallow lookup errors */ }
            return null;
        }

        for (const v of variations) {
            if (v.status !== 'approved') continue;
            const approvedAt = toJsDate(v.approvedAt) || toJsDate(v.updatedAt);

            const rawValue = pickAmount(v, [
                'value',
                'approvedValue',
                'amount',
                'quoteValue',
                'totalValue',
                'variationValue'
            ]);
            const currency = v.currency || '';

            // Lifetime tally happens regardless of date window.
            const owner = await resolveOwner(v.parentProjectId);
            if (owner) {
                bumpLifetime(owner.bdmUid, owner.bdmName, 'variation', toInr(rawValue, currency));
            }

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
        // Per-BDM rows for every period observed; plus an "overall" total row
        // for that BDM across the whole [from, to] range.
        const allPeriodKeys = new Set();
        const result = Object.values(bdmStats).map((stats) => {
            const periodRows = Object.values(stats.periods)
                .sort((a, b) => a.key.localeCompare(b.key))
                .map((period) => {
                    allPeriodKeys.add(period.key);
                    const projectValue = period.wonProjects.reduce(
                        (s, w) => s + num(w.value),
                        0
                    );
                    const variationValue = period.variations.reduce(
                        (s, v) => s + num(v.value),
                        0
                    );
                    const quoteValueTotal = period.quotes.reduce(
                        (s, q) => s + num(q.value),
                        0
                    );
                    return {
                        period: period.key,
                        numQuotes: period.quotes.length,
                        quoteValueTotal,
                        numProjectsWon: period.wonProjects.length,
                        projectValue,
                        variationValue,
                        totalValue: projectValue + variationValue,
                        numNewClients: period.newClients.size,
                        quotes: period.quotes,
                        wonProjects: period.wonProjects,
                        variations: period.variations
                    };
                });

            // Roll up the BDM's overall numbers across all periods.
            const overall = periodRows.reduce(
                (acc, r) => {
                    acc.numQuotes += r.numQuotes;
                    acc.quoteValueTotal += r.quoteValueTotal;
                    acc.numProjectsWon += r.numProjectsWon;
                    acc.projectValue += r.projectValue;
                    acc.variationValue += r.variationValue;
                    acc.totalValue += r.totalValue;
                    acc.numNewClients += r.numNewClients;
                    return acc;
                },
                {
                    numQuotes: 0,
                    quoteValueTotal: 0,
                    numProjectsWon: 0,
                    projectValue: 0,
                    variationValue: 0,
                    totalValue: 0,
                    numNewClients: 0
                }
            );

            return {
                bdmUid: stats.bdmUid,
                bdmName: stats.bdmName,
                bdmEmail: stats.bdmEmail,
                overall,
                periods: periodRows
            };
        });

        // Sort BDMs by total project value desc.
        result.sort((a, b) => b.overall.projectValue - a.overall.projectValue);

        // ---------- grand totals ----------
        const grandTotals = result.reduce(
            (acc, b) => {
                acc.numQuotes += b.overall.numQuotes;
                acc.quoteValueTotal += b.overall.quoteValueTotal;
                acc.numProjectsWon += b.overall.numProjectsWon;
                acc.projectValue += b.overall.projectValue;
                acc.variationValue += b.overall.variationValue;
                acc.totalValue += b.overall.totalValue;
                acc.numNewClients += b.overall.numNewClients;
                return acc;
            },
            {
                numQuotes: 0,
                quoteValueTotal: 0,
                numProjectsWon: 0,
                projectValue: 0,
                variationValue: 0,
                totalValue: 0,
                numNewClients: 0
            }
        );

        // ---------- shape lifetime payload ----------
        // Sorted by total value desc so the most-active BDMs surface first.
        // Strip internal-only Set objects before serialization.
        const lifetimeBdms = Object.values(lifetimePerBdm)
            .map((b) => ({
                bdmUid: b.bdmUid,
                bdmName: b.bdmName,
                numQuotes: b.numQuotes,
                quoteValueTotal: b.quoteValueTotal,
                numProjectsWon: b.numProjectsWon,
                projectValue: b.projectValue,
                variationValue: b.variationValue,
                totalValue: b.totalValue,
                numNewClients: b.numNewClients
            }))
            .sort((a, b) => b.totalValue - a.totalValue);

        return res.status(200).json({
            success: true,
            data: {
                granularity,
                from: fromDate.toISOString(),
                to: toDate.toISOString(),
                periodKeys: Array.from(allPeriodKeys).sort(),
                bdms: result,
                totals: grandTotals,
                lifetime: {
                    totals: lifetimeTotals,
                    bdms: lifetimeBdms,
                    currency: 'INR'
                },
                meta: {
                    proposalsScanned,
                    projectsScanned: projects.length,
                    variationsScanned: variations.length,
                    quotesInRange,
                    winsInRange,
                    variationsInRange,
                    bdmCount: result.length,
                    currencyMode: 'INR',
                    winsSource: 'projects collection',
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
