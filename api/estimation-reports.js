// api/estimation-reports.js
// COO/Director "Estimation Report Generation": server-side PDF text extraction.
//
// POST /api/estimation-reports/extract  (multipart, field `file`, one PDF)
//   -> { success, data: { name, size, totalPages, truncated, meta, pages } }
//
// Each page carries its size in PDF points and its positioned text runs as
// compact tuples [text, x, y, width, height]. The portal groups these into
// rows/cells and parses drawing numbers, member sizes, rebar, grades and notes.
// The PDF is processed in memory only; nothing is written to storage.

const express = require('express');
const multer = require('multer');
const { verifyToken, requireRole } = require('../middleware/auth');

const router = express.Router();

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_PAGES = 300;
const MAX_ITEMS_PER_PAGE = 8000;
const READ_ROLES = ['coo', 'director'];

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_BYTES, files: 1 },
});

let pdfjsLib = null;
function pdfjs() {
    if (!pdfjsLib) pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
    return pdfjsLib;
}

function round(n) { return Math.round((Number(n) || 0) * 100) / 100; }

async function extractPdf(buffer) {
    const doc = await pdfjs().getDocument({
        data: new Uint8Array(buffer),
        isEvalSupported: false,
        disableFontFace: true,
        useSystemFonts: false,
        verbosity: 0,
    }).promise;
    try {
        let meta = {};
        try {
            const m = await doc.getMetadata();
            const info = (m && m.info) || {};
            meta = {
                title: info.Title || '', author: info.Author || '', creator: info.Creator || '',
                producer: info.Producer || '', created: info.CreationDate || '',
            };
        } catch (e) { /* metadata is optional */ }

        const count = Math.min(doc.numPages, MAX_PAGES);
        const pages = [];
        for (let i = 1; i <= count; i++) {
            const page = await doc.getPage(i);
            const vp = page.getViewport({ scale: 1 });
            const tc = await page.getTextContent();
            const items = [];
            for (const it of tc.items) {
                if (!it || typeof it.str !== 'string' || !it.str.trim()) continue;
                const t = it.transform || [1, 0, 0, 1, 0, 0];
                items.push([it.str, round(t[4]), round(t[5]), round(it.width), round(Math.abs(t[3]) || Math.abs(t[0]) || 8)]);
                if (items.length >= MAX_ITEMS_PER_PAGE) break;
            }
            pages.push({ number: i, widthPt: round(vp.width), heightPt: round(vp.height), items });
            page.cleanup();
        }
        return { totalPages: doc.numPages, truncated: doc.numPages > count, meta, pages };
    } finally {
        try { await doc.destroy(); } catch (e) { /* ignore */ }
    }
}

function receiveFile(req, res, next) {
    upload.single('file')(req, res, (err) => {
        if (!err) return next();
        const tooBig = err.code === 'LIMIT_FILE_SIZE';
        return res.status(tooBig ? 413 : 400).json({
            success: false,
            error: tooBig ? 'Maximum size is 25 MB per PDF.' : 'Invalid upload: ' + err.message,
        });
    });
}

router.post('/extract', verifyToken, requireRole(READ_ROLES), receiveFile, async (req, res) => {
    const file = req.file;
    if (!file || !file.buffer || !file.buffer.length) {
        return res.status(400).json({ success: false, error: 'Attach one PDF in the "file" field.' });
    }
    if (file.buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
        return res.status(400).json({ success: false, error: 'This file does not have a PDF header.' });
    }
    try {
        const result = await extractPdf(file.buffer);
        return res.json({ success: true, data: { name: file.originalname, size: file.size, ...result } });
    } catch (err) {
        const password = err && err.name === 'PasswordException';
        console.error('Estimation PDF extraction failed:', file.originalname, err && err.message);
        return res.status(422).json({
            success: false,
            error: password ? 'PDF is password protected.' : 'Could not read this PDF.',
        });
    }
});

router.extractPdf = extractPdf;
module.exports = router;
