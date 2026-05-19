// api/forgot-password.js - Password Reset API (No auth required)
const admin = require('./_firebase-admin');
const { Resend } = require('resend');

const db = admin.firestore();

const allowCors = fn => async (req, res) => {
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }
    return await fn(req, res);
};

// Rate limiting: track reset requests per email (in-memory, resets on restart)
const resetAttempts = new Map();
const RATE_LIMIT_WINDOW = 15 * 60 * 1000; // 15 minutes
const MAX_ATTEMPTS = 3;

function checkRateLimit(email) {
    const now = Date.now();
    const attempts = resetAttempts.get(email) || [];

    // Filter to only recent attempts within the window
    const recentAttempts = attempts.filter(t => now - t < RATE_LIMIT_WINDOW);
    resetAttempts.set(email, recentAttempts);

    if (recentAttempts.length >= MAX_ATTEMPTS) {
        return false;
    }

    recentAttempts.push(now);
    resetAttempts.set(email, recentAttempts);
    return true;
}

const handler = async (req, res) => {
    try {
        // Only allow POST
        if (req.method !== 'POST') {
            return res.status(405).json({
                success: false,
                error: 'Method not allowed'
            });
        }

        const { email } = req.body;

        if (!email || !email.includes('@')) {
            return res.status(400).json({
                success: false,
                error: 'Please provide a valid email address'
            });
        }

        const normalizedEmail = email.toLowerCase().trim();

        // Rate limit check
        if (!checkRateLimit(normalizedEmail)) {
            return res.status(429).json({
                success: false,
                error: 'Too many reset attempts. Please try again in 15 minutes.'
            });
        }

        // Always return success to avoid email enumeration attacks
        // But only actually send if the user exists
        const successResponse = {
            success: true,
            message: 'If an account exists with this email, a password reset link has been sent.'
        };

        try {
            // Check if user exists in Firebase Auth
            const userRecord = await admin.auth().getUserByEmail(normalizedEmail);

            if (!userRecord) {
                console.log(`Password reset requested for non-existent email: ${normalizedEmail}`);
                return res.status(200).json(successResponse);
            }

            // Check if user exists in our users collection and is active
            const usersSnapshot = await db.collection('users')
                .where('email', '==', normalizedEmail)
                .limit(1)
                .get();

            let userName = userRecord.displayName || 'User';
            if (!usersSnapshot.empty) {
                const userData = usersSnapshot.docs[0].data();
                userName = userData.name || userName;

                if (userData.status === 'suspended' || userData.status === 'inactive') {
                    console.log(`Password reset blocked for ${userData.status} user: ${normalizedEmail}`);
                    return res.status(200).json(successResponse);
                }
            }

            // Generate password reset link using Firebase Admin
            const resetLink = await admin.auth().generatePasswordResetLink(normalizedEmail);

            console.log(`Password reset link generated for: ${normalizedEmail}`);

            // Send email via Resend
            if (!process.env.RESEND_API_KEY) {
                console.error('RESEND_API_KEY is missing - cannot send password reset email');
                return res.status(500).json({
                    success: false,
                    error: 'Email service is not configured. Please contact your administrator.'
                });
            }

            const resend = new Resend(process.env.RESEND_API_KEY);

            const emailHtml = getPasswordResetEmail(userName, resetLink);

            const result = await resend.emails.send({
                from: 'EB-Tracker <sabin@edanbrook.com>',
                to: [normalizedEmail],
                subject: 'Password Reset - EB-Tracker',
                html: emailHtml
            });

            if (result.error) {
                console.error(`Failed to send reset email to ${normalizedEmail}:`, result.error.message);
                return res.status(500).json({
                    success: false,
                    error: 'Failed to send reset email. Please try again later.'
                });
            }

            console.log(`Password reset email sent to: ${normalizedEmail}`);
            return res.status(200).json(successResponse);

        } catch (authError) {
            // If user doesn't exist in Firebase Auth, still return success (prevent enumeration)
            if (authError.code === 'auth/user-not-found') {
                console.log(`Password reset requested for non-existent email: ${normalizedEmail}`);
                return res.status(200).json(successResponse);
            }
            throw authError;
        }

    } catch (error) {
        console.error('Password reset error:', error.message);
        return res.status(500).json({
            success: false,
            error: 'An error occurred. Please try again later.'
        });
    }
};

// Password reset email template
function getPasswordResetEmail(userName, resetLink) {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Password Reset - EB-Tracker</title>
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
              <h2 style="margin: 0 0 15px 0; color: #1e293b; font-size: 22px;">
                Password Reset Request
              </h2>
              <p style="margin: 0 0 20px 0; color: #475569; font-size: 15px; line-height: 1.6;">
                Hi <strong>${userName}</strong>,
              </p>
              <p style="margin: 0 0 20px 0; color: #475569; font-size: 15px; line-height: 1.6;">
                We received a request to reset your password for your EB-Tracker account. Click the button below to set a new password:
              </p>

              <!-- Reset Button -->
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 25px 0;">
                <tr>
                  <td style="border-radius: 6px; background-color: #667eea;">
                    <a href="${resetLink}" target="_blank" style="display: inline-block; padding: 14px 32px; font-size: 15px; font-weight: 600; color: #ffffff; text-decoration: none; border-radius: 6px;">
                      Reset My Password
                    </a>
                  </td>
                </tr>
              </table>

              <!-- Warning -->
              <div style="background-color: #fef3c7; border-left: 4px solid #f59e0b; padding: 15px 20px; margin: 20px 0; border-radius: 4px;">
                <p style="margin: 0; color: #92400e; font-size: 14px; line-height: 1.5;">
                  This link will expire in 1 hour. If you did not request a password reset, please ignore this email or contact your administrator.
                </p>
              </div>

              <p style="margin: 20px 0 0 0; color: #94a3b8; font-size: 13px; line-height: 1.5;">
                If the button above doesn't work, copy and paste this link into your browser:<br>
                <a href="${resetLink}" style="color: #667eea; word-break: break-all;">${resetLink}</a>
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 20px 30px; background-color: #f8fafc; border-radius: 0 0 8px 8px; text-align: center;">
              <p style="margin: 0 0 10px 0; color: #64748b; font-size: 13px;">
                This is an automated message from EB-Tracker. Do not reply to this email.
              </p>
              <p style="margin: 0; color: #94a3b8; font-size: 12px;">
                &copy; ${new Date().getFullYear()} EB-Tracker. All rights reserved.
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

module.exports = allowCors(handler);
