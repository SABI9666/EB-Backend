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
        const fromDate = from
            ? new Date(from)
            : new Date(now.getFullYear() - 2, 0, 1);
        const toDate = to ? new Date(to) : now;

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

        // ---------- bucket proposals into quotes / wins ----------
        for (const p of proposals) {
            const bdmUid = p.createdByUid;
            if (!bdmUid) continue;
            const bdmName = p.createdByName;
            const stats = ensure(bdmUid, bdmName);

            const client = (p.clientCompany || '').trim();
            const pricedAt = toJsDate(p.pricing && p.pricing.pricedAt);
            const lastEditedAt = toJsDate(p.pricing && p.pricing.lastEditedAt);
            const createdAt = toJsDate(p.createdAt);
            const wonDate = toJsDate(p.wonDate);

            // QUOTE = proposal that has pricing; quote date = pricedAt (or
            // lastEditedAt fallback, then createdAt as last resort).
            const hasPricing =
                p.pricing &&
                (p.pricing.quoteValue != null || p.pricing.projectNumber);
            const quoteDate = pricedAt || lastEditedAt || createdAt;

            if (hasPricing && quoteDate && quoteDate >= fromDate && quoteDate <= toDate) {
                const value = num(p.pricing.quoteValue);
                const currency = p.pricing.currency || '';
                const projectNumber = p.pricing.projectNumber || '';
                const key = periodKey(quoteDate, granularity);
                if (key) {
                    const period = ensurePeriod(stats, key);
                    period.quotes.push({
                        proposalId: p.id,
                        date: quoteDate.toISOString(),
                        projectName: p.projectName || '',
                        clientCompany: client,
                        projectNumber,
                        currency,
                        value,
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

            // PROJECT WON = proposal with status 'won'; date = wonDate.
            if (p.status === 'won' && wonDate && wonDate >= fromDate && wonDate <= toDate) {
                const key = periodKey(wonDate, granularity);
                if (key) {
                    const period = ensurePeriod(stats, key);
                    const value = num(p.pricing && p.pricing.quoteValue);
                    const currency = (p.pricing && p.pricing.currency) || '';
                    period.wonProjects.push({
                        proposalId: p.id,
                        projectId: p.projectId || '',
                        date: wonDate.toISOString(),
                        projectName: p.projectName || '',
                        clientCompany: client,
                        currency,
                        value
                    });
                }
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

        for (const v of variations) {
            if (v.status !== 'approved') continue;
            const approvedAt = toJsDate(v.approvedAt) || toJsDate(v.updatedAt);
            if (!approvedAt || approvedAt < fromDate || approvedAt > toDate) continue;

            const owner = projectIdToBdm[v.parentProjectId];
            if (!owner) continue;

            const stats = ensure(owner.bdmUid, owner.bdmName);
            const key = periodKey(approvedAt, granularity);
            if (!key) continue;
            const period = ensurePeriod(stats, key);

            const value = pickAmount(v, [
                'value',
                'approvedValue',
                'amount',
                'quoteValue',
                'totalValue',
                'variationValue'
            ]);

            period.variations.push({
                variationId: v.id,
                date: approvedAt.toISOString(),
                variationCode: v.variationCode || '',
                projectName: v.parentProjectName || '',
                clientCompany: v.clientCompany || '',
                estimatedHours: num(v.estimatedHours),
                currency: v.currency || '',
                value
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

        return res.status(200).json({
            success: true,
            data: {
                granularity,
                from: fromDate.toISOString(),
                to: toDate.toISOString(),
                periodKeys: Array.from(allPeriodKeys).sort(),
                bdms: result,
                totals: grandTotals
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
