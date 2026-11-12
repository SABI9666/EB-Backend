// Monthly reports built from approved timesheets.
const { col, docs } = require('./store');
const { monthRange, addDays, round2, DEFAULT_SETTINGS } = require('./rules');

// Which sheets/entries a manager may see in reports.
//   gm, company_admin   everything in the company
//   project_manager     hours booked on projects they manage
//   supervisor          their direct reports' hours
function scopeFor(role, uid, members, projects) {
    if (role === 'gm' || role === 'company_admin' || role === 'super_admin') return { all: true };
    if (role === 'project_manager') {
        return { projectIds: new Set([...projects.values()].filter(p => p.pmUid === uid).map(p => p.id)) };
    }
    if (role === 'supervisor') {
        return { memberUids: new Set(members.filter(m => m.supervisorUid === uid).map(m => m.uid)) };
    }
    return { none: true };
}

function entryVisible(scope, sheet, entry) {
    if (scope.none) return false;
    if (scope.all) return true;
    if (scope.projectIds) return scope.projectIds.has(entry.projectId);
    if (scope.memberUids) return scope.memberUids.has(sheet.uid);
    return false;
}

// Sheets whose week touches the month (a week may start in the previous month).
async function loadMonthSheets(cid, month) {
    const { first, last } = monthRange(month);
    const snap = await col(cid, 'sheets')
        .where('weekStart', '>=', addDays(first, -6))
        .where('weekStart', '<=', last)
        .get();
    return docs(snap);
}

function aggregate({ month, sheets, members, projects, scope, settings }) {
    const s = { ...DEFAULT_SETTINGS, ...settings };
    const { first, last } = monthRange(month);
    const inMonth = d => d >= first && d <= last;
    const memberByUid = new Map(members.map(m => [m.uid, m]));
    const byProject = new Map();
    const byMember = new Map();
    const rows = [];
    let total = 0;
    let overtime = 0;
    const status = { approved: 0, submitted: 0, returned: 0, draft: 0 };

    for (const sh of sheets) {
        const visible = (sh.entries || []).filter(e => inMonth(e.date) && entryVisible(scope, sh, e));
        if (!visible.length) continue;
        status[sh.status] = (status[sh.status] || 0) + 1;
        if (sh.status !== 'approved') continue;

        const sheetHours = (sh.entries || []).reduce((a, e) => a + e.hours, 0);
        const visibleHours = visible.reduce((a, e) => a + e.hours, 0);
        // Week overtime is shared out by the share of the week's hours that fall in view.
        let ot = 0;
        if (s.overtimeMode === 'day') {
            const byDay = {};
            (sh.entries || []).forEach(e => { byDay[e.date] = (byDay[e.date] || 0) + e.hours; });
            const visibleByDay = {};
            visible.forEach(e => { visibleByDay[e.date] = (visibleByDay[e.date] || 0) + e.hours; });
            for (const [d, h] of Object.entries(visibleByDay)) {
                ot += Math.max(0, byDay[d] - s.stdDayHours) * (h / byDay[d]);
            }
        } else if (sheetHours > 0) {
            ot = (sh.overtimeHours || 0) * (visibleHours / sheetHours);
        }
        total += visibleHours;
        overtime += ot;

        const m = memberByUid.get(sh.uid);
        const mk = byMember.get(sh.uid) || { uid: sh.uid, name: (m && m.name) || sh.memberName || sh.uid, hours: 0, overtimeHours: 0, weeks: 0 };
        mk.hours += visibleHours; mk.overtimeHours += ot; mk.weeks += 1;
        byMember.set(sh.uid, mk);

        for (const e of visible) {
            const p = projects.get(e.projectId);
            const pk = byProject.get(e.projectId) || { projectId: e.projectId, code: p ? p.code : '?', name: p ? p.name : 'Deleted project', hours: 0, people: new Set() };
            pk.hours += e.hours; pk.people.add(sh.uid);
            byProject.set(e.projectId, pk);
            rows.push({ date: e.date, member: mk.name, projectCode: pk.code, projectName: pk.name, hours: e.hours, note: e.note || '' });
        }
    }
    rows.sort((a, b) => a.date.localeCompare(b.date) || a.member.localeCompare(b.member));
    return {
        month,
        totalHours: round2(total),
        overtimeHours: round2(overtime),
        sheets: status,
        byProject: [...byProject.values()].map(p => ({ projectId: p.projectId, code: p.code, name: p.name, hours: round2(p.hours), people: p.people.size }))
            .sort((a, b) => b.hours - a.hours),
        byMember: [...byMember.values()].map(m => ({ ...m, hours: round2(m.hours), overtimeHours: round2(m.overtimeHours) }))
            .sort((a, b) => b.hours - a.hours),
        rows
    };
}

async function buildWorkbook(report, companyName) {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    wb.creator = 'EB Tracker Timesheet Portal';
    const head = ws => { ws.getRow(1).font = { bold: true }; ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCE6F1' } }; };

    const sum = wb.addWorksheet('Summary');
    sum.columns = [{ header: 'Item', key: 'k', width: 30 }, { header: 'Value', key: 'v', width: 20 }];
    head(sum);
    sum.addRows([
        { k: 'Company', v: companyName }, { k: 'Month', v: report.month },
        { k: 'Approved hours', v: report.totalHours }, { k: 'Overtime hours', v: report.overtimeHours },
        { k: 'Sheets approved', v: report.sheets.approved || 0 }, { k: 'Sheets waiting approval', v: report.sheets.submitted || 0 },
        { k: 'Sheets returned', v: report.sheets.returned || 0 }, { k: 'Sheets in draft', v: report.sheets.draft || 0 }
    ]);

    const bp = wb.addWorksheet('By project');
    bp.columns = [{ header: 'Code', key: 'code', width: 14 }, { header: 'Project', key: 'name', width: 36 }, { header: 'Hours', key: 'hours', width: 10 }, { header: 'People', key: 'people', width: 10 }];
    head(bp); bp.addRows(report.byProject);

    const bm = wb.addWorksheet('By person');
    bm.columns = [{ header: 'Name', key: 'name', width: 30 }, { header: 'Hours', key: 'hours', width: 10 }, { header: 'Overtime', key: 'overtimeHours', width: 10 }, { header: 'Weeks', key: 'weeks', width: 8 }];
    head(bm); bm.addRows(report.byMember);

    const en = wb.addWorksheet('Entries');
    en.columns = [{ header: 'Date', key: 'date', width: 12 }, { header: 'Person', key: 'member', width: 26 }, { header: 'Project code', key: 'projectCode', width: 14 },
        { header: 'Project', key: 'projectName', width: 30 }, { header: 'Hours', key: 'hours', width: 8 }, { header: 'Note', key: 'note', width: 40 }];
    head(en); en.addRows(report.rows);

    return wb.xlsx.writeBuffer();
}

module.exports = { scopeFor, loadMonthSheets, aggregate, buildWorkbook };
