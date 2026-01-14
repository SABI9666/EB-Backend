const admin = require('./_firebase-admin');
const db = admin.firestore();

module.exports = async (req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    try {
        const { method, query } = req;
        const path = query.path || '';

        // ========================
        // CREATE SCREENING
        // POST /api/screening/create
        // ========================
        if (method === 'POST' && path === 'create') {
            const data = req.body;
            
            const screening = {
                candidateName: data.candidateName || '',
                candidateEmail: data.candidateEmail || '',
                position: data.position || '',
                token: data.token || generateToken(),
                status: 'pending',
                expiryDays: data.expiryDays || 7,
                expiresAt: new Date(Date.now() + (data.expiryDays || 7) * 24 * 60 * 60 * 1000),
                createdBy: data.createdBy || 'system',
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                scores: null,
                response: null
            };
            
            const docRef = await db.collection('screenings').add(screening);
            
            // Send email if requested
            if (data.sendEmail) {
                await sendScreeningEmail(data.candidateEmail, data.candidateName, data.token, data.position);
            }
            
            return res.status(200).json({
                success: true,
                data: { id: docRef.id, ...screening }
            });
        }

        // ========================
        // VALIDATE TOKEN
        // GET /api/screening/validate?token=xxx
        // ========================
        if (method === 'GET' && path === 'validate') {
            const token = query.token;
            
            if (!token) {
                return res.status(400).json({ success: false, error: 'Token required' });
            }
            
            const snapshot = await db.collection('screenings')
                .where('token', '==', token)
                .limit(1)
                .get();
            
            if (snapshot.empty) {
                return res.status(404).json({ success: false, error: 'Invalid token' });
            }
            
            const doc = snapshot.docs[0];
            const screening = doc.data();
            
            // Check expiry
            if (screening.expiresAt && screening.expiresAt.toDate() < new Date()) {
                return res.status(400).json({ success: false, error: 'Token expired' });
            }
            
            return res.status(200).json({
                success: true,
                data: {
                    id: doc.id,
                    position: screening.position,
                    candidateName: screening.candidateName,
                    candidateEmail: screening.candidateEmail,
                    status: screening.status
                }
            });
        }

        // ========================
        // SUBMIT SCREENING RESPONSE
        // POST /api/screening/submit
        // ========================
        if (method === 'POST' && path === 'submit') {
            const data = req.body;
            const token = data.token;
            
            if (!token) {
                return res.status(400).json({ success: false, error: 'Token required' });
            }
            
            const snapshot = await db.collection('screenings')
                .where('token', '==', token)
                .limit(1)
                .get();
            
            if (snapshot.empty) {
                return res.status(404).json({ success: false, error: 'Invalid token' });
            }
            
            const doc = snapshot.docs[0];
            
            // Update screening with response
            await doc.ref.update({
                status: 'submitted',
                candidateInfo: data.candidateInfo || {},
                technicalSkills: data.technicalSkills || {},
                behavioralSkills: data.behavioralSkills || {},
                criticalThinking: data.criticalThinking || {},
                additionalInfo: data.additionalInfo || {},
                scores: data.scores || {},
                submittedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            
            return res.status(200).json({ success: true, message: 'Screening submitted' });
        }

        // ========================
        // LIST SCREENINGS
        // GET /api/screening/list
        // ========================
        if (method === 'GET' && path === 'list') {
            const snapshot = await db.collection('screenings')
                .orderBy('createdAt', 'desc')
                .limit(100)
                .get();
            
            const screenings = snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data(),
                createdAt: doc.data().createdAt?.toDate?.() || null,
                submittedAt: doc.data().submittedAt?.toDate?.() || null,
                reviewedAt: doc.data().reviewedAt?.toDate?.() || null
            }));
            
            return res.status(200).json({ success: true, data: screenings });
        }

        // ========================
        // REVIEW SCREENING
        // POST /api/screening/review
        // ========================
        if (method === 'POST' && path === 'review') {
            const { screeningId, decision, reviewedBy } = req.body;
            
            if (!screeningId) {
                return res.status(400).json({ success: false, error: 'Screening ID required' });
            }
            
            await db.collection('screenings').doc(screeningId).update({
                status: 'reviewed',
                decision: decision,
                reviewedBy: reviewedBy,
                reviewedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            
            return res.status(200).json({ success: true, message: 'Screening reviewed' });
        }

        // ========================
        // RESEND EMAIL
        // POST /api/screening/resend?id=xxx
        // ========================
        if (method === 'POST' && path === 'resend') {
            const id = query.id;
            
            const doc = await db.collection('screenings').doc(id).get();
            if (!doc.exists) {
                return res.status(404).json({ success: false, error: 'Screening not found' });
            }
            
            const screening = doc.data();
            await sendScreeningEmail(
                screening.candidateEmail, 
                screening.candidateName, 
                screening.token, 
                screening.position
            );
            
            return res.status(200).json({ success: true, message: 'Email resent' });
        }

        // ========================
        // DELETE SCREENING
        // DELETE /api/screening?id=xxx
        // ========================
        if (method === 'DELETE') {
            const id = query.id;
            
            if (!id) {
                return res.status(400).json({ success: false, error: 'ID required' });
            }
            
            await db.collection('screenings').doc(id).delete();
            
            return res.status(200).json({ success: true, message: 'Screening deleted' });
        }

        return res.status(404).json({ success: false, error: 'Endpoint not found' });

    } catch (error) {
        console.error('Screening API Error:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
};

// Generate unique token
function generateToken() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let token = '';
    for (let i = 0; i < 32; i++) {
        token += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return token;
}

// Send screening email (integrate with your email.js)
async function sendScreeningEmail(email, name, token, position) {
    // You can integrate with your existing email.js logic
    // For now, log the email details
    console.log('📧 Sending screening email:', { email, name, token, position });
    
    // Example: If you have nodemailer configured
    // const screeningUrl = `https://your-domain.com/candidate-screening.html?token=${token}`;
    // await sendEmail(email, 'Interview Assessment - EDANBROOK', `Dear ${name}, Please complete your screening: ${screeningUrl}`);
    
    return true;
}
