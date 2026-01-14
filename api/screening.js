// ============================================
// SCREENING API - Candidate Assessment System
// File: api/screening.js
// ============================================

const express = require('express');
const router = express.Router();
const admin = require('./_firebase-admin');
const { verifyToken } = require('../middleware/auth');

const db = admin.firestore();
const COLLECTION = 'screenings';

// ============================================
// HELPER: Generate unique token
// ============================================
function generateToken(length = 32) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let token = '';
    for (let i = 0; i < length; i++) {
        token += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return token;
}

// ============================================
// HELPER: Send email notification (placeholder)
// ============================================
async function sendScreeningEmail(to, candidateName, position, link, expiryDays) {
    // TODO: Integrate with your email service (SendGrid, Nodemailer, etc.)
    console.log(`📧 Sending screening email to: ${to}`);
    console.log(`   Position: ${position}`);
    console.log(`   Link: ${link}`);
    console.log(`   Expires in: ${expiryDays} days`);
    
    // For now, just log - implement actual email sending later
    return true;
}

// ============================================
// POST /api/screening?path=create
// Create new screening link (HR/Director only)
// ============================================
router.post('/', verifyToken, async (req, res) => {
    const path = req.query.path;
    
    try {
        // CREATE - Generate new screening link
        if (path === 'create') {
            const { 
                candidateEmail, 
                position, 
                token, 
                expiryDays = 7, 
                sendEmail = false,
                createdBy 
            } = req.body;
            
            if (!candidateEmail || !position) {
                return res.status(400).json({
                    success: false,
                    error: 'candidateEmail and position are required'
                });
            }
            
            // Generate token if not provided
            const screeningToken = token || generateToken();
            
            // Calculate expiry date
            const expiryDate = new Date();
            expiryDate.setDate(expiryDate.getDate() + parseInt(expiryDays));
            
            // Create screening document
            const screeningData = {
                candidateEmail: candidateEmail.toLowerCase().trim(),
                candidateName: null, // Will be filled by candidate
                candidatePhone: null,
                position,
                token: screeningToken,
                status: 'pending',
                scores: null,
                createdBy: createdBy || req.user?.uid || 'system',
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                sentAt: admin.firestore.FieldValue.serverTimestamp(),
                expiryDate: expiryDate,
                submittedAt: null,
                reviewedAt: null,
                reviewedBy: null,
                decision: null,
                additionalInfo: null
            };
            
            const docRef = await db.collection(COLLECTION).add(screeningData);
            
            // Send email if requested
            if (sendEmail) {
                const baseUrl = process.env.FRONTEND_URL || 'https://eb-tracker-frontend.vercel.app';
                const screeningLink = `${baseUrl}/candidate-screening.html?token=${screeningToken}`;
                await sendScreeningEmail(candidateEmail, null, position, screeningLink, expiryDays);
            }
            
            console.log(`✅ Screening created: ${docRef.id} for ${candidateEmail}`);
            
            return res.json({
                success: true,
                data: {
                    id: docRef.id,
                    token: screeningToken,
                    candidateEmail,
                    position,
                    expiryDate: expiryDate.toISOString()
                },
                message: 'Screening link created successfully'
            });
        }
        
        // REVIEW - Mark as selected/rejected
        if (path === 'review') {
            const { screeningId, decision, reviewedBy, notes } = req.body;
            
            if (!screeningId || !decision) {
                return res.status(400).json({
                    success: false,
                    error: 'screeningId and decision are required'
                });
            }
            
            if (!['Selected', 'Rejected', 'On Hold'].includes(decision)) {
                return res.status(400).json({
                    success: false,
                    error: 'decision must be Selected, Rejected, or On Hold'
                });
            }
            
            await db.collection(COLLECTION).doc(screeningId).update({
                status: 'reviewed',
                decision,
                reviewedBy: reviewedBy || req.user?.uid || 'system',
                reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
                reviewNotes: notes || null
            });
            
            console.log(`✅ Screening ${screeningId} marked as ${decision}`);
            
            return res.json({
                success: true,
                message: `Candidate marked as ${decision}`
            });
        }
        
        // RESEND - Resend email notification
        if (path === 'resend') {
            const screeningId = req.query.id;
            
            if (!screeningId) {
                return res.status(400).json({
                    success: false,
                    error: 'Screening ID required'
                });
            }
            
            const doc = await db.collection(COLLECTION).doc(screeningId).get();
            
            if (!doc.exists) {
                return res.status(404).json({
                    success: false,
                    error: 'Screening not found'
                });
            }
            
            const data = doc.data();
            const baseUrl = process.env.FRONTEND_URL || 'https://eb-tracker-frontend.vercel.app';
            const screeningLink = `${baseUrl}/candidate-screening.html?token=${data.token}`;
            
            await sendScreeningEmail(data.candidateEmail, data.candidateName, data.position, screeningLink, 7);
            
            // Update last sent timestamp
            await db.collection(COLLECTION).doc(screeningId).update({
                lastResentAt: admin.firestore.FieldValue.serverTimestamp()
            });
            
            return res.json({
                success: true,
                message: `Email resent to ${data.candidateEmail}`
            });
        }
        
        // Default: Unknown path for POST
        return res.status(400).json({
            success: false,
            error: 'Invalid path parameter. Use: create, review, or resend'
        });
        
    } catch (error) {
        console.error('❌ Screening POST error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to process request',
            details: error.message
        });
    }
});

