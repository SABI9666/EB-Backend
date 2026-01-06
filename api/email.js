// api/email.js - Enhanced Email Notification API with Timesheet & Invoice Notifications
const express = require('express');
const { Resend } = require('resend');
const admin = require('./_firebase-admin');

const emailRouter = express.Router();
const db = admin.firestore();

// ==========================================
// CONFIGURATION
// ==========================================
const FROM_EMAIL = 'EB-Tracker <sabin@edanbrook.com>'; 
const DASHBOARD_URL = 'https://edanbrook-tracker.web.app';

const EMAIL_RECIPIENT_MAP = {
  'proposal.created': ['coo', 'director', 'estimator'],
  'project.submitted': ['coo', 'director', 'estimator'],
  'project.approved_by_director': [], // Dynamic only (BDM)
  'proposal.uploaded': ['estimator'],
  'estimation.complete': ['coo'],
  'pricing.complete': ['director'], // COO completes pricing → Director approves
  'pricing.allocated': ['director'], // For backwards compatibility
  'project.won': ['coo', 'director'],
  'project.allocated': ['coo'], // COO allocates → Design Manager (+ dynamic Design Manager)
  'designer.allocated': ['coo'], // Design Manager allocates → Designer (+ dynamic Designer)
  'variation.allocated': ['bdm', 'coo', 'director'],
  'variation.approved': ['bdm', 'coo', 'director', 'design_lead'],
  'invoice.saved': ['bdm', 'coo', 'director'],
  
  // New notification types for timesheet workflow
  'time_request.created': ['design_lead', 'coo', 'director'], // Designer requests additional hours
  'time_request.approved': ['design_lead', 'director'], // COO approves additional hours - Designer added dynamically via data.designerEmail
  'time_request.rejected': ['design_lead'], // COO rejects additional hours - Designer added dynamically via data.designerEmail
  'variation.requested': ['coo', 'director'], // Design Manager requests variation
  'variation.approved_detail': ['design_lead', 'bdm', 'director', 'coo'], // Variation approval with hour/rate details
  'invoice.created': ['coo', 'director', 'bdm'], // Invoice created
  'invoice.payment_due': ['coo', 'director', 'bdm'], // Payment due reminder
  'invoice.overdue': ['coo', 'director', 'bdm'], // Overdue payment notification
  
  // Leave Request notification types
  'leave.submitted': ['coo', 'director', 'hr'], // Employee submits leave → COO, Director, HR notified
  'leave.approved': [], // Approval notification → Employee (dynamic)
  'leave.rejected': [], // Rejection notification → Employee (dynamic)
  'leave.stage_approved': ['hr'] // Stage approval → HR notified for final processing
};

// ==========================================
// PROFESSIONAL HTML EMAIL TEMPLATES
// ==========================================

// Base HTML wrapper for consistent styling
function getEmailWrapper(content, footerText = '') {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>EB-Tracker Notification</title>
</head>
<body style="margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f4f7fa;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: #f4f7fa;">
    <tr>
      <td style="padding: 40px 20px;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" style="margin: 0 auto; background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
          
          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center; border-radius: 8px 8px 0 0;">
              <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 600; letter-spacing: 0.5px;">
                EB-Tracker
              </h1>
              <p style="margin: 5px 0 0 0; color: #e0e7ff; font-size: 14px;">
                Project Management System
              </p>
            </td>
          </tr>
          
          <!-- Content -->
          <tr>
            <td style="padding: 40px 30px;">
              ${content}
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="padding: 20px 30px; background-color: #f8fafc; border-radius: 0 0 8px 8px; text-align: center;">
              <p style="margin: 0 0 10px 0; color: #64748b; font-size: 13px;">
                ${footerText || 'This is an automated notification from EB-Tracker'}
              </p>
              <p style="margin: 0; color: #94a3b8; font-size: 12px;">
                © ${new Date().getFullYear()} Edanbrook. All rights reserved.
              </p>
            </td>
          </tr>
          
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();
}

// Reusable button component
function getButton(text, url, color = '#667eea') {
  return `
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 25px 0;">
      <tr>
        <td style="border-radius: 6px; background-color: ${color};">
          <a href="${url}" target="_blank" style="display: inline-block; padding: 14px 32px; font-size: 15px; font-weight: 600; color: #ffffff; text-decoration: none; border-radius: 6px;">
            ${text}
          </a>
        </td>
      </tr>
    </table>
  `;
}

