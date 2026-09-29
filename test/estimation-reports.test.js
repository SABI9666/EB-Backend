const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const users = { coo: { role: 'coo' }, director: { role: 'director' }, bdm: { role: 'bdm' } };
const database = { collection: () => ({ doc: uid => ({ get: async () => ({ exists: !!users[uid], data: () => ({ name: uid, status: 'active', ...users[uid] }) }) }) }) };
const mock = { apps: [{}], firestore: () => database, auth: () => ({ verifyIdToken: async token => ({ uid: token, email: token + '@test.local' }) }) };
require.cache[require.resolve('../api/_firebase-admin')] = { exports: mock };

// Minimal one-page ARCH D drawing with a title block and member callouts.
function samplePdf() {
    const text = [[1900, 80, 9, 'DRAWING NO.'], [1900, 66, 14, 'S-201'], [400, 1300, 10, 'W12X26'], [400, 1200, 10, 'HSS6X6X3/8']];
    const stream = 'BT\n' + text.map(([x, y, s, t]) => `/F1 ${s} Tf 1 0 0 1 ${x} ${y} Tm (${t}) Tj\n`).join('') + 'ET';
    const objs = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 2592 1728] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    ];
    let out = '%PDF-1.4\n';
    const offsets = objs.map((o, i) => { const at = out.length; out += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
    const xref = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('');
    out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
}

test('estimation PDF extraction is limited to COO/Director and returns positioned text', async t => {
    const app = express();
    app.use('/api/estimation-reports', require('../api/estimation-reports'));
    const server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => server.close());
    const url = `http://127.0.0.1:${server.address().port}/api/estimation-reports/extract`;
    const post = (token, name, body) => {
        const form = new FormData();
        if (body) form.append('file', new Blob([body], { type: 'application/pdf' }), name);
        return fetch(url, { method: 'POST', headers: token ? { Authorization: 'Bearer ' + token } : {}, body: form });
    };

    assert.equal((await post(null, 'a.pdf', samplePdf())).status, 401);
    assert.equal((await post('bdm', 'a.pdf', samplePdf())).status, 403);
    assert.equal((await post('coo', 'a.pdf', null)).status, 400);
    assert.equal((await post('coo', 'a.pdf', Buffer.from('not a pdf'))).status, 400);

    for (const role of ['coo', 'director']) {
        const res = await post(role, 'S-201.pdf', samplePdf());
        assert.equal(res.status, 200);
        const { success, data } = await res.json();
        assert.equal(success, true);
        assert.equal(data.name, 'S-201.pdf');
        assert.equal(data.totalPages, 1);
        assert.equal(data.truncated, false);
        assert.deepEqual([data.pages[0].widthPt, data.pages[0].heightPt], [2592, 1728]);
        const strings = data.pages[0].items.map(i => i[0]);
        assert.deepEqual(strings.sort(), ['DRAWING NO.', 'HSS6X6X3/8', 'S-201', 'W12X26']);
        const dwg = data.pages[0].items.find(i => i[0] === 'S-201');
        assert.deepEqual(dwg.slice(1, 3), [1900, 66]);
        assert.equal(dwg[4], 14);
    }
});
