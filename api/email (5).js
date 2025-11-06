// api/email.js - Email notification API
const express = require('express');
const { Resend } = require('resend');
const admin = require('./_firebase-admin');

// Note: No 'router' here, we export the router and the function at the end
const emailRouter = express.Router();
const resend = new Resend(process.env.RESEND_API_KEY);
const db = admin.firestore();

// --- 1. Event to Role Map (Who to email) ---
const EMAIL_RECIPIENT_MAP = {
  'proposal.created': ['estimator', 'Estimator', 'COO', 'director', 'Director'], // + BDM who created it
  'project.submitted': ['estimator', 'Estimator', 'COO', 'director', 'Director'], // + BDM who submitted it (alias for proposal.created)
  'project.approved_by_director': ['bdm', 'BDM'], // BDM who created the project
  'proposal.uploaded': ['estimator', 'Estimator'],
  'estimation.complete': ['COO'],
  'pricing.allocated': ['director', 'Director'],
  'project.won': ['COO', 'director', 'Director'],
  'project.allocated': ['Design Manager', 'designManager'],
  'designer.allocated': [], // Designer email handled separately
  'variation.allocated': ['bdm', 'BDM', 'COO', 'director', 'Director'], // + project BDM
  'variation.approved': ['bdm', 'BDM', 'COO', 'director', 'Director'], // + project BDM
  'invoice.saved': ['bdm', 'BDM', 'COO', 'director', 'Director'] // + project BDM
};

