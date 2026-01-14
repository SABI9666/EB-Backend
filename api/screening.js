// ============================================
// SCREENING API - Candidate Assessment System
// File: api/screening.js
// ============================================

const express = require('express');
const router = express.Router();
const admin = require('./_firebase-admin');
const { verifyToken } = require('../middleware/auth');
const { sendEmailNotification } = require('./email');

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
// POST /api/screening?path=create
// Create new screening link (HR/Director only)
// ============================================
router.post('/', verifyToken, async (req, res) => {
    const path = req.query.path;
    
    try {
        // CREATE - Generate new screening link for a position
        if (path === 'create') {
            const { 
                position, 
                jobDescription,
                experienceRequired,
                token, 
                expiryDays = 30, 
                createdBy,
                isReusable = true
            } = req.body;
            
            if (!position) {
                return res.status(400).json({
                    success: false,
                    error: 'Position is required'
                });
            }
            
            // Generate token if not provided
            const screeningToken = token || generateToken();
            
            // Calculate expiry date
            const expiryDate = new Date();
            expiryDate.setDate(expiryDate.getDate() + parseInt(expiryDays));
            
            // Create screening job document
            const screeningData = {
                position,
                jobDescription: jobDescription || null,
                experienceRequired: experienceRequired || null,
                token: screeningToken,
                isReusable: isReusable,
                status: 'active',
                candidateCount: 0,
                createdBy: createdBy || req.user?.uid || 'system',
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                expiryDate: expiryDate
            };
            
            const docRef = await db.collection(COLLECTION).add(screeningData);
            
            console.log(`✅ Screening job created: ${docRef.id} for ${position}`);
            
            return res.json({
                success: true,
                data: {
                    id: docRef.id,
                    token: screeningToken,
                    position,
                    expiryDate: expiryDate.toISOString()
                },
                message: 'Screening link created successfully'
            });
        }
        
        // REVIEW - Approve/Reject with interview details
        if (path === 'review') {
            const { 
                screeningId, 
                decision, 
                reviewedBy, 
                notes,
                interviewDateTime,
                meetingLink,
                sendEmail 
            } = req.body;
            
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
            
            // Get candidate data first
            const candidateDoc = await db.collection('screening_candidates').doc(screeningId).get();
            
            if (!candidateDoc.exists) {
                return res.status(404).json({
                    success: false,
                    error: 'Candidate not found'
                });
            }
            
            const candidate = candidateDoc.data();
            
            const updateData = {
                status: 'reviewed',
                decision,
                reviewedBy: reviewedBy || req.user?.uid || 'system',
                reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
                reviewNotes: notes || null
            };
            
            // Add interview details if approved
            if (decision === 'Selected') {
                updateData.interviewDateTime = interviewDateTime || null;
                updateData.meetingLink = meetingLink || null;
            }
            
            await db.collection('screening_candidates').doc(screeningId).update(updateData);
            
            // Send interview invitation email if requested
            let emailSent = false;
            if (decision === 'Selected' && sendEmail && candidate?.candidateEmail) {
                console.log('📧 Attempting to send interview invitation via email service...');
                const emailResult = await sendEmailNotification('screening.interview_invitation', {
                    candidateEmail: candidate.candidateEmail,
                    candidateName: candidate.candidateName,
                    position: candidate.position,
                    interviewDateTime: interviewDateTime,
                    meetingLink: meetingLink,
                    notes: notes,
                    score: candidate.scores?.percentage
                });
                emailSent = emailResult?.success || false;
            }
            
            // Send rejection email if rejected
            if (decision === 'Rejected' && sendEmail && candidate?.candidateEmail) {
                console.log('📧 Sending rejection notification...');
                await sendEmailNotification('screening.rejected', {
                    candidateEmail: candidate.candidateEmail,
                    candidateName: candidate.candidateName,
                    position: candidate.position
                });
            }
            
            console.log(`✅ Candidate ${screeningId} marked as ${decision}`);
            
            return res.json({
                success: true,
                emailSent: emailSent,
                message: `Candidate marked as ${decision}` + (sendEmail && decision === 'Selected' ? (emailSent ? ' and interview invitation sent!' : ' (email sending failed - check email config)') : '')
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
            
            return res.json({
                success: true,
                message: 'Email functionality to be implemented'
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
// Get all candidates (HR/Director only)
// ============================================
router.get('/', verifyToken, async (req, res) => {
    const path = req.query.path;
    
    try {
        // LIST - Get all candidate submissions
        if (path === 'list') {
            const snapshot = await db.collection('screening_candidates')
                .orderBy('submittedAt', 'desc')
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
                    submittedAt: data.submittedAt?.toDate?.()?.toISOString() || data.submittedAt,
                    reviewedAt: data.reviewedAt?.toDate?.()?.toISOString() || data.reviewedAt,
                    decision: data.decision,
                    interviewDateTime: data.interviewDateTime,
                    meetingLink: data.meetingLink,
                    experience: data.experience,
                    currentCompany: data.currentCompany,
                    expectedSalary: data.expectedSalary,
                    strengths: data.strengths,
                    improvements: data.improvements,
                    achievements: data.achievements,
                    motivation: data.motivation
                });
            });
            
            return res.json({
                success: true,
                data: screenings,
                count: screenings.length
            });
        }
        
        // JOBS - Get all screening jobs/positions
        if (path === 'jobs') {
            const snapshot = await db.collection(COLLECTION)
                .orderBy('createdAt', 'desc')
                .limit(50)
                .get();
            
            const jobs = [];
            snapshot.forEach(doc => {
                const data = doc.data();
                jobs.push({
                    id: doc.id,
                    position: data.position,
                    jobDescription: data.jobDescription,
                    experienceRequired: data.experienceRequired,
                    token: data.token,
                    status: data.status,
                    candidateCount: data.candidateCount || 0,
                    createdAt: data.createdAt?.toDate?.()?.toISOString() || data.createdAt,
                    expiryDate: data.expiryDate?.toDate?.()?.toISOString() || data.expiryDate
                });
            });
            
            return res.json({
                success: true,
                data: jobs
            });
        }
        
        // Default: Return all candidates
        const snapshot = await db.collection('screening_candidates')
            .orderBy('submittedAt', 'desc')
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
        
        // Find screening job by token
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
        
        const jobDoc = snapshot.docs[0];
        const jobData = jobDoc.data();
        
        // Check if job is still active
        if (jobData.status !== 'active') {
            return res.status(400).json({
                success: false,
                error: 'This screening is no longer accepting submissions'
            });
        }
        
        // Check expiry
        if (jobData.expiryDate) {
            const expiryDate = jobData.expiryDate.toDate ? jobData.expiryDate.toDate() : new Date(jobData.expiryDate);
            if (expiryDate < new Date()) {
                return res.status(400).json({
                    success: false,
                    error: 'This screening link has expired'
                });
            }
        }
        
        // Check if this candidate (by email) has already submitted
        const existingSubmission = await db.collection('screening_candidates')
            .where('jobId', '==', jobDoc.id)
            .where('candidateEmail', '==', candidateInfo?.email?.toLowerCase())
            .limit(1)
            .get();
        
        if (!existingSubmission.empty) {
            return res.status(400).json({
                success: false,
                error: 'You have already submitted an assessment for this position'
            });
        }
        
        // Create candidate submission document
        const candidateData = {
            jobId: jobDoc.id,
            token: token,
            position: jobData.position,
            
            // Candidate info
            candidateName: candidateInfo?.name || null,
            candidateEmail: candidateInfo?.email?.toLowerCase() || null,
            candidatePhone: candidateInfo?.phone || null,
            currentCompany: candidateInfo?.currentCompany || null,
            experience: candidateInfo?.experience || null,
            
            // Assessment data
            technicalSkills: technicalSkills || null,
            behavioralSkills: behavioralSkills || null,
            criticalThinking: criticalThinking || null,
            
            // Additional info
            strengths: additionalInfo?.strengths || null,
            improvements: additionalInfo?.improvements || null,
            achievements: additionalInfo?.achievements || null,
            motivation: additionalInfo?.motivation || null,
            expectedSalary: additionalInfo?.expectedSalary || null,
            availableFrom: additionalInfo?.availableFrom || null,
            additionalComments: additionalInfo?.additionalComments || null,
            
            // Scores
            scores: scores || null,
            
            // Status
            status: 'submitted',
            submittedAt: admin.firestore.FieldValue.serverTimestamp(),
            reviewedAt: null,
            reviewedBy: null,
            decision: null
        };
        
        const docRef = await db.collection('screening_candidates').add(candidateData);
        
        // Increment candidate count on the job
        await db.collection(COLLECTION).doc(jobDoc.id).update({
            candidateCount: admin.firestore.FieldValue.increment(1)
        });
        
        console.log(`✅ Candidate submission: ${docRef.id} - ${candidateInfo?.name || 'Unknown'} for ${jobData.position}`);
        
        // Notify HR about new candidate submission
        try {
            await sendEmailNotification('screening.candidate_submitted', {
                candidateName: candidateInfo?.name,
                candidateEmail: candidateInfo?.email,
                candidatePhone: candidateInfo?.phone,
                position: jobData.position,
                experience: candidateInfo?.experience,
                expectedSalary: additionalInfo?.expectedSalary,
                score: scores?.percentage
            });
        } catch (emailError) {
            console.warn('⚠️ Failed to send HR notification:', emailError.message);
        }
        
        return res.json({
            success: true,
            message: 'Assessment submitted successfully',
            data: {
                id: docRef.id,
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
        
        // Check if job is active
        if (data.status !== 'active') {
            return res.json({
                success: false,
                valid: false,
                error: 'This screening is no longer accepting submissions',
                closed: true
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
                jobDescription: data.jobDescription,
                experienceRequired: data.experienceRequired,
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
// DELETE /api/screening?id=xxx&type=job|candidate
// Delete a screening job or candidate entry
// ============================================
router.delete('/', verifyToken, async (req, res) => {
    try {
        const id = req.query.id;
        const type = req.query.type || 'candidate'; // Default to candidate
        
        if (!id) {
            return res.status(400).json({
                success: false,
                error: 'ID required'
            });
        }
        
        const collection = type === 'job' ? COLLECTION : 'screening_candidates';
        
        // Check if document exists
        const doc = await db.collection(collection).doc(id).get();
        
        if (!doc.exists) {
            return res.status(404).json({
                success: false,
                error: `${type === 'job' ? 'Screening job' : 'Candidate'} not found`
            });
        }
        
        // If deleting a job, also delete all associated candidates
        if (type === 'job') {
            const candidates = await db.collection('screening_candidates')
                .where('jobId', '==', id)
                .get();
            
            const batch = db.batch();
            candidates.forEach(candidateDoc => {
                batch.delete(candidateDoc.ref);
            });
            batch.delete(doc.ref);
            await batch.commit();
            
            console.log(`✅ Screening job deleted: ${id} (with ${candidates.size} candidates)`);
        } else {
            // Delete single candidate
            await db.collection(collection).doc(id).delete();
            console.log(`✅ Candidate deleted: ${id}`);
        }
        
        return res.json({
            success: true,
            message: `${type === 'job' ? 'Screening job' : 'Candidate'} deleted successfully`
        });
        
    } catch (error) {
        console.error('❌ Screening delete error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to delete',
            details: error.message
        });
    }
});

console.log('✅ Screening API routes loaded');

module.exports = router;
