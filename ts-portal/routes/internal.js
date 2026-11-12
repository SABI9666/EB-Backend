// Scheduled jobs, called by Google Cloud Scheduler (e.g. every hour):
//   POST /api/ts-portal/internal/tick   header  x-tick-secret: <TS_TICK_SECRET>
// - Weekly reminder to people who have not submitted this week
// - Monthly report email to each company's GM and company admins (1st of the month)
// Each company records what it already sent, so a repeated tick never emails twice.
const express = require('express');
const crypto = require('crypto');
const { asyncH } = require('../lib/access');
const { companiesCol, companyRef, col, db, docs } = require('../lib/store');
const R = require('../lib/rules');
const reports = require('../lib/reports');
const mailer = require('../lib/mailer');

const router = express.Router();

function secretOk(given) {
    const want = process.env.TS_TICK_SECRET || '';
    if (!want || typeof given !== 'string') return false;
    const a = Buffer.from(given), b = Buffer.from(want);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Local date parts in the company's time zone.
function localNow(tz, at = new Date()) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit',
        day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(at).map(p => [p.type, p.value]));
    const date = `${parts.year}-${parts.month}-${parts.day}`;
    return { date, hour: Number(parts.hour), dow: new Date(date + 'T00:00:00Z').getUTCDay() };
}

// Mark a job as done for a period in a transaction; returns false if already done.
async function claim(cid, field, value) {
    const ref = companyRef(cid);
    return db().runTransaction(async tx => {
        const snap = await tx.get(ref);
        if (!snap.exists || (snap.data().jobs || {})[field] === value) return false;
        tx.update(ref, { jobs: { ...(snap.data().jobs || {}), [field]: value } });
        return true;
    });
}

async function runForCompany(c, at) {
    const done = [];
    const s = R.validateSettings({}, c.settings || {});
    const local = localNow(c.timezone, at);
    const members = docs(await col(c.id, 'members').get()).map(m => ({ uid: m.id, ...m })).filter(m => m.status !== 'disabled');

    if (local.dow === s.reminderDow && local.hour >= s.reminderHour) {
        const ws = R.weekStartOf(local.date);
        if (await claim(c.id, 'reminderWeek', ws)) {
            const sheets = docs(await col(c.id, 'sheets').where('weekStart', '==', ws).get());
            const sent = new Set(sheets.filter(x => x.status === 'submitted' || x.status === 'approved').map(x => x.uid));
            const missing = members.filter(m => !sent.has(m.uid));
            for (const m of missing) {
                await mailer.send(m.email, `Reminder: submit your timesheet for the week of ${ws}`, mailer.layout('Timesheet reminder',
                    `<p>Hi ${mailer.esc(m.name)}, your ${mailer.esc(c.name)} timesheet for the week of ${ws} has not been submitted yet.</p>`,
                    { href: `${mailer.PORTAL_URL()}#/week/${ws}`, label: 'Open my week' }));
            }
            done.push({ job: 'reminder', week: ws, sent: missing.length });
        }
    }

    if (s.monthlyReportEmail && local.date.endsWith('-01') && local.hour >= 8) {
        const month = R.prevMonth(local.date.slice(0, 7));
        if (await claim(c.id, 'monthlyReport', month)) {
            const projects = new Map(docs(await col(c.id, 'projects').get()).map(p => [p.id, p]));
            const sheets = await reports.loadMonthSheets(c.id, month);
            const r = reports.aggregate({ month, sheets, members, projects, scope: { all: true }, settings: s });
            const top = r.byProject.slice(0, 10).map(p => `<tr><td>${mailer.esc(p.code)}</td><td>${mailer.esc(p.name)}</td><td style="text-align:right">${p.hours}</td></tr>`).join('');
            const to = members.filter(m => m.role === 'gm' || m.role === 'company_admin').map(m => m.email);
            await mailer.send(to, `${c.name}: timesheet report for ${month}`, mailer.layout(`Timesheet report · ${month}`,
                `<p><b>${r.totalHours} h</b> approved, <b>${r.overtimeHours} h</b> overtime, ${r.sheets.submitted || 0} sheets still waiting for approval.</p>
                 <table style="border-collapse:collapse;width:100%" cellpadding="6"><tr style="background:#dce6f1"><th align="left">Code</th><th align="left">Project</th><th align="right">Hours</th></tr>${top}</table>`,
                { href: `${mailer.PORTAL_URL()}#/reports/${month}`, label: 'Open the full report' }));
            done.push({ job: 'monthly', month, to: to.length });
        }
    }
    return done;
}

router.post('/tick', asyncH(async (req, res) => {
    if (!secretOk(req.get('x-tick-secret'))) return res.sendStatus(403);
    const at = new Date();
    const companies = docs(await companiesCol().get()).filter(c => c.status === 'active');
    const results = {};
    for (const c of companies) {
        try { results[c.id] = await runForCompany(c, at); }
        catch (e) { console.error('[ts-portal] tick failed for', c.id, e && e.message); results[c.id] = { error: e.message }; }
    }
    res.json({ ok: true, results });
}));

module.exports = router;
module.exports._test = { localNow, runForCompany };