// Info box component
function getInfoBox(items) {
  const rows = items.map(item => `
    <tr>
      <td style="padding: 10px 0; border-bottom: 1px solid #e2e8f0;">
        <strong style="color: #475569; font-size: 14px;">${item.label}:</strong>
        <span style="color: #1e293b; font-size: 14px; margin-left: 8px;">${item.value}</span>
      </td>
    </tr>
  `).join('');
  
  return `
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin: 20px 0; background-color: #f8fafc; border-radius: 6px; padding: 15px;">
      ${rows}
    </table>
  `;
}

// Alert/Status banner
function getStatusBanner(message, type = 'info') {
  const colors = {
    success: { bg: '#dcfce7', border: '#22c55e', text: '#166534' },
    warning: { bg: '#fef3c7', border: '#f59e0b', text: '#92400e' },
    info: { bg: '#dbeafe', border: '#3b82f6', text: '#1e40af' },
    error: { bg: '#fee2e2', border: '#ef4444', text: '#991b1b' },
    urgent: { bg: '#fef2f2', border: '#dc2626', text: '#7f1d1d' }
  };
  
  const color = colors[type] || colors.info;
  
  return `
    <div style="background-color: ${color.bg}; border-left: 4px solid ${color.border}; padding: 15px 20px; margin: 20px 0; border-radius: 4px;">
      <p style="margin: 0; color: ${color.text}; font-size: 14px; line-height: 1.5;">
        ${message}
      </p>
    </div>
  `;
}

// Format currency
function formatCurrency(amount) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2
  }).format(amount || 0);
}

// Format date
function formatDate(date) {
  if (!date) return 'N/A';
  const d = date instanceof Date ? date : new Date(date);
  return d.toLocaleDateString('en-US', { 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric' 
  });
}

