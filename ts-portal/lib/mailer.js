// Best-effort email for the Timesheet Portal. Never throws: a failed email
// must not fail the approval or invite that triggered it.
const { Resend } = require('resend');

const FROM = () => process.env.TS_EMAIL_FROM || 'EB Tracker Timesheets <ithelpdesk@edanbrook.com>';
const PORTAL_URL = () => (process.env.TS_PORTAL_URL || 'https://eb-tracker-frontend.vercel.app/timesheet/').replace(/\/?$/, '/');

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function layout(title, bodyHtml, cta) {
    const button = cta ? `<p style="margin:24px 0"><a href="${esc(cta.href)}" style="background:#1f4e79;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600">${esc(cta.label)}</a></p>` : '';
    return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:auto;color:#1b2430">
<h2 style="color:#1f4e79;margin-bottom:8px">${esc(title)}</h2>${bodyHtml}${button}
<p style="color:#7a8594;font-size:12px;margin-top:32px">EB Tracker · Timesheet Portal</p></div>`;
}

let _client = null;
function client() {
    if (!process.env.RESEND_API_KEY) return null;
    if (!_client) _client = new Resend(process.env.RESEND_API_KEY);
    return _client;
}
function _setClientForTests(c) { _client = c; }

async function send(to, subject, html) {
    const list = [...new Set((Array.isArray(to) ? to : [to]).filter(Boolean).map(e => String(e).toLowerCase()))];
    if (!list.length) return { sent: 0 };
    const c = client();
    if (!c) { console.warn('[ts-portal] RESEND_API_KEY missing; email not sent:', subject); return { sent: 0 }; }
    const sandbox = process.env.TS_SANDBOX_EMAIL;
    let sent = 0;
    // One email per person so addresses are never shared between companies or colleagues.
    for (const addr of list) {
        try {
            await c.emails.send({
                from: FROM(),
                to: [sandbox || addr],
                subject: sandbox ? `[to ${addr}] ${subject}` : subject,
                html
            });
            sent++;
        } catch (e) {
            console.error('[ts-portal] email failed:', addr, e && e.message);
        }
    }
    return { sent };
}

module.exports = { send, layout, esc, PORTAL_URL, _setClientForTests };
