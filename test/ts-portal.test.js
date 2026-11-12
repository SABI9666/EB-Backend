// Timesheet Portal: rules, company isolation, approval workflow, reports, scheduler.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createFakeFirestore, createFakeAuth } = require('./helpers/fake-firestore');

const store = require('../ts-portal/lib/store');
const mailer = require('../ts-portal/lib/mailer');
const R = require('../ts-portal/lib/rules');
const { parseCsv, toIsoDate } = require('../ts-portal/lib/upload');
const { nextStep } = require('../ts-portal/lib/workflow');

const db = createFakeFirestore();
const fakeAuth = createFakeAuth();
store._setForTests({ db, auth: fakeAuth });
const sent = [];
process.env.RESEND_API_KEY = 'test';
process.env.TS_TICK_SECRET = 'tick-secret';
mailer._setClientForTests({ emails: { send: async m => { sent.push(m); return {}; } } });

const app = express();
app.use(express.json());
app.use('/api/ts-portal', require('../ts-portal'));
let base;
const server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}/api/ts-portal`; });
test.after(() => server.close());

async function call(uid, method, path, body, headers = {}) {
    const r = await fetch(base + path, {
        method, headers: { 'Content-Type': 'application/json', ...(uid ? { Authorization: 'Bearer tok-' + uid } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined
    });
    const type = r.headers.get('content-type') || '';
    return { status: r.status, body: type.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
}

// ---------- pure rules ----------
test('weeks start on Monday', () => {
    assert.equal(R.weekStartOf('2026-11-12'), '2026-11-09'); // Thursday
    assert.equal(R.weekStartOf('2026-11-15'), '2026-11-09'); // Sunday
    assert.equal(R.weekStartOf('2026-11-09'), '2026-11-09');
    assert.equal(R.isWeekStart('2026-11-10'), false);
    assert.equal(R.isDate('2026-02-30'), false);
});

test('entry validation: dates in week, step, daily limit, note, project access', () => {
    const projects = new Map([['p1', { id: 'p1', code: 'P1', memberUids: [] }], ['p2', { id: 'p2', code: 'P2', memberUids: ['other'] }], ['p3', { id: 'p3', code: 'P3', active: false }]]);
    const ctx = { weekStart: '2026-11-09', settings: {}, projects, uid: 'me' };
    const { errors } = R.validateEntries([
        { projectId: 'p1', date: '2026-11-16', hours: 2 },   // outside week
        { projectId: 'p1', date: '2026-11-09', hours: 1.3 }, // bad step
        { projectId: 'p2', date: '2026-11-09', hours: 1 },   // not assigned
        { projectId: 'p3', date: '2026-11-09', hours: 1 },   // closed
        { projectId: 'p1', date: '2026-11-10', hours: 11 }   // > noteOverHours without note
    ], ctx);
    assert.deepEqual(errors.map(e => e.row), [0, 1, 2, 3, null]);
    const ok = R.validateEntries([{ projectId: 'p1', date: '2026-11-10', hours: 11, note: 'site visit' }, { projectId: 'p1', date: '2026-11-11', hours: 0 }], ctx);
    assert.deepEqual(ok.errors, []);
    assert.equal(ok.entries.length, 1);
});

test('overtime by week and by day', () => {
    const e = ['09', '10', '11', '12', '13'].map(d => ({ projectId: 'p', date: `2026-11-${d}`, hours: 9 }));
    assert.equal(R.computeTotals(e, { overtimeMode: 'week' }).overtimeHours, 5);
    assert.equal(R.computeTotals(e, { overtimeMode: 'day', stdDayHours: 8 }).overtimeHours, 5);
    assert.equal(R.computeTotals(e.slice(0, 4), { overtimeMode: 'week' }).overtimeHours, 0);
});

test('workflow skips steps with nobody and never lets people approve themselves', () => {
    const members = [{ uid: 'e', role: 'employee', supervisorUid: null }, { uid: 'a', role: 'company_admin' }, { uid: 'g', role: 'gm' }];
    const ctx = { submitterUid: 'e', members, projects: new Map(), projectIds: [] };
    assert.deepEqual(nextStep(['supervisor', 'gm'], 0, ctx), { stepIndex: 0, stepType: 'supervisor', approvers: ['a'] }); // fallback to admin
    const gmCtx = { submitterUid: 'g', members: [{ uid: 'g', role: 'gm' }], projects: new Map(), projectIds: [] };
    assert.equal(nextStep(['gm'], 0, gmCtx), null); // only candidate is the submitter -> skipped
});

test('csv and date parsing', () => {
    assert.deepEqual(parseCsv('Date,Project code,Hours,Note\n2026-11-09,P1,8,"a, b"\r\n'), [['Date', 'Project code', 'Hours', 'Note'], ['2026-11-09', 'P1', '8', 'a, b']]);
    assert.equal(toIsoDate('09/11/2026'), '2026-11-09');
    assert.equal(toIsoDate(new Date(Date.UTC(2026, 10, 9))), '2026-11-09');
    assert.equal(toIsoDate(46335), '2026-11-09');
});

// ---------- HTTP flows ----------
const SUPER = fakeAuth.addUser('owner@platform.test', 'super');
const STRANGER = fakeAuth.addUser('stranger@x.test', 'stranger');
const WS = '2026-11-09';
const ids = {};

test('only the Super Admin can create companies', async () => {
    await db.collection('tsPlatform').doc('config').set({ superAdminUids: [SUPER] });
    let r = await call(STRANGER, 'POST', '/platform/companies', { name: 'X', code: 'xx', adminName: 'a', adminEmail: 'a@x.test' });
    assert.equal(r.status, 403);
    r = await call(null, 'GET', '/me');
    assert.equal(r.status, 401);
    r = await call(STRANGER, 'GET', '/me');
    assert.equal(r.body.membership, null);
    assert.equal(r.body.user.superAdmin, false);
    r = await call(STRANGER, 'GET', '/ts/week');
    assert.equal(r.status, 403);
});

test('Super Admin creates two companies, each with its own admin', async () => {
    let r = await call(SUPER, 'POST', '/platform/companies', { name: 'Acme Ltd', code: 'acme', timezone: 'Asia/Kolkata', adminName: 'Asha Admin', adminEmail: 'asha@acme.test' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    ids.acmeAdmin = r.body.admin.uid;
    assert.ok(r.body.admin.setPasswordLink, 'new login gets a set-password link');
    r = await call(SUPER, 'POST', '/platform/companies', { name: 'Beta Corp', code: 'beta', adminName: 'Ben Admin', adminEmail: 'ben@beta.test' });
    assert.equal(r.status, 201);
    ids.betaAdmin = r.body.admin.uid;
    r = await call(SUPER, 'POST', '/platform/companies', { name: 'Dup', code: 'acme', adminName: 'x', adminEmail: 'x@x.test' });
    assert.equal(r.status, 409);
    r = await call(SUPER, 'GET', '/platform/companies');
    assert.deepEqual(r.body.companies.map(c => c.id), ['acme', 'beta']);
    r = await call(ids.acmeAdmin, 'GET', '/me');
    assert.equal(r.body.membership.companyName, 'Acme Ltd');
    assert.equal(r.body.membership.role, 'company_admin');
    r = await call(ids.acmeAdmin, 'GET', '/platform/companies');
    assert.equal(r.status, 403, 'company admins are not Super Admins');
});

test('company admin sets up people and projects (company id in the body is ignored)', async () => {
    const add = async (name, email, role, extra = {}) => {
        const r = await call(ids.acmeAdmin, 'POST', '/company/members', { name, email, role, companyId: 'beta', ...extra });
        assert.equal(r.status, 201, JSON.stringify(r.body));
        return r.body.uid;
    };
    ids.sup = await add('Sam Supervisor', 'sam@acme.test', 'supervisor');
    ids.gm = await add('Gina GM', 'gina@acme.test', 'gm');
    ids.pm = await add('Paul PM', 'paul@acme.test', 'project_manager');
    ids.emp = await add('Eve Employee', 'eve@acme.test', 'employee', { supervisorUid: ids.sup });
    const link = await db.collection('tsUsers').doc(ids.emp).get();
    assert.equal(link.data().companyId, 'acme');
    let r = await call(ids.betaAdmin, 'POST', '/company/members', { name: 'Eve', email: 'eve@acme.test' });
    assert.equal(r.status, 409, 'one login belongs to one company');
    r = await call(ids.emp, 'POST', '/company/members', { name: 'X', email: 'x2@acme.test' });
    assert.equal(r.status, 403, 'employees cannot add people');

    r = await call(ids.acmeAdmin, 'POST', '/company/projects', { code: 'ac-100', name: 'Tower', pmUid: ids.pm });
    assert.equal(r.status, 201);
    ids.p1 = r.body.id;
    r = await call(ids.acmeAdmin, 'POST', '/company/projects', { code: 'AC-100', name: 'Dup' });
    assert.equal(r.status, 400);
    r = await call(ids.betaAdmin, 'PATCH', `/company/projects/${ids.p1}`, { name: 'hacked' });
    assert.equal(r.status, 404, 'Beta cannot touch Acme projects');
    r = await call(ids.acmeAdmin, 'PUT', '/company/settings', { approvalSteps: ['supervisor', 'gm'] });
    assert.equal(r.status, 200);
});

test('employee enters a week, submits, supervisor then GM approve', async () => {
    const entries = ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13'].map(d => ({ projectId: ids.p1, date: d, hours: 9 }));
    let r = await call(ids.emp, 'PUT', `/ts/week/${WS}`, { entries });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.totals.overtimeHours, 5);
    r = await call(ids.emp, 'GET', `/ts/week/${WS}/route`);
    assert.deepEqual(r.body.route, [{ step: 'supervisor', approvers: ['Sam Supervisor'] }, { step: 'gm', approvers: ['Gina GM'] }]);
    sent.length = 0;
    r = await call(ids.emp, 'POST', `/ts/week/${WS}/submit`);
    assert.equal(r.body.status, 'submitted');
    assert.deepEqual(sent.map(m => m.to[0]), ['sam@acme.test']);
    ids.sheet = `${ids.emp}_${WS}`;

    r = await call(ids.emp, 'PUT', `/ts/week/${WS}`, { entries });
    assert.equal(r.status, 409, 'submitted weeks are locked');

    // Beta's admin cannot see or decide Acme's sheet even with the exact id.
    r = await call(ids.betaAdmin, 'GET', `/ts/sheets/${ids.sheet}`);
    assert.equal(r.status, 404);
    r = await call(ids.betaAdmin, 'POST', `/ts/sheets/${ids.sheet}/decide`, { decision: 'approve' });
    assert.equal(r.status, 404);
    r = await call(ids.gm, 'POST', `/ts/sheets/${ids.sheet}/decide`, { decision: 'approve' });
    assert.equal(r.status, 403, 'GM must wait for the supervisor step');
    r = await call(ids.emp, 'POST', `/ts/sheets/${ids.sheet}/decide`, { decision: 'approve' });
    assert.equal(r.status, 403, 'nobody approves their own sheet');

    r = await call(ids.sup, 'GET', '/ts/approvals');
    assert.deepEqual(r.body.approvals.map(a => a.id), [ids.sheet]);
    const [a, b] = await Promise.all([
        call(ids.sup, 'POST', `/ts/sheets/${ids.sheet}/decide`, { decision: 'approve' }),
        call(ids.sup, 'POST', `/ts/sheets/${ids.sheet}/decide`, { decision: 'approve' })
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 403], 'a double click only counts once');
    r = await call(ids.gm, 'GET', '/ts/approvals');
    assert.equal(r.body.approvals.length, 1);
    r = await call(ids.gm, 'POST', `/ts/sheets/${ids.sheet}/decide`, { decision: 'return' });
    assert.equal(r.status, 400, 'returning needs a comment');
    r = await call(ids.gm, 'POST', `/ts/sheets/${ids.sheet}/decide`, { decision: 'approve' });
    assert.equal(r.body.status, 'approved');
    r = await call(ids.emp, 'GET', '/ts/history');
    assert.equal(r.body.sheets[0].status, 'approved');
});

test('return, fix and resubmit', async () => {
    const ws = '2026-11-16';
    let r = await call(ids.emp, 'PUT', `/ts/week/${ws}`, { entries: [{ projectId: ids.p1, date: ws, hours: 8 }] });
    r = await call(ids.emp, 'POST', `/ts/week/${ws}/submit`);
    r = await call(ids.sup, 'POST', `/ts/sheets/${ids.emp}_${ws}/decide`, { decision: 'return', comment: 'Add Tuesday' });
    assert.equal(r.body.status, 'returned');
    r = await call(ids.emp, 'GET', `/ts/week?start=${ws}`);
    assert.equal(r.body.sheet.returnComment, 'Add Tuesday');
    r = await call(ids.emp, 'PUT', `/ts/week/${ws}`, { entries: [{ projectId: ids.p1, date: ws, hours: 8 }, { projectId: ids.p1, date: '2026-11-17', hours: 8 }] });
    assert.equal(r.status, 200);
    r = await call(ids.emp, 'POST', `/ts/week/${ws}/submit`);
    assert.equal(r.body.status, 'submitted');
});

test('reports: GM sees the company, supervisor sees their team, employees see none, other companies see nothing', async () => {
    let r = await call(ids.gm, 'GET', '/ts/reports/summary?month=2026-11');
    assert.equal(r.status, 200);
    assert.equal(r.body.totalHours, 45);
    assert.equal(r.body.overtimeHours, 5);
    assert.equal(r.body.byProject[0].code, 'AC-100');
    assert.equal(r.body.sheets.submitted, 1);
    r = await call(ids.sup, 'GET', '/ts/reports/summary?month=2026-11');
    assert.equal(r.body.totalHours, 45);
    assert.equal(r.body.scope, 'Your team');
    r = await call(ids.pm, 'GET', '/ts/reports/summary?month=2026-11');
    assert.equal(r.body.totalHours, 45, 'PM sees hours on their project');
    r = await call(ids.emp, 'GET', '/ts/reports/summary?month=2026-11');
    assert.equal(r.status, 403);
    r = await call(ids.betaAdmin, 'GET', '/ts/reports/summary?month=2026-11');
    assert.equal(r.body.totalHours, 0);
    r = await call(ids.gm, 'GET', '/ts/reports/export?month=2026-11');
    assert.equal(r.status, 200);
    assert.equal(r.body.slice(0, 2).toString(), 'PK', 'an .xlsx file');
    r = await call(ids.gm, 'GET', `/ts/team?week=${WS}`);
    assert.equal(r.body.team.find(t => t.uid === ids.emp).status, 'approved');
    r = await call(SUPER, 'GET', '/platform/summary?month=2026-11');
    assert.deepEqual(r.body.companies.map(c => [c.id, c.totalHours]), [['acme', 45], ['beta', 0]]);
});

test('admin can reopen an approved week', async () => {
    let r = await call(ids.acmeAdmin, 'POST', `/company/sheets/${ids.sheet}/reopen`, {});
    assert.equal(r.status, 400);
    r = await call(ids.acmeAdmin, 'POST', `/company/sheets/${ids.sheet}/reopen`, { reason: 'Wrong project' });
    assert.equal(r.status, 200);
    r = await call(ids.emp, 'GET', `/ts/week?start=${WS}`);
    assert.equal(r.body.sheet.status, 'returned');
});

test('disabled members and suspended companies are locked out', async () => {
    let r = await call(ids.acmeAdmin, 'PATCH', `/company/members/${ids.pm}`, { status: 'disabled' });
    assert.equal(r.status, 200);
    r = await call(ids.pm, 'GET', '/ts/week');
    assert.equal(r.status, 403);
    r = await call(ids.acmeAdmin, 'PATCH', `/company/members/${ids.acmeAdmin}`, { status: 'disabled' });
    assert.equal(r.status, 400, 'admins cannot lock themselves out');
    r = await call(SUPER, 'PATCH', '/platform/companies/beta', { status: 'suspended' });
    assert.equal(r.status, 200);
    r = await call(ids.betaAdmin, 'GET', '/ts/week');
    assert.equal(r.status, 403);
    r = await call(ids.emp, 'GET', '/ts/week');
    assert.equal(r.status, 200, 'other companies keep working');
});

test('scheduler tick needs the secret and sends each reminder once', async () => {
    let r = await call(null, 'POST', '/internal/tick', null, { 'x-tick-secret': 'wrong' });
    assert.equal(r.status, 403);
    const { runForCompany } = require('../ts-portal/routes/internal')._test;
    const c = { id: 'acme', ...(await db.collection('tsCompanies').doc('acme').get()).data() };
    const friday = new Date('2026-11-20T12:00:00Z'); // 17:30 in Kolkata
    sent.length = 0;
    const first = await runForCompany(c, friday);
    assert.equal(first[0].job, 'reminder');
    assert.ok(sent.length > 0);
    const again = await runForCompany(c, friday);
    assert.deepEqual(again, []);
    const firstOfMonth = new Date('2026-12-01T06:00:00Z');
    sent.length = 0;
    const monthly = await runForCompany(c, firstOfMonth);
    assert.equal(monthly[0].month, '2026-11');
    assert.deepEqual(sent.map(m => m.to[0]).sort(), ['asha@acme.test', 'gina@acme.test']);
});

test('upload: CSV and Excel files are read into entries; bad rows are reported with row numbers', async () => {
    const post = async (name, content) => {
        const fd = new FormData();
        fd.append('file', new Blob([content]), name);
        const r = await fetch(`${base}/ts/week/2026-11-23/upload`, { method: 'POST', headers: { Authorization: 'Bearer tok-' + ids.emp }, body: fd });
        return { status: r.status, body: await r.json() };
    };
    let r = await post('week.csv', 'Date,Project code,Hours,Note\n2026-11-23,ac-100,8,\n24/11/2026,AC-100,7.5,"site, visit"\n');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.errors, []);
    assert.deepEqual(r.body.entries.map(e => [e.date, e.hours, e.note]), [['2026-11-23', 8, ''], ['2026-11-24', 7.5, 'site, visit']]);
    r = await post('week.csv', 'Date,Project code,Hours,Note\n2026-11-23,NOPE,8,\n2026-12-01,AC-100,8,\n');
    assert.deepEqual(r.body.errors.map(e => e.row), [2, 3]);
    assert.deepEqual(r.body.entries, [], 'nothing is loaded while the file has errors');
    r = await post('week.pdf', 'x');
    assert.equal(r.status, 400);
    r = await post('week.xlsx', 'not a zip');
    assert.equal(r.status, 400);

    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Week');
    ws.addRow(['Date', 'Project code', 'Hours', 'Note']);
    ws.addRow([new Date(Date.UTC(2026, 10, 25)), 'AC-100', 6, 'from excel']);
    r = await post('week.xlsx', Buffer.from(await wb.xlsx.writeBuffer()));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.entries.map(e => [e.date, e.hours, e.note]), [['2026-11-25', 6, 'from excel']]);
});