// --- 2. Professional Email Templates ---
const EMAIL_TEMPLATE_MAP = {
  'proposal.created': {
    subject: '🎯 New Proposal Created: {{projectName}}',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f4f4f4; }
          .container { max-width: 600px; margin: 20px auto; background: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
          .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px 20px; text-align: center; }
          .header h1 { margin: 0; font-size: 24px; font-weight: 600; }
          .content { padding: 30px 20px; }
          .content h2 { color: #667eea; font-size: 20px; margin-top: 0; }
          .info-box { background: #f8f9fa; border-left: 4px solid #667eea; padding: 15px; margin: 20px 0; border-radius: 4px; }
          .info-box p { margin: 8px 0; }
          .info-box strong { color: #333; }
          .cta-button { display: inline-block; background: #667eea; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; margin: 20px 0; font-weight: 600; }
          .cta-button:hover { background: #5568d3; }
          .footer { background: #f8f9fa; padding: 20px; text-align: center; font-size: 12px; color: #666; }
          .footer p { margin: 5px 0; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🎯 New Proposal Created</h1>
          </div>
          <div class="content">
            <h2>Proposal Submission Notification</h2>
            <p>Dear Team,</p>
            <p>A new proposal has been successfully created and requires your attention.</p>
            
            <div class="info-box">
              <p><strong>Project Name:</strong> {{projectName}}</p>
              <p><strong>Created By:</strong> {{createdBy}}</p>
              <p><strong>Date:</strong> {{date}}</p>
              {{#if description}}<p><strong>Description:</strong> {{description}}</p>{{/if}}
            </div>
            
            <p><strong>Next Steps:</strong></p>
            <ul>
              <li><strong>Estimator:</strong> Please review and prepare estimation</li>
              <li><strong>COO:</strong> Monitor proposal progress</li>
              <li><strong>Director:</strong> Await estimation for review</li>
            </ul>
            
            <center>
              <a href="{{dashboardUrl}}" class="cta-button">View Proposal Details</a>
            </center>
          </div>
          <div class="footer">
            <p><strong>EB-Tracker</strong> | Project Management System</p>
            <p>This is an automated notification. Please do not reply to this email.</p>
          </div>
        </div>
      </body>
      </html>
    `
  },

  'project.submitted': {
    subject: '🎯 New Project Submitted: {{projectName}}',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f4f4f4; }
          .container { max-width: 600px; margin: 20px auto; background: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
          .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px 20px; text-align: center; }
          .header h1 { margin: 0; font-size: 24px; font-weight: 600; }
          .content { padding: 30px 20px; }
          .content h2 { color: #667eea; font-size: 20px; margin-top: 0; }
          .info-box { background: #f8f9fa; border-left: 4px solid #667eea; padding: 15px; margin: 20px 0; border-radius: 4px; }
          .info-box p { margin: 8px 0; }
          .info-box strong { color: #333; }
          .cta-button { display: inline-block; background: #667eea; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; margin: 20px 0; font-weight: 600; }
          .cta-button:hover { background: #5568d3; }
          .footer { background: #f8f9fa; padding: 20px; text-align: center; font-size: 12px; color: #666; }
          .footer p { margin: 5px 0; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🎯 New Project Submitted</h1>
          </div>
          <div class="content">
            <h2>Project Submission Notification</h2>
            <p>Dear Team,</p>
            <p>A new project has been successfully submitted and requires your attention.</p>
            
            <div class="info-box">
              <p><strong>Project Name:</strong> {{projectName}}</p>
              <p><strong>Submitted By:</strong> {{createdBy}}</p>
              <p><strong>Date:</strong> {{date}}</p>
              {{#if description}}<p><strong>Description:</strong> {{description}}</p>{{/if}}
              {{#if clientName}}<p><strong>Client:</strong> {{clientName}}</p>{{/if}}
            </div>
            
            <p><strong>Next Steps:</strong></p>
            <ul>
              <li><strong>Estimator:</strong> Please review and prepare estimation</li>
              <li><strong>COO:</strong> Monitor project progress</li>
              <li><strong>Director:</strong> Await estimation for review</li>
            </ul>
            
            <center>
              <a href="{{dashboardUrl}}" class="cta-button">View Project Details</a>
            </center>
          </div>
          <div class="footer">
            <p><strong>EB-Tracker</strong> | Project Management System</p>
            <p>This is an automated notification. Please do not reply to this email.</p>
          </div>
        </div>
      </body>
      </html>
    `
  },

  'project.approved_by_director': {
    subject: '✅ Project Approved: {{projectName}}',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <style>
          body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f4f4f4; }
          .container { max-width: 600px; margin: 20px auto; background: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
          .header { background: linear-gradient(135deg, #11998e 0%, #38ef7d 100%); color: white; padding: 30px 20px; text-align: center; }
          .header h1 { margin: 0; font-size: 24px; font-weight: 600; }
          .content { padding: 30px 20px; }
          .content h2 { color: #11998e; font-size: 20px; margin-top: 0; }
          .success-badge { background: #d4edda; color: #155724; padding: 10px 20px; border-radius: 25px; display: inline-block; font-weight: 600; margin: 15px 0; }
          .info-box { background: #f8f9fa; border-left: 4px solid #38ef7d; padding: 15px; margin: 20px 0; border-radius: 4px; }
          .info-box p { margin: 8px 0; }
          .cta-button { display: inline-block; background: #11998e; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; margin: 20px 0; font-weight: 600; }
          .footer { background: #f8f9fa; padding: 20px; text-align: center; font-size: 12px; color: #666; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>✅ Project Approved</h1>
          </div>
          <div class="content">
            <h2>Congratulations!</h2>
            <center><span class="success-badge">APPROVED</span></center>
            
            <p>Dear Business Development Manager,</p>
            <p>Great news! Your project has been approved by the Director and is ready to move forward.</p>
            
            <div class="info-box">
              <p><strong>Project Name:</strong> {{projectName}}</p>
              <p><strong>Approved By:</strong> {{approvedBy}}</p>
              <p><strong>Approval Date:</strong> {{date}}</p>
              {{#if estimatedValue}}<p><strong>Estimated Value:</strong> {{estimatedValue}}</p>{{/if}}
            </div>
            
            <p><strong>What's Next:</strong></p>
            <ul>
              <li>Coordinate with the project team for execution</li>
              <li>Review project timeline and deliverables</li>
              <li>Begin client communication for project kickoff</li>
            </ul>
            
            <center>
              <a href="{{dashboardUrl}}" class="cta-button">Access Project Dashboard</a>
            </center>
          </div>
          <div class="footer">
            <p><strong>EB-Tracker</strong> | Project Management System</p>
            <p>This is an automated notification. Please do not reply to this email.</p>
          </div>
        </div>
      </body>
      </html>
    `
  },

  'proposal.uploaded': {
    subject: '📄 New Proposal Ready for Estimation: {{projectName}}',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <style>
          body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f4f4f4; }
          .container { max-width: 600px; margin: 20px auto; background: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
          .header { background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); color: white; padding: 30px 20px; text-align: center; }
          .header h1 { margin: 0; font-size: 24px; font-weight: 600; }
          .content { padding: 30px 20px; }
          .content h2 { color: #f5576c; font-size: 20px; margin-top: 0; }
          .info-box { background: #f8f9fa; border-left: 4px solid #f5576c; padding: 15px; margin: 20px 0; border-radius: 4px; }
          .info-box p { margin: 8px 0; }
          .priority-badge { background: #fff3cd; color: #856404; padding: 8px 16px; border-radius: 20px; display: inline-block; font-weight: 600; font-size: 14px; }
          .cta-button { display: inline-block; background: #f5576c; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; margin: 20px 0; font-weight: 600; }
          .footer { background: #f8f9fa; padding: 20px; text-align: center; font-size: 12px; color: #666; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>📄 Proposal Ready for Review</h1>
          </div>
          <div class="content">
            <h2>Action Required: Estimation Needed</h2>
            <center><span class="priority-badge">AWAITING ESTIMATION</span></center>
            
            <p>Dear Estimator,</p>
            <p>A new proposal has been uploaded by the BDM and requires your estimation expertise.</p>
            
            <div class="info-box">
              <p><strong>Project Name:</strong> {{projectName}}</p>
              <p><strong>Uploaded By:</strong> {{uploadedBy}}</p>
              <p><strong>Upload Date:</strong> {{date}}</p>
              {{#if clientName}}<p><strong>Client:</strong> {{clientName}}</p>{{/if}}
            </div>
            
            <p><strong>Your Task:</strong></p>
            <ul>
              <li>Review the proposal documents</li>
              <li>Analyze requirements and specifications</li>
              <li>Prepare detailed cost estimation</li>
              <li>Submit estimation for COO review</li>
            </ul>
            
            <center>
              <a href="{{dashboardUrl}}" class="cta-button">Start Estimation</a>
            </center>
          </div>
          <div class="footer">
            <p><strong>EB-Tracker</strong> | Project Management System</p>
            <p>This is an automated notification. Please do not reply to this email.</p>
          </div>
        </div>
      </body>
      </html>
    `
  },

  'estimation.complete': {
    subject: '💰 Estimation Complete: {{projectName}}',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <style>
          body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f4f4f4; }
          .container { max-width: 600px; margin: 20px auto; background: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
          .header { background: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%); color: white; padding: 30px 20px; text-align: center; }
          .header h1 { margin: 0; font-size: 24px; font-weight: 600; }
          .content { padding: 30px 20px; }
          .content h2 { color: #4facfe; font-size: 20px; margin-top: 0; }
          .info-box { background: #f8f9fa; border-left: 4px solid #00f2fe; padding: 15px; margin: 20px 0; border-radius: 4px; }
          .info-box p { margin: 8px 0; }
          .priority-badge { background: #d1ecf1; color: #0c5460; padding: 8px 16px; border-radius: 20px; display: inline-block; font-weight: 600; font-size: 14px; }
          .cta-button { display: inline-block; background: #4facfe; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; margin: 20px 0; font-weight: 600; }
          .footer { background: #f8f9fa; padding: 20px; text-align: center; font-size: 12px; color: #666; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>💰 Estimation Complete</h1>
          </div>
          <div class="content">
            <h2>Ready for Pricing Review</h2>
            <center><span class="priority-badge">AWAITING PRICING</span></center>
            
            <p>Dear COO,</p>
            <p>The estimation phase for the following project has been completed and is ready for your pricing review.</p>
            
            <div class="info-box">
              <p><strong>Project Name:</strong> {{projectName}}</p>
              <p><strong>Estimated By:</strong> {{estimatedBy}}</p>
              <p><strong>Completion Date:</strong> {{date}}</p>
              {{#if estimatedCost}}<p><strong>Estimated Cost:</strong> {{estimatedCost}}</p>{{/if}}
            </div>
            
            <p><strong>Required Actions:</strong></p>
            <ul>
              <li>Review the detailed estimation report</li>
              <li>Analyze cost breakdown and margins</li>
              <li>Set final pricing for the project</li>
              <li>Allocate pricing to Director for approval</li>
            </ul>
            
            <center>
              <a href="{{dashboardUrl}}" class="cta-button">Review Estimation</a>
            </center>
          </div>
          <div class="footer">
            <p><strong>EB-Tracker</strong> | Project Management System</p>
            <p>This is an automated notification. Please do not reply to this email.</p>
          </div>
        </div>
      </body>
      </html>
    `
  },

  'pricing.allocated': {
    subject: '📊 Pricing Allocated for Approval: {{projectName}}',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <style>
          body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f4f4f4; }
          .container { max-width: 600px; margin: 20px auto; background: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
          .header { background: linear-gradient(135deg, #fa709a 0%, #fee140 100%); color: white; padding: 30px 20px; text-align: center; }
          .header h1 { margin: 0; font-size: 24px; font-weight: 600; }
          .content { padding: 30px 20px; }
          .content h2 { color: #fa709a; font-size: 20px; margin-top: 0; }
          .info-box { background: #f8f9fa; border-left: 4px solid #fee140; padding: 15px; margin: 20px 0; border-radius: 4px; }
          .info-box p { margin: 8px 0; }
          .priority-badge { background: #fff3cd; color: #856404; padding: 8px 16px; border-radius: 20px; display: inline-block; font-weight: 600; font-size: 14px; }
          .cta-button { display: inline-block; background: #fa709a; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; margin: 20px 0; font-weight: 600; }
          .footer { background: #f8f9fa; padding: 20px; text-align: center; font-size: 12px; color: #666; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>📊 Pricing Ready for Approval</h1>
          </div>
          <div class="content">
            <h2>Director Approval Required</h2>
            <center><span class="priority-badge">PENDING APPROVAL</span></center>
            
            <p>Dear Director,</p>
            <p>The COO has completed the pricing review and allocated the project for your final approval.</p>
            
            <div class="info-box">
              <p><strong>Project Name:</strong> {{projectName}}</p>
              <p><strong>Allocated By:</strong> {{allocatedBy}}</p>
              <p><strong>Date:</strong> {{date}}</p>
              {{#if finalPrice}}<p><strong>Final Price:</strong> {{finalPrice}}</p>{{/if}}
            </div>
            
            <p><strong>Your Review:</strong></p>
            <ul>
              <li>Review pricing structure and margins</li>
              <li>Assess project feasibility and profitability</li>
              <li>Approve or request revisions</li>
              <li>Enable project progression upon approval</li>
            </ul>
            
            <center>
              <a href="{{dashboardUrl}}" class="cta-button">Review Project</a>
            </center>
          </div>
          <div class="footer">
            <p><strong>EB-Tracker</strong> | Project Management System</p>
            <p>This is an automated notification. Please do not reply to this email.</p>
          </div>
        </div>
      </body>
      </html>
    `
  },

  'project.won': {
    subject: '🎉 Project Won: {{projectName}}',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <style>
          body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f4f4f4; }
          .container { max-width: 600px; margin: 20px auto; background: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
          .header { background: linear-gradient(135deg, #ffd89b 0%, #19547b 100%); color: white; padding: 40px 20px; text-align: center; }
          .header h1 { margin: 0; font-size: 28px; font-weight: 700; }
          .content { padding: 30px 20px; }
          .content h2 { color: #19547b; font-size: 20px; margin-top: 0; }
          .celebration { text-align: center; font-size: 48px; margin: 20px 0; }
          .success-badge { background: #d4edda; color: #155724; padding: 10px 20px; border-radius: 25px; display: inline-block; font-weight: 700; font-size: 16px; margin: 15px 0; }
          .info-box { background: #f8f9fa; border-left: 4px solid #ffd89b; padding: 15px; margin: 20px 0; border-radius: 4px; }
          .info-box p { margin: 8px 0; }
          .cta-button { display: inline-block; background: #19547b; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; margin: 20px 0; font-weight: 600; }
          .footer { background: #f8f9fa; padding: 20px; text-align: center; font-size: 12px; color: #666; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🎉 Congratulations! Project Won!</h1>
          </div>
          <div class="content">
            <div class="celebration">🏆 🎊 ✨</div>
            <h2>Excellent News!</h2>
            <center><span class="success-badge">PROJECT WON</span></center>
            
            <p>Dear Team,</p>
            <p>We are thrilled to announce that we have successfully won the following project! This is a significant achievement for our team.</p>
            
            <div class="info-box">
              <p><strong>Project Name:</strong> {{projectName}}</p>
              <p><strong>Marked By:</strong> {{markedBy}}</p>
              <p><strong>Date:</strong> {{date}}</p>
              {{#if projectValue}}<p><strong>Project Value:</strong> {{projectValue}}</p>{{/if}}
              {{#if clientName}}<p><strong>Client:</strong> {{clientName}}</p>{{/if}}
            </div>
            
            <p><strong>Next Steps:</strong></p>
            <ul>
              <li><strong>COO:</strong> Begin project allocation process</li>
              <li><strong>Director:</strong> Oversee project initiation</li>
              <li><strong>Team:</strong> Prepare for project kickoff</li>
            </ul>
            
            <center>
              <a href="{{dashboardUrl}}" class="cta-button">View Project Details</a>
            </center>
            
            <p style="margin-top: 30px; padding-top: 20px; border-top: 2px solid #f0f0f0; text-align: center; font-style: italic; color: #666;">
              Great work, everyone! Let's deliver an outstanding project! 🚀
            </p>
          </div>
          <div class="footer">
            <p><strong>EB-Tracker</strong> | Project Management System</p>
            <p>This is an automated notification. Please do not reply to this email.</p>
          </div>
        </div>
      </body>
      </html>
    `
  },

  'project.allocated': {
    subject: '🎯 Project Allocated to Design Team: {{projectName}}',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <style>
          body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f4f4f4; }
          .container { max-width: 600px; margin: 20px auto; background: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
          .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px 20px; text-align: center; }
          .header h1 { margin: 0; font-size: 24px; font-weight: 600; }
          .content { padding: 30px 20px; }
          .content h2 { color: #667eea; font-size: 20px; margin-top: 0; }
          .info-box { background: #f8f9fa; border-left: 4px solid #764ba2; padding: 15px; margin: 20px 0; border-radius: 4px; }
          .info-box p { margin: 8px 0; }
          .priority-badge { background: #e7e3fc; color: #5e35b1; padding: 8px 16px; border-radius: 20px; display: inline-block; font-weight: 600; font-size: 14px; }
          .cta-button { display: inline-block; background: #667eea; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; margin: 20px 0; font-weight: 600; }
          .footer { background: #f8f9fa; padding: 20px; text-align: center; font-size: 12px; color: #666; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🎯 New Project Allocation</h1>
          </div>
          <div class="content">
            <h2>Project Assigned to Design Team</h2>
            <center><span class="priority-badge">ACTION REQUIRED</span></center>
            
            <p>Dear Design Manager,</p>
            <p>The COO has allocated a new project to the design team. Please review and assign to appropriate designers.</p>
            
            <div class="info-box">
              <p><strong>Project Name:</strong> {{projectName}}</p>
              <p><strong>Allocated By:</strong> {{allocatedBy}}</p>
              <p><strong>Allocation Date:</strong> {{date}}</p>
              {{#if priority}}<p><strong>Priority:</strong> {{priority}}</p>{{/if}}
              {{#if deadline}}<p><strong>Deadline:</strong> {{deadline}}</p>{{/if}}
            </div>
            
            <p><strong>Your Responsibilities:</strong></p>
            <ul>
              <li>Review project requirements and scope</li>
              <li>Assess team capacity and availability</li>
              <li>Assign project to appropriate designer(s)</li>
              <li>Set milestones and deliverable dates</li>
            </ul>
            
            <center>
              <a href="{{dashboardUrl}}" class="cta-button">Manage Allocation</a>
            </center>
          </div>
          <div class="footer">
            <p><strong>EB-Tracker</strong> | Project Management System</p>
            <p>This is an automated notification. Please do not reply to this email.</p>
          </div>
        </div>
      </body>
      </html>
    `
  },

  'designer.allocated': {
    subject: '🎨 New Project Assigned: {{projectName}}',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <style>
          body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f4f4f4; }
          .container { max-width: 600px; margin: 20px auto; background: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
          .header { background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); color: white; padding: 30px 20px; text-align: center; }
          .header h1 { margin: 0; font-size: 24px; font-weight: 600; }
          .content { padding: 30px 20px; }
          .content h2 { color: #f5576c; font-size: 20px; margin-top: 0; }
          .info-box { background: #f8f9fa; border-left: 4px solid #f5576c; padding: 15px; margin: 20px 0; border-radius: 4px; }
          .info-box p { margin: 8px 0; }
          .priority-badge { background: #ffe4e8; color: #c41e3a; padding: 8px 16px; border-radius: 20px; display: inline-block; font-weight: 600; font-size: 14px; }
          .cta-button { display: inline-block; background: #f5576c; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; margin: 20px 0; font-weight: 600; }
          .footer { background: #f8f9fa; padding: 20px; text-align: center; font-size: 12px; color: #666; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🎨 New Design Project</h1>
          </div>
          <div class="content">
            <h2>Project Assigned to You</h2>
            <center><span class="priority-badge">START DESIGNING</span></center>
            
            <p>Dear Designer,</p>
            <p>You have been assigned a new project by the Design Manager. Please review the project details and begin work.</p>
            
            <div class="info-box">
              <p><strong>Project Name:</strong> {{projectName}}</p>
              <p><strong>Assigned By:</strong> {{assignedBy}}</p>
              <p><strong>Assignment Date:</strong> {{date}}</p>
              {{#if deadline}}<p><strong>Deadline:</strong> {{deadline}}</p>{{/if}}
              {{#if priority}}<p><strong>Priority Level:</strong> {{priority}}</p>{{/if}}
            </div>
            
            <p><strong>Getting Started:</strong></p>
            <ul>
              <li>Access project files and requirements</li>
              <li>Review design specifications</li>
              <li>Plan your design approach</li>
              <li>Maintain regular progress updates</li>
            </ul>
            
            <center>
              <a href="{{dashboardUrl}}" class="cta-button">Access Project Files</a>
            </center>
            
            <p style="margin-top: 20px; padding: 15px; background: #fff8e1; border-left: 4px solid #ffc107; border-radius: 4px;">
              <strong>💡 Tip:</strong> Make sure to communicate with your Design Manager if you have any questions or need clarification on requirements.
            </p>
          </div>
          <div class="footer">
            <p><strong>EB-Tracker</strong> | Project Management System</p>
            <p>This is an automated notification. Please do not reply to this email.</p>
          </div>
        </div>
      </body>
      </html>
    `
  },

  'variation.allocated': {
    subject: '🔄 Design Variation Allocated: {{projectName}}',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <style>
          body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f4f4f4; }
          .container { max-width: 600px; margin: 20px auto; background: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
          .header { background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); color: white; padding: 30px 20px; text-align: center; }
          .header h1 { margin: 0; font-size: 24px; font-weight: 600; }
          .content { padding: 30px 20px; }
          .content h2 { color: #f5576c; font-size: 20px; margin-top: 0; }
          .info-box { background: #f8f9fa; border-left: 4px solid #ff9800; padding: 15px; margin: 20px 0; border-radius: 4px; }
          .info-box p { margin: 8px 0; }
          .warning-badge { background: #fff3cd; color: #856404; padding: 8px 16px; border-radius: 20px; display: inline-block; font-weight: 600; font-size: 14px; }
          .cta-button { display: inline-block; background: #f5576c; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; margin: 20px 0; font-weight: 600; }
          .footer { background: #f8f9fa; padding: 20px; text-align: center; font-size: 12px; color: #666; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🔄 Design Variation Request</h1>
          </div>
          <div class="content">
            <h2>New Variation Allocated</h2>
            <center><span class="warning-badge">REVIEW REQUIRED</span></center>
            
            <p>Dear Team,</p>
            <p>A design variation has been allocated for the following project. This requires management review and approval.</p>
            
            <div class="info-box">
              <p><strong>Project Name:</strong> {{projectName}}</p>
              <p><strong>Allocated By:</strong> {{allocatedBy}}</p>
              <p><strong>Variation Date:</strong> {{date}}</p>
              {{#if variationDetails}}<p><strong>Variation Details:</strong> {{variationDetails}}</p>{{/if}}
              {{#if reason}}<p><strong>Reason:</strong> {{reason}}</p>{{/if}}
            </div>
            
            <p><strong>Action Items by Role:</strong></p>
            <ul>
              <li><strong>BDM:</strong> Review client requirements and impact</li>
              <li><strong>COO:</strong> Assess resource and cost implications</li>
              <li><strong>Director:</strong> Provide final approval or rejection</li>
            </ul>
            
            <center>
              <a href="{{dashboardUrl}}" class="cta-button">Review Variation</a>
            </center>
            
            <p style="margin-top: 20px; padding: 15px; background: #ffebee; border-left: 4px solid #f44336; border-radius: 4px;">
              <strong>⚠️ Important:</strong> Variations may impact timeline and budget. Please review carefully before approval.
            </p>
          </div>
          <div class="footer">
            <p><strong>EB-Tracker</strong> | Project Management System</p>
            <p>This is an automated notification. Please do not reply to this email.</p>
          </div>
        </div>
      </body>
      </html>
    `
  },

  'variation.approved': {
    subject: '✅ Variation Approved: {{projectName}}',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <style>
          body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f4f4f4; }
          .container { max-width: 600px; margin: 20px auto; background: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
          .header { background: linear-gradient(135deg, #11998e 0%, #38ef7d 100%); color: white; padding: 30px 20px; text-align: center; }
          .header h1 { margin: 0; font-size: 24px; font-weight: 600; }
          .content { padding: 30px 20px; }
          .content h2 { color: #11998e; font-size: 20px; margin-top: 0; }
          .success-badge { background: #d4edda; color: #155724; padding: 10px 20px; border-radius: 25px; display: inline-block; font-weight: 600; margin: 15px 0; }
          .info-box { background: #f8f9fa; border-left: 4px solid #38ef7d; padding: 15px; margin: 20px 0; border-radius: 4px; }
          .info-box p { margin: 8px 0; }
          .cta-button { display: inline-block; background: #11998e; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; margin: 20px 0; font-weight: 600; }
          .footer { background: #f8f9fa; padding: 20px; text-align: center; font-size: 12px; color: #666; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>✅ Variation Approved</h1>
          </div>
          <div class="content">
            <h2>Director Approval Received</h2>
            <center><span class="success-badge">APPROVED</span></center>
            
            <p>Dear Team,</p>
            <p>The design variation for the following project has been approved by the Director. You may proceed with implementation.</p>
            
            <div class="info-box">
              <p><strong>Project Name:</strong> {{projectName}}</p>
              <p><strong>Approved By:</strong> {{approvedBy}}</p>
              <p><strong>Approval Date:</strong> {{date}}</p>
              {{#if variationDetails}}<p><strong>Approved Changes:</strong> {{variationDetails}}</p>{{/if}}
            </div>
            
            <p><strong>Next Steps:</strong></p>
            <ul>
              <li><strong>BDM:</strong> Communicate approved changes to client</li>
              <li><strong>Design Team:</strong> Implement approved variations</li>
              <li><strong>COO:</strong> Monitor progress and resource allocation</li>
              <li><strong>Director:</strong> Track project timeline adjustments</li>
            </ul>
            
            <center>
              <a href="{{dashboardUrl}}" class="cta-button">View Updated Project</a>
            </center>
          </div>
          <div class="footer">
            <p><strong>EB-Tracker</strong> | Project Management System</p>
            <p>This is an automated notification. Please do not reply to this email.</p>
          </div>
        </div>
      </body>
      </html>
    `
  },

  'invoice.saved': {
    subject: '💵 Invoice Saved: {{projectName}}',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <style>
          body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f4f4f4; }
          .container { max-width: 600px; margin: 20px auto; background: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
          .header { background: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%); color: white; padding: 30px 20px; text-align: center; }
          .header h1 { margin: 0; font-size: 24px; font-weight: 600; }
          .content { padding: 30px 20px; }
          .content h2 { color: #4facfe; font-size: 20px; margin-top: 0; }
          .info-box { background: #f8f9fa; border-left: 4px solid #00f2fe; padding: 15px; margin: 20px 0; border-radius: 4px; }
          .info-box p { margin: 8px 0; }
          .info-badge { background: #e3f2fd; color: #1976d2; padding: 8px 16px; border-radius: 20px; display: inline-block; font-weight: 600; font-size: 14px; }
          .cta-button { display: inline-block; background: #4facfe; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; margin: 20px 0; font-weight: 600; }
          .footer { background: #f8f9fa; padding: 20px; text-align: center; font-size: 12px; color: #666; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>💵 Invoice Notification</h1>
          </div>
          <div class="content">
            <h2>New Invoice Saved</h2>
            <center><span class="info-badge">INVOICE CREATED</span></center>
            
            <p>Dear Team,</p>
            <p>An invoice has been saved for the following project by the accounts team. Please review for your records.</p>
            
            <div class="info-box">
              <p><strong>Project Name:</strong> {{projectName}}</p>
              <p><strong>Invoice Number:</strong> {{invoiceNumber}}</p>
              <p><strong>Created By:</strong> {{createdBy}}</p>
              <p><strong>Date:</strong> {{date}}</p>
              {{#if invoiceAmount}}<p><strong>Amount:</strong> {{invoiceAmount}}</p>{{/if}}
            </div>
            
            <p><strong>Notification Recipients:</strong></p>
            <ul>
              <li><strong>BDM:</strong> For client communication and follow-up</li>
              <li><strong>COO:</strong> For financial tracking and oversight</li>
              <li><strong>Director:</strong> For project status awareness</li>
            </ul>
            
            <center>
              <a href="{{dashboardUrl}}" class="cta-button">View Invoice Details</a>
            </center>
            
            <p style="margin-top: 20px; padding: 15px; background: #e8f5e9; border-left: 4px solid #4caf50; border-radius: 4px;">
              <strong>📌 Note:</strong> This invoice has been recorded in the system. Ensure proper follow-up for payment collection.
            </p>
          </div>
          <div class="footer">
            <p><strong>EB-Tracker</strong> | Project Management System</p>
            <p>This is an automated notification. Please do not reply to this email.</p>
          </div>
        </div>
      </body>
      </html>
    `
  },

  'default': {
    subject: 'Notification from EB-Tracker',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <style>
          body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f4f4f4; }
          .container { max-width: 600px; margin: 20px auto; background: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
          .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px 20px; text-align: center; }
          .header h1 { margin: 0; font-size: 24px; font-weight: 600; }
          .content { padding: 30px 20px; }
          .footer { background: #f8f9fa; padding: 20px; text-align: center; font-size: 12px; color: #666; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>System Notification</h1>
          </div>
          <div class="content">
            <p>An event occurred in the EB-Tracker system:</p>
            <p><strong>Event:</strong> {{event}}</p>
          </div>
          <div class="footer">
            <p><strong>EB-Tracker</strong> | Project Management System</p>
          </div>
        </div>
      </body>
      </html>
    `
  }
};

/**
 * Fetches email addresses from Firestore based on user roles.
 */
async function getEmailsForRoles(roles) {
  if (!roles || roles.length === 0) {
    return [];
  }
  try {
    const normalizedRoles = roles.map(r => r.toLowerCase());
    const q = db.collection('users').where('role', 'in', normalizedRoles);
    const snapshot = await q.get();
    
    if (snapshot.empty) {
      console.log('No users found for roles:', roles);
      return [];
    }
    const emails = snapshot.docs.map(doc => doc.data().email).filter(Boolean);
    return [...new Set(emails)];
  } catch (error) {
    console.error('Error fetching emails for roles:', error);
    return [];
  }
}

/**
 * Fetches email of the BDM who created a specific project
 */
async function getBDMEmailForProject(projectId) {
  if (!projectId) return null;
  try {
    const projectDoc = await db.collection('projects').doc(projectId).get();
    if (!projectDoc.exists) {
      console.log('Project not found:', projectId);
      return null;
    }
    const createdBy = projectDoc.data().createdBy; // Assuming you store user ID or email
    if (!createdBy) return null;
    
    // If createdBy is already an email
    if (createdBy.includes('@')) return createdBy;
    
    // Otherwise, fetch user by ID
    const userDoc = await db.collection('users').doc(createdBy).get();
    if (!userDoc.exists) return null;
    
    return userDoc.data().email;
  } catch (error) {
    console.error('Error fetching BDM email:', error);
    return null;
  }
}

/**
 * Template interpolator - replaces {{key}} with data[key]
 * Supports simple conditionals like {{#if key}}...{{/if}}
 */
function interpolate(template, data) {
  if (!data) return template;
  
  const enhancedData = { 
    ...data, 
    event: data.event || 'Unknown Event',
    dashboardUrl: data.dashboardUrl || process.env.DASHBOARD_URL || 'https://yourapp.com/dashboard'
  };

  // Handle simple conditionals {{#if key}}...{{/if}}
  let result = template.replace(/\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (match, key, content) => {
    return enhancedData[key] ? content : '';
  });

  // Replace variables {{key}}
  result = result.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return enhancedData[key] || '';
  });

  return result;
}

// --- THIS IS THE NEW EXPORTABLE FUNCTION ---
async function sendEmailNotification(event, data) {
  if (!event) {
    throw new Error('Event name is required.');
  }

  console.log(`Processing event: ${event}`);

  // Get roles and template
  const rolesToNotify = EMAIL_RECIPIENT_MAP[event] || [];
  const template = EMAIL_TEMPLATE_MAP[event] || EMAIL_TEMPLATE_MAP['default'];

  // Get email addresses from Firestore based on roles
  let recipientEmails = await getEmailsForRoles(rolesToNotify);
  console.log('📋 Initial recipients from roles:', recipientEmails);
  console.log('📦 Received data:', JSON.stringify(data, null, 2));

  // --- SPECIAL CASES ---
  
  // 1. Proposal/Project created - add BDM who created it
  if (event === 'proposal.created' || event === 'project.submitted') {
    console.log('🔍 Processing BDM email for project submission...');
    console.log('🔑 data.createdByEmail =', data?.createdByEmail);
    
    if (data && data.createdByEmail) {
      console.log('✅ Found createdByEmail, adding to recipients:', data.createdByEmail);
      recipientEmails.push(data.createdByEmail);
    } else {
      console.log('❌ No createdByEmail provided in data');
      
      if (data && data.projectId) {
        console.log('🔍 Attempting to fetch BDM from projectId:', data.projectId);
        // Fallback: try to get BDM from project document
        const bdmEmail = await getBDMEmailForProject(data.projectId);
        if (bdmEmail) {
          console.log('✅ Found BDM email from project document:', bdmEmail);
          recipientEmails.push(bdmEmail);
        } else {
          console.log('❌ Could not find BDM email from project document');
        }
      } else {
        console.log('⚠️ No projectId provided either - cannot fetch BDM email');
      }
    }
  }

  // 2. Project approved - send to BDM who created the project
  // --- THIS IS THE UPDATED BLOCK ---
  if (event === 'project.approved_by_director') {
    let bdmEmail = null;
    if (data && data.createdByEmail) {
      // Priority 1: Use the email provided in the data payload
      console.log('✅ Found createdByEmail in payload for approval:', data.createdByEmail);
      bdmEmail = data.createdByEmail;
    } else if (data && data.projectId) {
      // Priority 2: Fallback to finding BDM from the project ID
      console.log('🔍 No createdByEmail, checking projectId:', data.projectId);
      bdmEmail = await getBDMEmailForProject(data.projectId);
    }
    
    if (bdmEmail) {
      recipientEmails = [bdmEmail]; // Only send to this specific BDM
    } else {
      console.warn(`No BDM email found for project.approved_by_director. Data:`, data);
    }
  }
  // --- END OF UPDATED BLOCK ---

  // 3. Designer allocated - send to specific designer
  if (event === 'designer.allocated' && data && data.designerEmail) {
    recipientEmails.push(data.designerEmail);
  }

  // 4. Variation allocated/approved - add project BDM
  if ((event === 'variation.allocated' || event === 'variation.approved') && data && data.projectId) {
    const projectBDMEmail = await getBDMEmailForProject(data.projectId);
    if (projectBDMEmail) {
      recipientEmails.push(projectBDMEmail);
    }
  }

  // 5. Invoice saved - add project BDM
  if (event === 'invoice.saved' && data && data.projectId) {
    const projectBDMEmail = await getBDMEmailForProject(data.projectId);
    if (projectBDMEmail) {
      recipientEmails.push(projectBDMEmail);
    }
  }

  // Remove duplicates
  const uniqueEmails = [...new Set(recipientEmails)];
  console.log('📧 Final unique recipients:', uniqueEmails);
  console.log('📊 Recipient count:', uniqueEmails.length);
  
  if (uniqueEmails.length === 0) {
    console.log(`No recipients found for event: ${event}`);
    return { 
      message: 'Event processed, but no email recipients found.',
      event: event 
    };
  }

  // Prepare email content
  const subject = interpolate(template.subject, { ...data, event });
  const htmlContent = interpolate(template.html, { ...data, event });
  const fromEmail = process.env.YOUR_VERIFIED_DOMAIN_EMAIL || 'notifications@ebtracker.com';

  // Send email via Resend
  const { data: sendData, error: sendError } = await resend.emails.send({
    from: `EB-Tracker <${fromEmail}>`,
    to: uniqueEmails,
    subject: subject,
    html: htmlContent,
  });

  if (sendError) {
    console.error('Resend Error:', sendError);
    throw new Error(`Failed to send email: ${sendError.message}`);
  }

  console.log(`Email sent successfully for event: ${event}`);
  return { 
    event: event,
    recipientCount: uniqueEmails.length,
    sendId: sendData.id 
  };
}
// --- END OF NEW EXPORTABLE FUNCTION ---


// --- THE API ENDPOINT (Now simplified) ---
emailRouter.post('/trigger', async (req, res) => {
  try {
    const { event, data } = req.body;

    if (!event) {
      return res.status(400).json({ error: 'Event name is required.' });
    }

    // Call the new, reusable function
    const result = await sendEmailNotification(event, data);

    res.status(200).json({ 
      message: 'Email(s) sent successfully.',
      ...result
    });

  } catch (error) {
    console.error('Server Error in /email/trigger:', error);
    res.status(500).json({ 
      error: 'Internal server error.',
      details: error.message 
    });
  }
});

// Test endpoint
emailRouter.get('/', (req, res) => {
  res.status(200).json({ 
    message: 'Email API is active.',
    availableEvents: Object.keys(EMAIL_RECIPIENT_MAP),
    usage: 'POST /api/email/trigger with { event, data }'
  });
});

// Health check
emailRouter.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'healthy',
    service: 'Email API',
    timestamp: new Date().toISOString()
  });
});

// --- EXPORT BOTH THE ROUTER AND THE NEW FUNCTION ---
module.exports = {
  emailHandler: emailRouter, // Keep original export name for server.js
  sendEmailNotification     // Export the new function
};