// ============================================
// GET /api/screening?path=list
// Get all screenings (HR/Director only)
// ============================================
router.get('/', verifyToken, async (req, res) => {
    const path = req.query.path;
    
    try {
        // LIST - Get all screenings
        if (path === 'list') {
            const snapshot = await db.collection(COLLECTION)
                .orderBy('createdAt', 'desc')
                .limit(100)
                .get();
            
            const screenings = [];
            snapshot.forEach(doc => {
                const data = doc.data();
                screenings.push({
                    id: doc.id,
                    candidateName: data.candidateName,
                    candidateEmail: data.candidateEmail,
                    candidatePhone: data.candidatePhone,
                    position: data.position,
                    status: data.status,
                    scores: data.scores,
                    token: data.token,
                    sentAt: data.sentAt?.toDate?.()?.toISOString() || data.sentAt,
                    submittedAt: data.submittedAt?.toDate?.()?.toISOString() || data.submittedAt,
                    reviewedAt: data.reviewedAt?.toDate?.()?.toISOString() || data.reviewedAt,
                    decision: data.decision,
                    experience: data.additionalInfo?.experience || data.experience,
                    currentCompany: data.additionalInfo?.currentCompany || data.currentCompany,
                    expectedSalary: data.additionalInfo?.expectedSalary || data.expectedSalary,
                    strengths: data.additionalInfo?.strengths || data.strengths,
                    improvements: data.additionalInfo?.improvements,
                    achievements: data.additionalInfo?.achievements,
                    motivation: data.additionalInfo?.motivation
                });
            });
            
            return res.json({
                success: true,
                data: screenings,
                count: screenings.length
            });
        }
        
        // VALIDATE - Check if token is valid (PUBLIC - no auth needed for this specific check)
        if (path === 'validate') {
            const token = req.query.token;
            
            if (!token) {
                return res.status(400).json({
                    success: false,
                    error: 'Token required'
                });
            }
            
            const snapshot = await db.collection(COLLECTION)
                .where('token', '==', token)
                .limit(1)
                .get();
            
            if (snapshot.empty) {
                return res.json({
                    success: false,
                    valid: false,
                    error: 'Invalid or expired token'
                });
            }
            
            const doc = snapshot.docs[0];
            const data = doc.data();
            
            // Check if already submitted
            if (data.status !== 'pending') {
                return res.json({
                    success: false,
                    valid: false,
                    error: 'This assessment has already been submitted'
                });
            }
            
            // Check expiry
            if (data.expiryDate && new Date(data.expiryDate.toDate()) < new Date()) {
                return res.json({
                    success: false,
                    valid: false,
                    error: 'This link has expired'
                });
            }
            
            return res.json({
                success: true,
                valid: true,
                data: {
                    position: data.position,
                    candidateEmail: data.candidateEmail
                }
            });
        }
        
        // Default: Return all screenings if no path specified
        const snapshot = await db.collection(COLLECTION)
            .orderBy('createdAt', 'desc')
            .limit(50)
            .get();
        
        const screenings = [];
        snapshot.forEach(doc => {
            screenings.push({ id: doc.id, ...doc.data() });
        });
        
        return res.json({
            success: true,
            data: screenings
        });
        
    } catch (error) {
        console.error('❌ Screening GET error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to fetch screenings',
            details: error.message
        });
    }
});