// ==========================================
// EMAIL TEMPLATES (Including New Templates)
// ==========================================
const EMAIL_TEMPLATE_MAP = {
  'default': {
    subject: 'Notification from EB-Tracker',
    html: (data) => getEmailWrapper(`
      <h2 style="margin: 0 0 20px 0; color: #1e293b; font-size: 20px;">Notification</h2>
      <p style="margin: 0; color: #475569; font-size: 15px; line-height: 1.6;">
        ${data.message || 'You have a new notification from EB-Tracker.'}
      </p>
      ${getButton('View Dashboard', DASHBOARD_URL)}
    `)
  },

  // =============== TIMESHEET TEMPLATES ===============
  'time_request.created': {
    subject: '⏰ Additional Time Request: {{projectName}}',
    html: (data) => getEmailWrapper(`
      <h2 style="margin: 0 0 15px 0; color: #1e293b; font-size: 22px;">
        ⏰ Additional Time Request Submitted
      </h2>
      <p style="margin: 0 0 20px 0; color: #475569; font-size: 15px; line-height: 1.6;">
        A designer has requested additional hours for the following project:
      </p>
      ${getInfoBox([
        { label: 'Project', value: `${data.projectName} (${data.projectCode || 'N/A'})` },
        { label: 'Client', value: data.clientCompany || 'N/A' },
        { label: 'Designer', value: data.designerName || 'N/A' },
        { label: 'Requested Hours', value: `${data.requestedHours || 0} hours` },
        { label: 'Current Hours Logged', value: `${data.currentHoursLogged || 0} hours` },
        { label: 'Current Allocated', value: `${data.currentAllocatedHours || 0} hours` },
        { label: 'Reason', value: data.reason || 'No reason provided' }
      ])}
      ${getStatusBanner('This request requires approval from COO/Director.', 'warning')}
      ${getButton('Review Request', `${DASHBOARD_URL}/time-requests`)}
    `, 'Please review and approve/reject this time request.')
  },

  'time_request.approved': {
    subject: '✅ Additional Time Approved: {{projectName}}',
    html: (data) => getEmailWrapper(`
      <h2 style="margin: 0 0 15px 0; color: #1e293b; font-size: 22px;">
        ✅ Additional Time Request Approved
      </h2>
      ${getStatusBanner('Your request for additional time has been approved!', 'success')}
      ${getInfoBox([
        { label: 'Project', value: `${data.projectName} (${data.projectCode || 'N/A'})` },
        { label: 'Requested Hours', value: `${data.requestedHours || 0} hours` },
        { label: 'Approved Hours', value: `${data.approvedHours || 0} hours` },
        { label: 'Approved By', value: data.approvedBy || 'COO' },
        { label: 'Approval Date', value: formatDate(new Date()) },
        { label: 'Comments', value: data.comments || 'No additional comments' }
      ])}
      <p style="margin: 20px 0; color: #475569; font-size: 15px; line-height: 1.6;">
        The approved hours have been added to your project allocation. You may proceed with logging your timesheet.
      </p>
      ${getButton('View Project', `${DASHBOARD_URL}/projects/${data.projectId}`)}
    `)
  },

  'time_request.rejected': {
    subject: '❌ Additional Time Request Rejected: {{projectName}}',
    html: (data) => getEmailWrapper(`
      <h2 style="margin: 0 0 15px 0; color: #1e293b; font-size: 22px;">
        ❌ Additional Time Request Rejected
      </h2>
      ${getStatusBanner('Your request for additional time has been rejected.', 'error')}
      ${getInfoBox([
        { label: 'Project', value: `${data.projectName} (${data.projectCode || 'N/A'})` },
        { label: 'Requested Hours', value: `${data.requestedHours || 0} hours` },
        { label: 'Rejected By', value: data.rejectedBy || 'COO' },
        { label: 'Reason', value: data.rejectReason || 'No reason provided' }
      ])}
      <p style="margin: 20px 0; color: #475569; font-size: 15px; line-height: 1.6;">
        Please contact your Design Manager if you need to discuss this further.
      </p>
      ${getButton('View Project', `${DASHBOARD_URL}/projects/${data.projectId}`)}
    `)
  },

  // =============== VARIATION TEMPLATES ===============
  'variation.requested': {
    subject: '📊 Variation Request: {{projectName}}',
    html: (data) => getEmailWrapper(`
      <h2 style="margin: 0 0 15px 0; color: #1e293b; font-size: 22px;">
        📊 Variation Request Submitted
      </h2>
      <p style="margin: 0 0 20px 0; color: #475569; font-size: 15px; line-height: 1.6;">
        A Design Manager has submitted a variation request for approval:
      </p>
      ${getInfoBox([
        { label: 'Project', value: `${data.projectName} (${data.projectCode || 'N/A'})` },
        { label: 'Client', value: data.clientCompany || 'N/A' },
        { label: 'Variation Type', value: data.variationType || 'N/A' },
        { label: 'Requested By', value: data.requestedBy || 'N/A' },
        { label: 'Description', value: data.variationDescription || 'N/A' }
      ])}
      ${getStatusBanner('This variation requires your approval.', 'warning')}
      ${getButton('Review Variation', `${DASHBOARD_URL}/variations`)}
    `)
  },

  'variation.approved_detail': {
    subject: '✅ Variation Approved: {{projectName}}',
    html: (data) => getEmailWrapper(`
      <h2 style="margin: 0 0 15px 0; color: #1e293b; font-size: 22px;">
        ✅ Variation Approved with Details
      </h2>
      ${getStatusBanner('The variation request has been approved with the following details:', 'success')}
      ${getInfoBox([
        { label: 'Project', value: `${data.projectName} (${data.projectCode || 'N/A'})` },
        { label: 'Client', value: data.clientCompany || 'N/A' },
        { label: 'Variation Type', value: data.variationType || 'N/A' },
        { label: 'Additional Hours', value: data.additionalHours ? `${data.additionalHours} hours` : 'N/A' },
        { label: 'New Rate', value: data.newRate ? formatCurrency(data.newRate) : 'N/A' },
        { label: 'Total Impact', value: data.totalImpact ? formatCurrency(data.totalImpact) : 'N/A' },
        { label: 'Approved By', value: data.approvedBy || 'N/A' },
        { label: 'Approval Date', value: formatDate(new Date()) }
      ])}
      <p style="margin: 20px 0; color: #475569; font-size: 15px; line-height: 1.6;">
        Please update your project plans accordingly and communicate these changes to your team.
      </p>
      ${getButton('View Project Details', `${DASHBOARD_URL}/projects/${data.projectId}`)}
    `)
  },

  // =============== INVOICE TEMPLATES ===============
  'invoice.created': {
    subject: '💰 New Invoice Created: {{projectName}} - {{invoiceNumber}}',
    html: (data) => getEmailWrapper(`
      <h2 style="margin: 0 0 15px 0; color: #1e293b; font-size: 22px;">
        💰 New Invoice Created
      </h2>
      <p style="margin: 0 0 20px 0; color: #475569; font-size: 15px; line-height: 1.6;">
        A new invoice has been generated and requires your review:
      </p>
      ${getInfoBox([
        { label: 'Invoice Number', value: data.invoiceNumber || 'N/A' },
        { label: 'Project', value: `${data.projectName} (${data.projectCode || 'N/A'})` },
        { label: 'Client', value: data.clientCompany || 'N/A' },
        { label: 'Invoice Amount', value: formatCurrency(data.invoiceAmount) },
        { label: 'Due Date', value: formatDate(data.dueDate) },
        { label: 'Created By', value: data.createdBy || 'Accounts' },
        { label: 'Payment Terms', value: data.paymentTerms || 'Net 30' }
      ])}
      ${getStatusBanner('Please review and approve this invoice before sending to the client.', 'info')}
      ${getButton('View Invoice', `${DASHBOARD_URL}/invoices/${data.invoiceId}`)}
    `, 'Invoice requires review and approval.')
  },

  'invoice.payment_due': {
    subject: '⚠️ Payment Due Reminder: {{invoiceNumber}} - {{clientCompany}}',
    html: (data) => getEmailWrapper(`
      <h2 style="margin: 0 0 15px 0; color: #1e293b; font-size: 22px;">
        ⚠️ Payment Due Reminder
      </h2>
      <p style="margin: 0 0 20px 0; color: #475569; font-size: 15px; line-height: 1.6;">
        The following invoice payment is due soon:
      </p>
      ${getInfoBox([
        { label: 'Invoice Number', value: data.invoiceNumber || 'N/A' },
        { label: 'Client', value: data.clientCompany || 'N/A' },
        { label: 'Project', value: data.projectName || 'N/A' },
        { label: 'Invoice Amount', value: formatCurrency(data.invoiceAmount) },
        { label: 'Due Date', value: formatDate(data.dueDate) },
        { label: 'Days Until Due', value: `${data.daysUntilDue || 0} days` },
        { label: 'Contact Person', value: data.contactPerson || 'N/A' }
      ])}
      ${getStatusBanner(`Payment is due in ${data.daysUntilDue || 0} days. Please follow up with the client if necessary.`, 'warning')}
      
      <div style="margin: 25px 0; padding: 20px; background-color: #f0f9ff; border-radius: 6px;">
        <h3 style="margin: 0 0 10px 0; color: #0369a1; font-size: 16px;">Recommended Actions:</h3>
        <ul style="margin: 10px 0; padding-left: 20px; color: #0c4a6e; font-size: 14px;">
          <li style="margin: 5px 0;">Send a courtesy reminder to the client</li>
          <li style="margin: 5px 0;">Verify the invoice was received</li>
          <li style="margin: 5px 0;">Check if there are any issues with the invoice</li>
          <li style="margin: 5px 0;">Update the payment status in the system</li>
        </ul>
      </div>
      
      ${getButton('View Invoice Details', `${DASHBOARD_URL}/invoices/${data.invoiceId}`)}
    `, 'Payment reminder - please take necessary action.')
  },

  'invoice.overdue': {
    subject: '🔴 OVERDUE Payment: {{invoiceNumber}} - {{clientCompany}}',
    html: (data) => getEmailWrapper(`
      <h2 style="margin: 0 0 15px 0; color: #dc2626; font-size: 22px;">
        🔴 OVERDUE Payment Alert
      </h2>
      ${getStatusBanner('This invoice is now OVERDUE. Immediate action required.', 'urgent')}
      ${getInfoBox([
        { label: 'Invoice Number', value: data.invoiceNumber || 'N/A' },
        { label: 'Client', value: data.clientCompany || 'N/A' },
        { label: 'Project', value: data.projectName || 'N/A' },
        { label: 'Invoice Amount', value: formatCurrency(data.invoiceAmount) },
        { label: 'Original Due Date', value: formatDate(data.dueDate) },
        { label: 'Days Overdue', value: `${data.daysOverdue || 0} days` },
        { label: 'Contact Person', value: data.contactPerson || 'N/A' },
        { label: 'Contact Email', value: data.contactEmail || 'N/A' },
        { label: 'Contact Phone', value: data.contactPhone || 'N/A' }
      ])}
      
      <div style="margin: 25px 0; padding: 20px; background-color: #fef2f2; border-radius: 6px; border: 1px solid #fecaca;">
        <h3 style="margin: 0 0 10px 0; color: #991b1b; font-size: 16px;">⚠️ Escalation Required:</h3>
        <ul style="margin: 10px 0; padding-left: 20px; color: #7f1d1d; font-size: 14px;">
          <li style="margin: 5px 0;">Contact client immediately via phone</li>
          <li style="margin: 5px 0;">Send formal overdue notice</li>
          <li style="margin: 5px 0;">Consider suspending ongoing work if necessary</li>
          <li style="margin: 5px 0;">Escalate to senior management</li>
          <li style="margin: 5px 0;">Review payment terms for future projects</li>
        </ul>
      </div>
      
      <p style="margin: 20px 0; color: #dc2626; font-size: 15px; font-weight: 600;">
        This requires immediate attention to maintain cash flow and client relationships.
      </p>
      
      ${getButton('View Invoice & Take Action', `${DASHBOARD_URL}/invoices/${data.invoiceId}`, '#dc2626')}
    `, 'URGENT: Overdue payment requires immediate action.')
  },

  // Keep existing templates
  'proposal.created': {
    subject: '📄 New Proposal Created: {{projectName}}',
    html: (data) => getEmailWrapper(`
      <h2 style="margin: 0 0 15px 0; color: #1e293b; font-size: 22px;">
        📄 New Proposal Created
      </h2>
      <p style="margin: 0 0 20px 0; color: #475569; font-size: 15px; line-height: 1.6;">
        A new proposal has been submitted and requires your attention.
      </p>
      ${getInfoBox([
        { label: 'Project Name', value: data.projectName || 'N/A' },
        { label: 'Client', value: data.clientName || 'N/A' },
        { label: 'Created By', value: data.createdBy || 'N/A' },
        { label: 'Date', value: formatDate(new Date()) }
      ])}
      ${getStatusBanner('Please review the proposal and proceed with estimation.', 'info')}
      ${getButton('View Proposal', DASHBOARD_URL)}
    `, 'Please take necessary action on this proposal.')
  },

  'project.submitted': {
    subject: '📋 Project Submitted for Review: {{projectName}}',
    html: (data) => getEmailWrapper(`
      <h2 style="margin: 0 0 15px 0; color: #1e293b; font-size: 22px;">
        📋 Project Submitted for Review
      </h2>
      <p style="margin: 0 0 20px 0; color: #475569; font-size: 15px; line-height: 1.6;">
        A project has been submitted and is awaiting approval.
      </p>
      ${getInfoBox([
        { label: 'Project Name', value: data.projectName || 'N/A' },
        { label: 'Client', value: data.clientName || 'N/A' },
        { label: 'Submitted By', value: data.createdBy || 'N/A' }
      ])}
      ${getButton('Review Project', DASHBOARD_URL)}
    `)
  },

  'project.approved_by_director': {
    subject: '✅ Project Approved: {{projectName}}',
    html: (data) => getEmailWrapper(`
      <h2 style="margin: 0 0 15px 0; color: #1e293b; font-size: 22px;">
        ✅ Project Approved by Director
      </h2>
      ${getStatusBanner('Congratulations! Your project has been approved.', 'success')}
      ${getInfoBox([
        { label: 'Project Name', value: data.projectName || 'N/A' },
        { label: 'Client', value: data.clientName || 'N/A' },
        { label: 'Approved By', value: 'Director' }
      ])}
      <p style="margin: 20px 0; color: #475569; font-size: 15px; line-height: 1.6;">
        The project is now ready to move to the next phase. Please proceed with the necessary arrangements.
      </p>
      ${getButton('View Project', DASHBOARD_URL)}
    `)
  },

  // =============== LEAVE REQUEST TEMPLATES ===============
  'leave.submitted': {
    subject: '🏖️ Leave Request: {{employeeName}} - {{totalDays}} Day(s)',
    html: (data) => getEmailWrapper(`
      <h2 style="margin: 0 0 15px 0; color: #1e293b; font-size: 22px;">
        🏖️ New Leave Request Submitted
      </h2>
      <p style="margin: 0 0 20px 0; color: #475569; font-size: 15px; line-height: 1.6;">
        An employee has submitted a leave request that requires your attention:
      </p>
      ${getInfoBox([
        { label: 'Employee', value: data.employeeName || 'N/A' },
        { label: 'Department', value: data.department || 'N/A' },
        { label: 'Leave Period', value: `${formatDate(data.fromDate)} to ${formatDate(data.toDate)}` },
        { label: 'Total Days', value: `${data.totalDays || 1} day(s)` },
        { label: 'Reason', value: data.reason || 'No reason provided' },
        { label: 'Emergency Contact', value: data.emergencyContact || 'Not provided' }
      ])}
      ${getStatusBanner('This leave request is pending approval.', 'warning')}
      ${getButton('Review Leave Requests', DASHBOARD_URL)}
    `, 'Please review and process this leave request.')
  },

  'leave.approved': {
    subject: '✅ Leave Approved: {{fromDate}} to {{toDate}}',
    html: (data) => getEmailWrapper(`
      <h2 style="margin: 0 0 15px 0; color: #1e293b; font-size: 22px;">
        ✅ Your Leave Request Has Been Approved
      </h2>
      ${getStatusBanner('Great news! Your leave request has been approved.', 'success')}
      ${getInfoBox([
        { label: 'Leave Period', value: `${formatDate(data.fromDate)} to ${formatDate(data.toDate)}` },
        { label: 'Total Days', value: `${data.totalDays || 1} day(s)` },
        { label: 'Leave Type', value: data.leaveType || 'As assigned by HR' },
        { label: 'Approved By', value: data.approvedBy || 'Management' }
      ])}
      <p style="margin: 20px 0; color: #475569; font-size: 15px; line-height: 1.6;">
        Please ensure proper handover of your responsibilities before your leave begins.
      </p>
      ${getButton('View Leave Status', DASHBOARD_URL)}
    `, 'Enjoy your time off!')
  },

  'leave.rejected': {
    subject: '❌ Leave Request Not Approved: {{fromDate}} to {{toDate}}',
    html: (data) => getEmailWrapper(`
      <h2 style="margin: 0 0 15px 0; color: #1e293b; font-size: 22px;">
        ❌ Leave Request Not Approved
      </h2>
      ${getStatusBanner('Unfortunately, your leave request could not be approved at this time.', 'error')}
      ${getInfoBox([
        { label: 'Leave Period', value: `${formatDate(data.fromDate)} to ${formatDate(data.toDate)}` },
        { label: 'Total Days', value: `${data.totalDays || 1} day(s)` },
        { label: 'Reviewed By', value: data.rejectedBy || 'Management' },
        { label: 'Reason', value: data.rejectionReason || 'No reason provided' }
      ])}
      <p style="margin: 20px 0; color: #475569; font-size: 15px; line-height: 1.6;">
        If you have questions, please contact HR or your supervisor for more details.
      </p>
      ${getButton('View Leave Status', DASHBOARD_URL)}
    `, 'Please contact HR if you have questions.')
  },

  'leave.stage_approved': {
    subject: '📋 Leave Stage Approved: {{employeeName}} - Pending HR Final Approval',
    html: (data) => getEmailWrapper(`
      <h2 style="margin: 0 0 15px 0; color: #1e293b; font-size: 22px;">
        📋 Leave Request Stage Approved
      </h2>
      <p style="margin: 0 0 20px 0; color: #475569; font-size: 15px; line-height: 1.6;">
        A leave request has passed Stage ${data.stage || '1'} approval and requires HR processing:
      </p>
      ${getInfoBox([
        { label: 'Employee', value: data.employeeName || 'N/A' },
        { label: 'Department', value: data.department || 'N/A' },
        { label: 'Leave Period', value: `${formatDate(data.fromDate)} to ${formatDate(data.toDate)}` },
        { label: 'Total Days', value: `${data.totalDays || 1} day(s)` },
        { label: 'Approved By', value: data.approvedBy || 'N/A' },
        { label: 'Current Stage', value: `Stage ${data.currentStage || '1'} of ${data.totalStages || '3'}` }
      ])}
      ${getStatusBanner('Please assign leave type and complete final processing.', 'info')}
      ${getButton('Process Leave Request', DASHBOARD_URL)}
    `, 'HR action required for final approval.')
  }
};

