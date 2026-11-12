// Read an uploaded week (Excel .xlsx or .csv) into rows.
// Columns: Date, Project code, Hours, Note  (first row is the header)

function parseCsv(text) {
    const rows = [];
    let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (q) {
            if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
            else if (ch === '"') q = false;
            else cell += ch;
        } else if (ch === '"') q = true;
        else if (ch === ',' || ch === ';' || ch === '\t') { row.push(cell); cell = ''; }
        else if (ch === '\n' || ch === '\r') {
            if (ch === '\r' && text[i + 1] === '\n') i++;
            row.push(cell); rows.push(row); row = []; cell = '';
        } else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(r => r.some(c => String(c).trim() !== ''));
}

const pad = n => String(n).padStart(2, '0');
// Accepts 2026-11-09, 09/11/2026 (day first), 9-11-2026, Excel dates and serial numbers.
function toIsoDate(v) {
    if (v instanceof Date && !isNaN(v)) return `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`;
    if (typeof v === 'number' && v > 20000 && v < 80000) {
        return toIsoDate(new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000));
    }
    if (v && typeof v === 'object' && 'result' in v) return toIsoDate(v.result); // formula cell
    const s = String(v == null ? '' : v).trim();
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
    m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
    if (m) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
    return s;
}

function cellText(v) {
    if (v == null) return '';
    if (typeof v === 'object') {
        if ('result' in v) return cellText(v.result);
        if ('text' in v) return String(v.text);
        if (Array.isArray(v.richText)) return v.richText.map(r => r.text).join('');
    }
    return String(v);
}

async function readRows(file) {
    const name = String(file.originalname || '').toLowerCase();
    const buf = file.buffer;
    let raw;
    if (name.endsWith('.csv')) {
        raw = parseCsv(buf.toString('utf8').replace(/^﻿/, ''));
    } else if (name.endsWith('.xlsx')) {
        if (buf.slice(0, 2).toString('latin1') !== 'PK') { const e = new Error('This is not a valid .xlsx file'); e.status = 400; throw e; }
        const ExcelJS = require('exceljs');
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(buf);
        const ws = wb.worksheets[0];
        raw = [];
        if (ws) ws.eachRow({ includeEmpty: false }, row => {
            raw.push([1, 2, 3, 4].map(i => row.getCell(i).value));
        });
    } else {
        const e = new Error('Upload a .xlsx or .csv file'); e.status = 400; throw e;
    }
    // Skip the header row if the first cell is not a date.
    if (raw.length && !/^\d/.test(toIsoDate(raw[0][0]))) raw = raw.slice(1);
    if (raw.length > 500) { const e = new Error('The file has too many rows (max 500)'); e.status = 400; throw e; }
    return raw.map(r => ({
        date: toIsoDate(r[0]),
        projectCode: cellText(r[1]).trim(),
        hours: Number(cellText(r[2]).trim().replace(',', '.')),
        note: cellText(r[3]).trim()
    }));
}

module.exports = { parseCsv, toIsoDate, readRows };
