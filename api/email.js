


// api/email.js - Enhanced Email Notification API with Timesheet & Invoice Notifications + Design File Workflow + Document Controller
const express = require('express');
const { Resend } = require('resend');
const admin = require('./_firebase-admin');

const emailRouter = express.Router();
const db = admin.firestore();

// ==========================================
// CONFIGURATION
// ==========================================
const FROM_EMAIL = 'EB-Tracker <sabin@edanbrook.com>'; 
const HR_FROM_EMAIL = 'EDANBROOK HR <paul.a@edanbrook.com>'; // HR screening emails
const DESIGN_FROM_EMAIL = 'EDANBROOK Design <design@edanbrook.com>'; // Design file emails (used by Document Controller)
const DC_FROM_EMAIL = 'EDANBROOK Document Controller <dc@edanbrook.com>'; // Document Controller emails
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
  'leave.stage_approved': ['hr'], // Stage approval → HR notified for final processing
  
  // HR Screening / Interview notification types
  'screening.interview_invitation': [], // Dynamic only - sent directly to candidate email
  'screening.candidate_submitted': ['hr', 'coo'], // Candidate submitted assessment → HR, COO notified
  'screening.rejected': [], // Dynamic only - sent to candidate
  
  // Design File Workflow notification types
  'design.submitted_for_approval': ['coo', 'director'], // Designer submits → COO/Director
  'design.approved': ['document_controller'],            // COO approves → DC notified + designer (dynamic)
  'design.rejected': [],                                // Dynamic - designer email
  'design.sent_to_client': []                           // Dynamic - client email
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
        { label: 'Days Overdue', value: `${data.daysOverdue || 0} days` }
      ])}
      <p style="margin: 20px 0; color: #dc2626; font-size: 15px; font-weight: 600;">
        This requires immediate attention to maintain cash flow and client relationships.
      </p>
      ${getButton('View Invoice & Take Action', `${DASHBOARD_URL}/invoices/${data.invoiceId}`, '#dc2626')}
    `, 'URGENT: Overdue payment requires immediate action.')
  },

  // =============== PROPOSAL/PROJECT TEMPLATES ===============
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
        The project is now ready to move to the next phase.
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
        { label: 'Reason', value: data.reason || 'No reason provided' }
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
        { label: 'Approved By', value: data.approvedBy || 'Management' }
      ])}
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
        { label: 'Reviewed By', value: data.rejectedBy || 'Management' },
        { label: 'Reason', value: data.rejectionReason || 'No reason provided' }
      ])}
      ${getButton('View Leave Status', DASHBOARD_URL)}
    `, 'Please contact HR if you have questions.')
  },

  'leave.stage_approved': {
    subject: '📋 Leave Stage Approved: {{employeeName}} - Pending HR Final Approval',
    html: (data) => getEmailWrapper(`
      <h2 style="margin: 0 0 15px 0; color: #1e293b; font-size: 22px;">
        📋 Leave Request Stage Approved
      </h2>
      ${getInfoBox([
        { label: 'Employee', value: data.employeeName || 'N/A' },
        { label: 'Leave Period', value: `${formatDate(data.fromDate)} to ${formatDate(data.toDate)}` },
        { label: 'Total Days', value: `${data.totalDays || 1} day(s)` },
        { label: 'Approved By', value: data.approvedBy || 'N/A' }
      ])}
      ${getStatusBanner('Please assign leave type and complete final processing.', 'info')}
      ${getButton('Process Leave Request', DASHBOARD_URL)}
    `, 'HR action required for final approval.')
  },

  // =============== HR SCREENING TEMPLATES ===============
  'screening.interview_invitation': {
    subject: '🎉 Interview Invitation - {{position}} at EDANBROOK',
    html: (data) => {
      const formattedDate = data.interviewDateTime ? 
        new Date(data.interviewDateTime).toLocaleString('en-IN', {
          weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
          hour: '2-digit', minute: '2-digit', hour12: true
        }) : 'To be confirmed';
      
      return getEmailWrapper(`
        <h2 style="margin: 0 0 15px 0; color: #1e293b; font-size: 22px;">
          🎉 Interview Invitation
        </h2>
        ${getStatusBanner(`Congratulations! You have been shortlisted for the <strong>${data.position || 'N/A'}</strong> position at EDANBROOK.`, 'success')}
        <p style="margin: 20px 0; color: #475569; font-size: 15px; line-height: 1.6;">
          Dear <strong>${data.candidateName || 'Candidate'}</strong>,
        </p>
        ${getInfoBox([
          { label: 'Position', value: data.position || 'N/A' },
          { label: 'Date & Time', value: formattedDate },
          { label: 'Interview Mode', value: data.meetingLink ? 'Online (Video Call)' : 'To be confirmed' }
        ])}
        ${data.meetingLink ? getButton('🎥 Join Interview Meeting', data.meetingLink, '#10b981') : ''}
        <p style="margin: 25px 0 0 0; color: #1e293b; font-size: 15px;">
          Best regards,<br><strong>EDANBROOK HR Team</strong>
        </p>
      `, 'Good luck with your interview!')
    }
  },

  'screening.candidate_submitted': {
    subject: '📝 New Candidate Assessment: {{candidateName}} - {{position}}',
    html: (data) => getEmailWrapper(`
      <h2 style="margin: 0 0 15px 0; color: #1e293b; font-size: 22px;">
        📝 New Candidate Assessment Received
      </h2>
      ${getInfoBox([
        { label: 'Candidate Name', value: data.candidateName || 'N/A' },
        { label: 'Email', value: data.candidateEmail || 'N/A' },
        { label: 'Position Applied', value: data.position || 'N/A' },
        { label: 'Overall Score', value: data.score ? `${data.score}%` : 'N/A' }
      ])}
      ${data.score >= 80 ? getStatusBanner('⭐ High-scoring candidate!', 'success') : getStatusBanner('Review assessment details.', 'info')}
      ${getButton('Review Candidate', DASHBOARD_URL)}
    `, 'Please review this candidate assessment.')
  },

  'screening.rejected': {
    subject: 'Application Update - {{position}} at EDANBROOK',
    html: (data) => getEmailWrapper(`
      <h2 style="margin: 0 0 15px 0; color: #1e293b; font-size: 22px;">
        Application Status Update
      </h2>
      <p style="margin: 20px 0; color: #475569; font-size: 15px; line-height: 1.6;">
        Dear <strong>${data.candidateName || 'Candidate'}</strong>,
      </p>
      <p style="margin: 0 0 20px 0; color: #475569; font-size: 15px; line-height: 1.6;">
        Thank you for your interest in the <strong>${data.position || 'N/A'}</strong> position at EDANBROOK.
        After careful consideration, we have decided to move forward with other candidates.
      </p>
      <p style="margin: 25px 0 0 0; color: #1e293b; font-size: 15px;">
        Best regards,<br><strong>EDANBROOK HR Team</strong>
      </p>
    `, 'Thank you for your interest in EDANBROOK.')
  },

  // =============== DESIGN FILE WORKFLOW TEMPLATES ===============
  'design.submitted_for_approval': {
    subject: '📐 Design File Pending Approval: {{projectName}}',
    html: (data) => getEmailWrapper(`
      <h2 style="margin: 0 0 15px 0; color: #1e293b; font-size: 22px;">
        📐 Design File Submitted for Approval
      </h2>
      <p style="margin: 0 0 20px 0; color: #475569; font-size: 15px; line-height: 1.6;">
        A design file has been submitted and requires your approval before it can be sent to the client.
      </p>
      ${getInfoBox([
        { label: 'Project', value: `${data.projectName} (${data.projectCode || 'N/A'})` },
        { label: 'Client', value: data.clientCompany || 'N/A' },
        { label: 'File Name', value: data.fileName || 'N/A' },
        { label: 'Submitted By', value: data.submittedBy || 'Designer' },
        { label: 'Client Email', value: data.clientEmail || 'N/A' },
        { label: 'Submitted', value: formatDate(new Date()) }
      ])}
      ${getStatusBanner('This design file requires your approval before it can be sent to the client.', 'warning')}
      ${getButton('Review & Approve', `${DASHBOARD_URL}#design-approvals`)}
    `, 'Please review and approve/reject this design file.')
  },

  'design.approved': {
    subject: '✅ Design File Approved: {{projectName}}',
    html: (data) => getEmailWrapper(`
      <h2 style="margin: 0 0 15px 0; color: #1e293b; font-size: 22px;">
        ✅ Design File Approved
      </h2>
      ${getStatusBanner('Great news! Your design file has been approved and will be sent to the client by Document Controller.', 'success')}
      ${getInfoBox([
        { label: 'Project', value: data.projectName || 'N/A' },
        { label: 'File Name', value: data.fileName || 'N/A' },
        { label: 'Approved By', value: data.approvedBy || 'COO' },
        { label: 'Approval Date', value: formatDate(new Date()) },
        { label: 'Notes', value: data.approvalNotes || 'No additional notes' }
      ])}
      <p style="margin: 20px 0; color: #475569; font-size: 15px; line-height: 1.6;">
        The Document Controller will review and send this file to the client shortly. You will be notified when the file has been delivered.
      </p>
      ${getButton('View My Design Files', `${DASHBOARD_URL}#designer-allocations`)}
    `)
  },

  'design.rejected': {
    subject: '❌ Design File Needs Revision: {{projectName}}',
    html: (data) => getEmailWrapper(`
      <h2 style="margin: 0 0 15px 0; color: #1e293b; font-size: 22px;">
        ❌ Design File Not Approved
      </h2>
      ${getStatusBanner('Your design file requires revisions before it can be sent to the client.', 'error')}
      ${getInfoBox([
        { label: 'Project', value: data.projectName || 'N/A' },
        { label: 'File Name', value: data.fileName || 'N/A' },
        { label: 'Reviewed By', value: data.rejectedBy || 'COO' },
        { label: 'Review Date', value: formatDate(new Date()) }
      ])}
      <div style="margin: 25px 0; padding: 20px; background-color: #fef2f2; border-radius: 6px; border-left: 4px solid #ef4444;">
        <h3 style="margin: 0 0 10px 0; color: #991b1b; font-size: 16px;">Reason for Rejection:</h3>
        <p style="margin: 0; color: #7f1d1d; font-size: 15px; line-height: 1.6;">
          ${data.rejectionReason || 'No specific reason provided. Please contact your supervisor.'}
        </p>
      </div>
      <p style="margin: 20px 0; color: #475569; font-size: 15px; line-height: 1.6;">
        Please make the necessary revisions and re-upload the design file for approval.
      </p>
      ${getButton('Upload Revised Design', `${DASHBOARD_URL}#designer-allocations`)}
    `)
  },

  'design.sent_to_client': {
    subject: '📐 Design Drawings Ready: {{projectName}}',
    html: (data) => `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Design Drawings - ${data.projectName || 'Project'}</title>
</head>
<body style="margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f8fafc;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: #f8fafc;">
    <tr>
      <td style="padding: 40px 20px;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="650" style="margin: 0 auto; background-color: #ffffff; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.08);">
          
          <!-- Professional Header -->
          <tr>
            <td style="padding: 0;">
              <div style="background: linear-gradient(135deg, #1e3a5f 0%, #2d5a87 50%, #3d7ab5 100%); padding: 40px 35px; border-radius: 12px 12px 0 0;">
                <table width="100%" cellspacing="0" cellpadding="0">
                  <tr>
                    <td>
                      <h1 style="margin: 0 0 8px 0; color: #ffffff; font-size: 28px; font-weight: 700; letter-spacing: 0.5px;">
                        EDANBROOK
                      </h1>
                      <p style="margin: 0; color: #a8c5e2; font-size: 14px; font-weight: 500; letter-spacing: 1px;">
                        STEEL DETAILING EXCELLENCE
                      </p>
                    </td>
                    <td style="text-align: right;">
                      <div style="background: rgba(255,255,255,0.15); padding: 12px 20px; border-radius: 8px; display: inline-block;">
                        <span style="color: #ffffff; font-size: 13px; font-weight: 600;">PROJECT DELIVERY</span>
                      </div>
                    </td>
                  </tr>
                </table>
              </div>
            </td>
          </tr>
          
          <!-- Content -->
          <tr>
            <td style="padding: 45px 40px;">
              
              <!-- Greeting -->
              <p style="margin: 0 0 25px 0; color: #1e293b; font-size: 16px; line-height: 1.7;">
                Dear ${data.clientName || 'Valued Client'},
              </p>
              
              <p style="margin: 0 0 30px 0; color: #475569; font-size: 15px; line-height: 1.8;">
                We are pleased to deliver the design drawings for your project. Our team has completed the detailing work and the files are now ready for your review.
              </p>
              
              <!-- Project Details Box -->
              <div style="background: linear-gradient(135deg, #f0f7ff 0%, #e8f4fd 100%); border-radius: 12px; padding: 25px 30px; margin: 30px 0; border-left: 5px solid #2d5a87;">
                <h3 style="margin: 0 0 18px 0; color: #1e3a5f; font-size: 17px; font-weight: 700;">
                  📋 Project Details
                </h3>
                <table cellspacing="0" cellpadding="0" style="width: 100%;">
                  <tr>
                    <td style="padding: 8px 0; color: #64748b; font-size: 14px; width: 140px; vertical-align: top;">Project Name:</td>
                    <td style="padding: 8px 0; color: #1e293b; font-size: 14px; font-weight: 600;">${data.projectName || 'N/A'}</td>
                  </tr>
                  ${data.projectCode ? `
                  <tr>
                    <td style="padding: 8px 0; color: #64748b; font-size: 14px; vertical-align: top;">Project Code:</td>
                    <td style="padding: 8px 0; color: #1e293b; font-size: 14px; font-weight: 600;">${data.projectCode}</td>
                  </tr>
                  ` : ''}
                  <tr>
                    <td style="padding: 8px 0; color: #64748b; font-size: 14px; vertical-align: top;">Client:</td>
                    <td style="padding: 8px 0; color: #1e293b; font-size: 14px; font-weight: 600;">${data.clientCompany || 'N/A'}</td>
                  </tr>
                  <tr>
                    <td style="padding: 8px 0; color: #64748b; font-size: 14px; vertical-align: top;">File Name:</td>
                    <td style="padding: 8px 0; color: #1e293b; font-size: 14px; font-weight: 600;">${data.fileName || 'Design Package'}</td>
                  </tr>
                  <tr>
                    <td style="padding: 8px 0; color: #64748b; font-size: 14px; vertical-align: top;">Delivery Date:</td>
                    <td style="padding: 8px 0; color: #1e293b; font-size: 14px; font-weight: 600;">${formatDate(new Date())}</td>
                  </tr>
                </table>
              </div>
              
              ${data.customMessage ? `
              <!-- Custom Message -->
              <div style="background: #fffbeb; border-radius: 10px; padding: 20px 25px; margin: 25px 0; border: 1px solid #fcd34d;">
                <p style="margin: 0; color: #78350f; font-size: 14px; line-height: 1.7;">
                  <strong>Message from our team:</strong><br>
                  ${data.customMessage}
                </p>
              </div>
              ` : ''}
              
              <!-- Download Button -->
              <div style="text-align: center; margin: 40px 0;">
                <a href="${data.fileUrl}" 
                   target="_blank" 
                   style="display: inline-block; background: linear-gradient(135deg, #1e3a5f 0%, #2d5a87 100%); color: #ffffff; text-decoration: none; padding: 18px 45px; border-radius: 10px; font-size: 16px; font-weight: 700; letter-spacing: 0.5px; box-shadow: 0 4px 15px rgba(30, 58, 95, 0.3);">
                  ${data.isExternalLink ? '🔗 Access Design Files' : '📥 Download Design Files'}
                </a>
              </div>
              
              ${data.isExternalLink ? `
              <p style="margin: 0 0 20px 0; color: #64748b; font-size: 13px; text-align: center; line-height: 1.6;">
                <em>Note: This link will open in a new browser tab where you can view or download the files.</em>
              </p>
              ` : ''}
              
              <p style="margin: 30px 0 0 0; color: #64748b; font-size: 13px; text-align: center; line-height: 1.6;">
                If the download button doesn't work, please copy and paste this link into your browser:<br>
                <a href="${data.fileUrl}" style="color: #2d5a87; word-break: break-all;">${data.fileUrl}</a>
              </p>
              
              <!-- Next Steps -->
              <div style="margin: 40px 0 30px 0; padding: 25px; background: #f8fafc; border-radius: 10px;">
                <h4 style="margin: 0 0 15px 0; color: #1e293b; font-size: 15px; font-weight: 700;">📌 Next Steps</h4>
                <ul style="margin: 0; padding: 0 0 0 20px; color: #475569; font-size: 14px; line-height: 2;">
                  <li>Review the design drawings thoroughly</li>
                  <li>Check for any discrepancies or required modifications</li>
                  <li>Provide your feedback or approval within 48 hours</li>
                  <li>Contact us immediately if you have any questions</li>
                </ul>
              </div>
              
              <!-- Closing -->
              <p style="margin: 25px 0 5px 0; color: #475569; font-size: 15px; line-height: 1.7;">
                If you have any questions or require any modifications, please don't hesitate to reach out to us.
              </p>
              
              <p style="margin: 25px 0 0 0; color: #1e293b; font-size: 15px;">
                Best regards,<br>
                <strong style="color: #1e3a5f;">${data.senderName || 'The Edanbrook Team'}</strong><br>
                <span style="color: #64748b; font-size: 13px;">Edanbrook Steel Detailing</span>
              </p>
              
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="padding: 30px 40px; background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%); border-radius: 0 0 12px 12px;">
              <table width="100%" cellspacing="0" cellpadding="0">
                <tr>
                  <td>
                    <p style="margin: 0 0 5px 0; color: #1e3a5f; font-size: 15px; font-weight: 700;">Edanbrook</p>
                    <p style="margin: 0; color: #64748b; font-size: 12px; line-height: 1.6;">
                      Professional Steel Detailing Services<br>
                      Quality • Precision • Excellence
                    </p>
                  </td>
                  <td style="text-align: right; vertical-align: top;">
                    <p style="margin: 0; color: #64748b; font-size: 12px; line-height: 1.8;">
                      📧 info@edanbrook.com<br>
                      🌐 www.edanbrook.com
                    </p>
                  </td>
                </tr>
              </table>
              <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 20px 0;">
              <p style="margin: 0; color: #94a3b8; font-size: 11px; text-align: center; line-height: 1.6;">
                This email contains confidential project information. Please do not forward without authorization.<br>
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
    `
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

// Document Controller emails - hardcoded since they are specific roles
function getDCEmails() {
  return ['iva@edanbrook.com', 'dc@edanbrook.com'];
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

  // Add Candidate for HR screening interview invitations and rejections
  if (['screening.interview_invitation', 'screening.rejected'].includes(event)) {
      let candidateEmail = data.candidateEmail;
      
      if (candidateEmail) {
          recipients.push(candidateEmail);
          console.log(`📋 Added Candidate for screening notification: ${candidateEmail}`);
      } else {
          console.warn(`⚠️ No candidate email found for screening event: ${event}`);
      }
  }

  // =============== DESIGN FILE WORKFLOW RECIPIENTS ===============
  // Add Designer for design approval/rejection
  if (['design.approved', 'design.rejected'].includes(event)) {
      let designerEmail = data.designerEmail;
      if (designerEmail) {
          recipients.push(designerEmail);
          console.log(`🎨 Added Designer for design notification: ${designerEmail}`);
      }
  }

  // Add Document Controllers for design approval (so they can send to client)
  if (event === 'design.approved') {
      const dcEmails = getDCEmails();
      recipients.push(...dcEmails);
      console.log(`📄 Added Document Controllers for approved design: ${dcEmails.join(', ')}`);
  }

  // Add Client and CC recipients for design sent to client
  if (event === 'design.sent_to_client') {
      let clientEmail = data.clientEmail;
      if (clientEmail) {
          recipients.push(clientEmail);
          console.log(`👤 Added Client for design delivery: ${clientEmail}`);
      }
      
      // Add CC recipients
      if (data.ccEmails && Array.isArray(data.ccEmails) && data.ccEmails.length > 0) {
          const validCCEmails = data.ccEmails.filter(e => e && e.includes('@'));
          recipients.push(...validCCEmails);
          console.log(`📋 Added ${validCCEmails.length} CC recipients: ${validCCEmails.join(', ')}`);
      }
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

    // Use appropriate FROM email based on event type
    const isHREvent = event.startsWith('screening.');
    const isDesignClientEvent = event === 'design.sent_to_client';
    let fromEmail = FROM_EMAIL;
    if (isHREvent) fromEmail = HR_FROM_EMAIL;
    if (isDesignClientEvent) fromEmail = DESIGN_FROM_EMAIL;

    console.log(`🚀 Sending from [${fromEmail}] to [${recipients.length}] recipients...`);
    console.log(`📧 Recipients: ${recipients.join(', ')}`);
    
    // 5. Send via Resend - INDIVIDUAL EMAILS FOR PRIVACY
    let successCount = 0;
    let failedRecipients = [];
    let lastMessageId = null;
    
    for (const recipient of recipients) {
        try {
            const result = await resend.emails.send({
                from: fromEmail,
                to: [recipient],
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
