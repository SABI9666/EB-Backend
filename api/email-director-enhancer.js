// api/email-director-enhancer.js
// Adds Director Approval notification emails with a direct portal link
// for pricing.complete and pricing.updated events.
//
// How it works:
//   This module is required EARLY in server.js (before proposals.js) so that
//   when it does `require('./email')` the email module loads, and we then
//   replace its exported `sendEmailNotification` with a wrapped version.
//   Because Node caches modules, any later `require('./email')` in
//   proposals.js/etc. receives the already-wrapped function.
//
//   The wrapper sends a dedicated Director approval email (with an approve /
//   open-portal button pointing directly at the proposal in the portal) and
//   then delegates to the original sendEmailNotification so all existing
//   COO/BDM/etc. notifications continue to work unchanged.

const emailModule = require('./email');
const { Resend } = require('resend');
const admin = require('./_firebase-admin');

const DASHBOARD_URL = 'https://edanbrook-tracker.web.app';
const FROM_EMAIL = 'EB-Tracker <ithelpdesk@edanbrook.com>';

const DIRECTOR_EVENTS = new Set(['pricing.complete', 'pricing.updated']);

function esc(v) {
    if (v === null || v === undefined) return 'N/A';
    return String(v)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function buildDirectorApprovalHtml(event, data) {
    const isUpdate = event === 'pricing.updated';
    const heading = isUpdate ? 'Pricing Updated – Review Required' : 'Director Approval Required';
    const bannerText = isUpdate
        ? 'The updated pricing requires your review and approval before submission.'
        : 'This proposal requires your review and approval before it can be submitted to the client.';
    const actor = data.updatedBy || data.pricedBy || 'the COO';
    const intro = isUpdate
        ? `Pricing for the project below has been updated by <strong>${esc(actor)}</strong> and is now awaiting your review and approval.`
        : `Pricing has been completed by <strong>${esc(actor)}</strong> for the project below and is now awaiting your approval.`;

    const proposalId = data.proposalId || '';
    const reviewUrl = `${DASHBOARD_URL}?action=view-proposal&id=${encodeURIComponent(proposalId)}`;

    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif;color:#1e293b;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f1f5f9;padding:30px 0;">
<tr><td align="center">
  <table role="presentation" width="640" cellspacing="0" cellpadding="0" border="0" style="background:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 6px 18px rgba(15,23,42,0.08);">
    <tr><td style="background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);padding:28px 32px;color:#ffffff;">
      <h1 style="margin:0;font-size:20px;font-weight:600;">EB-Tracker • Director Approval</h1>
    </td></tr>
    <tr><td style="padding:32px;">
      <h2 style="margin:0 0 14px 0;font-size:22px;color:#1e293b;">Director Approval – ${heading}</h2>
      <p style="margin:0 0 18px 0;font-size:15px;line-height:1.6;color:#475569;">${intro}</p>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;margin:12px 0 22px 0;">
        <tr><td style="padding:16px 20px;">
          <p style="margin:4px 0;font-size:14px;color:#475569;"><strong style="color:#1e293b;">Project:</strong> ${esc(data.projectName)}</p>
          <p style="margin:4px 0;font-size:14px;color:#475569;"><strong style="color:#1e293b;">Project Number:</strong> ${esc(data.projectNumber)}</p>
          <p style="margin:4px 0;font-size:14px;color:#475569;"><strong style="color:#1e293b;">Quote Value:</strong> ${esc(data.quoteValue)}</p>
          <p style="margin:4px 0;font-size:14px;color:#475569;"><strong style="color:#1e293b;">${isUpdate ? 'Updated By' : 'Priced By'}:</strong> ${esc(actor)}</p>
          <p style="margin:4px 0;font-size:14px;color:#475569;"><strong style="color:#1e293b;">Date:</strong> ${esc(data.date || new Date().toLocaleDateString())}</p>
        </td></tr>
      </table>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#fef3c7;border-left:4px solid #f59e0b;border-radius:6px;margin:0 0 22px 0;">
        <tr><td style="padding:12px 16px;font-size:14px;color:#78350f;">${bannerText}</td></tr>
      </table>
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:10px 0 18px 0;">
        <tr>
          <td style="border-radius:6px;background:#10b981;">
            <a href="${reviewUrl}" target="_blank" style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:6px;">Review &amp; Approve</a>
          </td>
          <td style="width:12px;"></td>
          <td style="border-radius:6px;background:#764ba2;">
            <a href="${DASHBOARD_URL}" target="_blank" style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:6px;">Open EB-Tracker Portal</a>
          </td>
        </tr>
      </table>
      <p style="margin:0;font-size:13px;color:#94a3b8;line-height:1.5;">
        Click <strong>Review &amp; Approve</strong> to open the proposal directly in the portal — you will be prompted to sign in if needed, and then taken straight to the approval screen.
      </p>
    </td></tr>
    <tr><td style="padding:18px 32px;background:#f8fafc;border-top:1px solid #e2e8f0;font-size:12px;color:#64748b;text-align:center;">
      This is an automated notification from EB-Tracker. Director approval is required to proceed with this proposal.
    </td></tr>
  </table>
</td></tr>
</table>
</body></html>`;
}

async function resolveDirectorEmails(data) {
    const emails = [];
    if (data && data.directorEmail && String(data.directorEmail).includes('@')) {
        emails.push(String(data.directorEmail));
    }
    try {
        const db = admin.firestore();
        const snap = await db.collection('users').where('role', '==', 'director').get();
        snap.forEach(doc => {
            const e = doc.data() && doc.data().email;
            if (e && String(e).includes('@')) emails.push(String(e));
        });
    } catch (e) {
        console.warn('director-enhancer: failed to look up directors:', e.message);
    }
    return [...new Set(emails)];
}

async function sendDirectorApprovalEmail(event, data) {
    if (!process.env.RESEND_API_KEY) {
        console.warn('director-enhancer: RESEND_API_KEY missing, skipping director email');
        return { success: false, error: 'Missing RESEND_API_KEY' };
    }
    const recipients = await resolveDirectorEmails(data || {});
    if (recipients.length === 0) {
        console.warn(`director-enhancer: no director recipients for '${event}'`);
        return { success: false, error: 'No director recipients' };
    }
    const resend = new Resend(process.env.RESEND_API_KEY);
    const subjectBase = event === 'pricing.updated'
        ? 'Pricing Updated – Director Review Required'
        : 'Director Approval Required – Pricing Ready';
    const subject = `${subjectBase} for ${data && data.projectName ? data.projectName : 'a project'}`;
    const html = buildDirectorApprovalHtml(event, data || {});

    let sent = 0;
    for (const to of recipients) {
        try {
            const result = await resend.emails.send({
                from: FROM_EMAIL,
                to: [to],
                subject,
                html
            });
            if (result && !result.error) {
                sent += 1;
                console.log(`  director approval email sent to: ${to}`);
            } else {
                console.warn(`  director approval email failed to ${to}:`, result && result.error && result.error.message);
            }
        } catch (err) {
            console.warn(`  director approval email error for ${to}:`, err.message);
        }
    }
    return { success: sent > 0, recipients: sent, total: recipients.length };
}

const originalSendEmailNotification = emailModule.sendEmailNotification;

async function wrappedSendEmailNotification(event, data) {
    if (DIRECTOR_EVENTS.has(event)) {
        try {
            console.log(`director-enhancer: sending Director approval email for '${event}'`);
            await sendDirectorApprovalEmail(event, data || {});
        } catch (err) {
            console.error('director-enhancer: director email failed:', err.message);
        }
    }
    if (typeof originalSendEmailNotification === 'function') {
        return originalSendEmailNotification(event, data);
    }
    return { success: false, error: 'Original sendEmailNotification not available' };
}

emailModule.sendEmailNotification = wrappedSendEmailNotification;
console.log('director-enhancer: wrapped sendEmailNotification for pricing.complete / pricing.updated');

module.exports = {
    sendDirectorApprovalEmail,
    wrappedSendEmailNotification
};