// ==========================================
// HELPER FUNCTIONS
// ==========================================
async function getEmailsForRoles(roles) {
  if (!roles || roles.length === 0) return [];
  try {
    const normalizedRoles = roles.map(r => r.toLowerCase().trim());
    console.log(`🔍 Looking up roles: ${normalizedRoles.join(', ')}`);
    const snapshot = await db.collection('users').where('role', 'in', normalizedRoles).get();
    return snapshot.docs.map(doc => doc.data().email).filter(e => e && e.includes('@'));
  } catch (error) {
    console.error('❌ Error fetching role emails:', error.message);
    return [];
  }
}

async function getBDMEmail(projectId, proposalId) {
  try {
    let uid = null;
    if (proposalId) {
       const doc = await db.collection('proposals').doc(proposalId).get();
       if (doc.exists) uid = doc.data().createdByUid;
    }
    if (!uid && projectId) {
       const doc = await db.collection('projects').doc(projectId).get();
       if (doc.exists) uid = doc.data().bdmUid || doc.data().createdBy;
    }
    if (uid) {
       const userDoc = await db.collection('users').doc(uid).get();
       if (userDoc.exists) return userDoc.data().email;
    }
  } catch (e) {
    console.error("⚠️ Error fetching BDM email:", e.message);
  }
  return null;
}

