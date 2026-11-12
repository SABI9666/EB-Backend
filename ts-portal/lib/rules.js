// Pure timesheet rules: dates, settings, entry validation and totals.
// No Firestore here so everything can be unit tested.

const ROLES = ['employee', 'supervisor', 'project_manager', 'gm', 'company_admin'];
const MANAGER_ROLES = ['supervisor', 'project_manager', 'gm', 'company_admin'];
const STEP_TYPES = ['supervisor', 'project_manager', 'gm'];

const DEFAULT_SETTINGS = {
    stdDayHours: 8,          // normal working day
    stdWeekHours: 40,        // normal working week
    maxDayHours: 16,         // hard limit per day
    stepHours: 0.25,         // hours must be multiples of this
    noteOverHours: 10,       // a note is required on a day above this
    overtimeMode: 'week',    // 'week' = above stdWeekHours, 'day' = each day above stdDayHours
    approvalSteps: ['supervisor'], // ordered; any of supervisor, project_manager, gm
    reminderDow: 5,          // 0 = Sunday ... 5 = Friday
    reminderHour: 16,        // local hour (company time zone)
    monthlyReportEmail: true // email GM + company admins on the 1st of each month
};

class ValidationError extends Error {
    constructor(message, details) { super(message); this.status = 400; this.details = details; }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function isDate(s) {
    if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
    const d = new Date(s + 'T00:00:00Z');
    return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}
function addDays(s, n) {
    const d = new Date(s + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}
// Weeks always start on Monday.
function weekStartOf(s) {
    const dow = new Date(s + 'T00:00:00Z').getUTCDay(); // 0 Sunday
    return addDays(s, dow === 0 ? -6 : 1 - dow);
}
function isWeekStart(s) { return isDate(s) && weekStartOf(s) === s; }
function weekDates(ws) { return [0, 1, 2, 3, 4, 5, 6].map(i => addDays(ws, i)); }
function isMonth(m) { return typeof m === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(m); }
function monthRange(m) {
    const [y, mo] = m.split('-').map(Number);
    const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    return { first: `${m}-01`, last: `${m}-${String(last).padStart(2, '0')}` };
}
function prevMonth(m) {
    const [y, mo] = m.split('-').map(Number);
    return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`;
}
const round2 = n => Math.round(n * 100) / 100;

function num(v, name, min, max) {
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) throw new ValidationError(`${name} must be between ${min} and ${max}`);
    return n;
}

// Merge a partial settings update over the current settings, validating every field.
function validateSettings(input, current = DEFAULT_SETTINGS) {
    const s = { ...DEFAULT_SETTINGS, ...current };
    const i = input || {};
    if (i.stdDayHours !== undefined) s.stdDayHours = num(i.stdDayHours, 'Standard day hours', 1, 24);
    if (i.stdWeekHours !== undefined) s.stdWeekHours = num(i.stdWeekHours, 'Standard week hours', 1, 168);
    if (i.maxDayHours !== undefined) s.maxDayHours = num(i.maxDayHours, 'Maximum hours per day', 1, 24);
    if (i.stepHours !== undefined) {
        s.stepHours = Number(i.stepHours);
        if (![0.1, 0.25, 0.5, 1].includes(s.stepHours)) throw new ValidationError('Hour step must be 0.1, 0.25, 0.5 or 1');
    }
    if (i.noteOverHours !== undefined) s.noteOverHours = num(i.noteOverHours, 'Note required above', 0, 24);
    if (i.overtimeMode !== undefined) {
        if (!['week', 'day'].includes(i.overtimeMode)) throw new ValidationError('Overtime mode must be week or day');
        s.overtimeMode = i.overtimeMode;
    }
    if (i.approvalSteps !== undefined) {
        if (!Array.isArray(i.approvalSteps) || i.approvalSteps.some(x => !STEP_TYPES.includes(x))
            || new Set(i.approvalSteps).size !== i.approvalSteps.length) {
            throw new ValidationError('Approval steps must be a list of supervisor, project_manager, gm (no repeats)');
        }
        s.approvalSteps = i.approvalSteps.slice();
    }
    if (i.reminderDow !== undefined) s.reminderDow = num(i.reminderDow, 'Reminder day', 0, 6);
    if (i.reminderHour !== undefined) s.reminderHour = num(i.reminderHour, 'Reminder hour', 0, 23);
    if (i.monthlyReportEmail !== undefined) s.monthlyReportEmail = !!i.monthlyReportEmail;
    if (s.maxDayHours < s.stdDayHours) throw new ValidationError('Maximum hours per day cannot be below standard day hours');
    return s;
}

function isMultiple(h, step) {
    const r = h / step;
    return Math.abs(r - Math.round(r)) < 1e-9;
}

// Validate a week's entries. projects: Map(projectId -> project).
// Returns { entries, errors } where errors carry the row index.
function validateEntries(raw, { weekStart, settings, projects, uid }) {
    const s = { ...DEFAULT_SETTINGS, ...settings };
    const dates = new Set(weekDates(weekStart));
    const errors = [];
    const entries = [];
    const seen = new Set();
    if (!Array.isArray(raw)) throw new ValidationError('entries must be a list');
    if (raw.length > 500) throw new ValidationError('Too many entries');
    raw.forEach((e, row) => {
        const err = msg => errors.push({ row, error: msg });
        if (!e || typeof e !== 'object') return err('Invalid entry');
        const date = String(e.date || '');
        const projectId = String(e.projectId || '');
        const hours = Number(e.hours);
        const note = String(e.note || '').trim().slice(0, 500);
        if (!dates.has(date)) return err(`Date ${date || '(empty)'} is not in the week starting ${weekStart}`);
        if (!Number.isFinite(hours) || hours < 0 || hours > 24) return err('Hours must be between 0 and 24');
        if (hours === 0) return; // empty cell
        if (!isMultiple(hours, s.stepHours)) return err(`Hours must be in steps of ${s.stepHours}`);
        const p = projects.get(projectId);
        if (!p) return err('Unknown project');
        if (p.active === false) return err(`Project ${p.code} is closed`);
        if (Array.isArray(p.memberUids) && p.memberUids.length && !p.memberUids.includes(uid)) {
            return err(`You are not assigned to project ${p.code}`);
        }
        const key = projectId + '|' + date;
        if (seen.has(key)) return err(`Project ${p.code} appears twice on ${date}`);
        seen.add(key);
        entries.push({ projectId, date, hours: round2(hours), note });
    });
    const byDay = {};
    entries.forEach(e => { byDay[e.date] = (byDay[e.date] || 0) + e.hours; });
    Object.entries(byDay).forEach(([date, total]) => {
        if (total > s.maxDayHours + 1e-9) errors.push({ row: null, error: `${date}: ${round2(total)} h is above the daily limit of ${s.maxDayHours} h` });
        else if (total > s.noteOverHours + 1e-9 && !entries.some(e => e.date === date && e.note)) {
            errors.push({ row: null, error: `${date}: a note is required when a day is above ${s.noteOverHours} h` });
        }
    });
    entries.sort((a, b) => a.date.localeCompare(b.date) || a.projectId.localeCompare(b.projectId));
    return { entries, errors };
}

function computeTotals(entries, settings) {
    const s = { ...DEFAULT_SETTINGS, ...settings };
    const byDay = {};
    const byProject = {};
    let total = 0;
    for (const e of entries) {
        byDay[e.date] = round2((byDay[e.date] || 0) + e.hours);
        byProject[e.projectId] = round2((byProject[e.projectId] || 0) + e.hours);
        total += e.hours;
    }
    let overtime;
    if (s.overtimeMode === 'day') overtime = Object.values(byDay).reduce((a, h) => a + Math.max(0, h - s.stdDayHours), 0);
    else overtime = Math.max(0, total - s.stdWeekHours);
    return {
        totalHours: round2(total),
        overtimeHours: round2(overtime),
        maxDayHours: round2(Math.max(0, ...Object.values(byDay))),
        byDay, byProject,
        projectIds: Object.keys(byProject).sort()
    };
}

module.exports = {
    ROLES, MANAGER_ROLES, STEP_TYPES, DEFAULT_SETTINGS, ValidationError,
    isDate, addDays, weekStartOf, isWeekStart, weekDates, isMonth, monthRange, prevMonth, round2,
    validateSettings, validateEntries, computeTotals
};