// ============================================
// POST /api/screening/submit (PUBLIC - No auth)
// Candidate submits their assessment
// ============================================
router.post('/submit', async (req, res) => {
    try {
        const {
            token,
            candidateInfo,
            technicalSkills,
            behavioralSkills,
            criticalThinking,
            additionalInfo,
            scores
        } = req.body;
        
        if (!token) {
            return res.status(400).json({
                success: false,
                error: 'Token is required'
            });
        }
        
        // Find screening by token
        const snapshot = await db.collection(COLLECTION)
            .where('token', '==', token)
            .limit(1)
            .get();
        
        if (snapshot.empty) {
            return res.status(404).json({
                success: false,
                error: 'Invalid token'
            });
        }
        
        const doc = snapshot.docs[0];
        const existingData = doc.data();
        
        // Check if already submitted
        if (existingData.status !== 'pending') {
            return res.status(400).json({
                success: false,
                error: 'This assessment has already been submitted'
            });
        }
        
        // Update with candidate's submission
        const updateData = {
            candidateName: candidateInfo?.name || null,
            candidatePhone: candidateInfo?.phone || null,
            candidateEmail: candidateInfo?.email || existingData.candidateEmail,
            currentCompany: candidateInfo?.currentCompany || null,
            experience: candidateInfo?.experience || null,
            
            // Store all assessment data
            technicalSkills: technicalSkills || null,
            behavioralSkills: behavioralSkills || null,
            criticalThinking: criticalThinking || null,
            
            // Additional info from candidate
            additionalInfo: {
                strengths: additionalInfo?.strengths || null,
                improvements: additionalInfo?.improvements || null,
                achievements: additionalInfo?.achievements || null,
                motivation: additionalInfo?.motivation || null,
                expectedSalary: additionalInfo?.expectedSalary || null,
                availableFrom: additionalInfo?.availableFrom || null,
                additionalComments: additionalInfo?.additionalComments || null
            },
            
            // Calculated scores
            scores: scores || null,
            
            // Update status
            status: 'submitted',
            submittedAt: admin.firestore.FieldValue.serverTimestamp()
        };
        
        await db.collection(COLLECTION).doc(doc.id).update(updateData);
        
        console.log(`✅ Screening submitted: ${doc.id} by ${candidateInfo?.name || 'Unknown'}`);
        
        return res.json({
            success: true,
            message: 'Assessment submitted successfully',
            data: {
                id: doc.id,
                submittedAt: new Date().toISOString()
            }
        });
        
    } catch (error) {
        console.error('❌ Screening submit error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to submit assessment',
            details: error.message
        });
    }
});

// ============================================
// GET /api/screening/validate (PUBLIC - No auth)
// Validate token before showing form
// ============================================
router.get('/validate', async (req, res) => {
    try {
        const token = req.query.token;
        
        if (!token) {
            return res.status(400).json({
                success: false,
                valid: false,
                error: 'Token required'
            });
        }
        
        const snapshot = await db.collection(COLLECTION)
            .where('token', '==', token)
            .limit(1)
            .get();
        
        if (snapshot.empty) {
            return res.json({
                success: false,
                valid: false,
                error: 'Invalid or expired link'
            });
        }
        
        const doc = snapshot.docs[0];
        const data = doc.data();
        
        // Check if already submitted
        if (data.status !== 'pending') {
            return res.json({
                success: false,
                valid: false,
                error: 'This assessment has already been completed',
                alreadySubmitted: true
            });
        }
        
        // Check expiry
        if (data.expiryDate) {
            const expiryDate = data.expiryDate.toDate ? data.expiryDate.toDate() : new Date(data.expiryDate);
            if (expiryDate < new Date()) {
                return res.json({
                    success: false,
                    valid: false,
                    error: 'This link has expired',
                    expired: true
                });
            }
        }
        
        return res.json({
            success: true,
            valid: true,
            data: {
                position: data.position,
                candidateEmail: data.candidateEmail,
                companyName: 'EDANBROOK'
            }
        });
        
    } catch (error) {
        console.error('❌ Token validation error:', error);
        return res.status(500).json({
            success: false,
            valid: false,
            error: 'Validation failed'
        });
    }
});

// ============================================
// DELETE /api/screening?id=xxx
// Delete a screening entry (HR/Director only)
// ============================================
router.delete('/', verifyToken, async (req, res) => {
    try {
        const screeningId = req.query.id;
        
        if (!screeningId) {
            return res.status(400).json({
                success: false,
                error: 'Screening ID required'
            });
        }
        
        // Check if document exists
        const doc = await db.collection(COLLECTION).doc(screeningId).get();
        
        if (!doc.exists) {
            return res.status(404).json({
                success: false,
                error: 'Screening not found'
            });
        }
        
        // Delete the document
        await db.collection(COLLECTION).doc(screeningId).delete();
        
        console.log(`✅ Screening deleted: ${screeningId}`);
        
        return res.json({
            success: true,
            message: 'Screening deleted successfully'
        });
        
    } catch (error) {
        console.error('❌ Screening delete error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to delete screening',
            details: error.message
        });
    }
});

console.log('✅ Screening API routes loaded');

module.exports = router;