async function getDesignManagerEmail(projectId) {
  try {
    if (projectId) {
      const doc = await db.collection('projects').doc(projectId).get();
      if (doc.exists && doc.data().designManagerUid) {
        const userDoc = await db.collection('users').doc(doc.data().designManagerUid).get();
        if (userDoc.exists) return userDoc.data().email;
      }
    }
  } catch (e) {
    console.error("⚠️ Error fetching Design Manager email:", e.message);
  }
  return null;
}

// Get specific designer email by UID (for time requests)
async function getDesignerEmailByUid(designerUid) {
  try {
    if (designerUid) {
      const userDoc = await db.collection('users').doc(designerUid).get();
      if (userDoc.exists) return userDoc.data().email;
    }
  } catch (e) {
    console.error("⚠️ Error fetching Designer email by UID:", e.message);
  }
  return null;
}

function interpolate(template, data) {
  let result = template || '';
  for (const key in data) {
    result = result.replace(new RegExp(`{{${key}}}`, 'g'), data[key] || 'N/A');
  }
  return result;
}

// ==========================================
// MAIN SEND FUNCTION (EXPORTED)
// ==========================================
async function sendEmailNotification(event, data) {
  console.log(`\n📨 --- START EMAIL: [${event}] ---`);

  if (!process.env.RESEND_API_KEY) {
      console.error('⛔ CRITICAL: RESEND_API_KEY is missing!');
      return { success: false, error: 'Missing API Key' };
  }
  const resend = new Resend(process.env.RESEND_API_KEY);

  // 1. Get Recipients
  const roles = EMAIL_RECIPIENT_MAP[event] || [];
  let recipients = await getEmailsForRoles(roles);

  // 2. Dynamic Additions based on event type
  
  // Add BDM for relevant events
  if (['proposal.created', 'project.submitted', 'project.approved_by_director', 
       'variation.approved', 'variation.approved_detail', 'invoice.saved', 
       'invoice.created', 'invoice.payment_due', 'invoice.overdue'].includes(event)) {
      let bdmEmail = data.createdByEmail || data.bdmEmail;
      if (!bdmEmail) bdmEmail = await getBDMEmail(data.projectId, data.proposalId);
      
      if (bdmEmail) {
          recipients.push(bdmEmail);
          console.log(`👤 Added BDM: ${bdmEmail}`);
      }
  }
  
  // Add Design Manager for relevant events
  if (['project.allocated', 'time_request.created', 'time_request.approved', 
       'time_request.rejected'].includes(event)) {
      let designManagerEmail = data.designManagerEmail;
      if (!designManagerEmail) designManagerEmail = await getDesignManagerEmail(data.projectId);
      
      if (designManagerEmail) {
          recipients.push(designManagerEmail);
          console.log(`👔 Added Design Manager: ${designManagerEmail}`);
      }
  }
  
  // Add Designer for relevant events (ONLY the specific requesting designer, not all designers)
  if (['designer.allocated', 'time_request.approved', 'time_request.rejected'].includes(event)) {
      let designerEmail = data.designerEmail;
      
      // If no email provided, try to fetch by designerUid or requestedByUid
      if (!designerEmail && (data.designerUid || data.requestedByUid)) {
          designerEmail = await getDesignerEmailByUid(data.designerUid || data.requestedByUid);
      }
      
      if (designerEmail) {
          recipients.push(designerEmail);
          console.log(`🎨 Added Specific Designer: ${designerEmail}`);
      } else {
          console.warn(`⚠️ No designer email found for event: ${event}`);
      }
  }

  // Add Employee for leave request approval/rejection notifications
  if (['leave.approved', 'leave.rejected'].includes(event)) {
      let employeeEmail = data.employeeEmail || data.submittedBy;
      
      if (employeeEmail) {
          recipients.push(employeeEmail);
          console.log(`👤 Added Employee for leave notification: ${employeeEmail}`);
      } else {
          console.warn(`⚠️ No employee email found for leave event: ${event}`);
      }
  }
  
  // Add Team Lead for leave request if selected
  if (event === 'leave.submitted' && data.selectedTeamLead) {
      recipients.push(data.selectedTeamLead);
      console.log(`👔 Added Team Lead for leave approval: ${data.selectedTeamLead}`);
  }

  // 3. Clean List
  recipients = [...new Set(recipients.filter(e => e && e.includes('@')))];

  if (recipients.length === 0) {
      console.warn(`⚠️ No valid recipients for '${event}'. Skipping.`);
      console.log('📨 --- END EMAIL (SKIPPED) ---\n');
      return { success: false, message: 'No recipients found' };
  }

  // 4. Build Email
  try {
    const tmpl = EMAIL_TEMPLATE_MAP[event] || EMAIL_TEMPLATE_MAP['default'];
    
    // Generate HTML (templates are now functions)
    const html = typeof tmpl.html === 'function' ? tmpl.html(data) : interpolate(tmpl.html, data);
    const subject = interpolate(tmpl.subject, data);

    console.log(`🚀 Sending from [${FROM_EMAIL}] to [${recipients.length}] recipients (individually for privacy)...`);
    console.log(`📧 Recipients: ${recipients.join(', ')}`);
    
    // 5. Send via Resend - INDIVIDUAL EMAILS FOR PRIVACY
    // Each recipient only sees their own email address
    let successCount = 0;
    let failedRecipients = [];
    let lastMessageId = null;
    
    for (const recipient of recipients) {
        try {
            const result = await resend.emails.send({
                from: FROM_EMAIL,
                to: [recipient],  // Single recipient - they only see their own email
                subject: subject,
                html: html
            });
            
            if (result.error) {
                console.warn(`⚠️ Failed to send to ${recipient}: ${result.error.message}`);
                failedRecipients.push(recipient);
            } else {
                successCount++;
                lastMessageId = result.data?.id;
                console.log(`  ✅ Sent to: ${recipient}`);
            }
        } catch (sendError) {
            console.warn(`⚠️ Failed to send to ${recipient}: ${sendError.message}`);
            failedRecipients.push(recipient);
        }
    }

    if (successCount === 0) {
        throw new Error('Failed to send to any recipient');
    }

    console.log(`✅ SENT! ${successCount}/${recipients.length} emails delivered`);
    if (failedRecipients.length > 0) {
        console.warn(`⚠️ Failed recipients: ${failedRecipients.join(', ')}`);
    }
    console.log('📨 --- END EMAIL (SUCCESS) ---\n');
    return { 
      success: true, 
      id: lastMessageId, 
      recipients: successCount,
      totalRecipients: recipients.length,
      failedRecipients: failedRecipients
    };

  } catch (error) {
    console.error('❌ RESEND FAILED:', error.message);
    console.log('📨 --- END EMAIL (FAILED) ---\n');
    return { success: false, error: error.message };
  }
}

// ==========================================
// API ENDPOINT
// ==========================================
emailRouter.post('/trigger', async (req, res) => {
  try {
    const { event, data } = req.body;
    
    if (!event) {
      return res.status(400).json({ error: 'Event type is required' });
    }
    
    const result = await sendEmailNotification(event, data || {});
    res.json(result);
  } catch (e) {
    console.error('API Error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Health check endpoint
emailRouter.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'email-notifications',
    from: FROM_EMAIL,
    hasApiKey: !!process.env.RESEND_API_KEY
  });
});

module.exports = { emailHandler: emailRouter, sendEmailNotification };
