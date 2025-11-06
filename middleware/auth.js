// middleware/auth.js - Enhanced version with specific role validations
const admin = require('../api/_firebase-admin');
const db = admin.firestore();

async function verifyToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'No authorization token provided' });
    }
    
    const idToken = authHeader.split('Bearer ')[1];
    if (!idToken) {
      return res.status(401).json({ success: false, error: 'Invalid token format' });
    }
    
    // Verify the token using the Admin SDK
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    
    // Fetch the user's role from your 'users' collection in Firestore
    const userDoc = await db.collection('users').doc(decodedToken.uid).get();
    if (!userDoc.exists) {
        return res.status(404).json({ success: false, error: 'User data not found.' });
    }
    
    const userData = userDoc.data();
    
    // Attach user data to the request object for use in other APIs
    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email,
      name: userData.name,
      role: userData.role,
      status: userData.status || 'active'
    };
    
    // Check if user is active
    if (userData.status === 'inactive' || userData.status === 'suspended') {
      return res.status(403).json({ 
        success: false, 
        error: 'Account is ' + userData.status 
      });
    }
    
    next();
  } catch (error) {
    console.error('Auth verification error:', error);
    return res.status(401).json({ success: false, error: 'Authentication failed' });
  }
}

function requireRole(allowedRoles) {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ success: false, error: 'Authentication required' });
        }
        const roles = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];
        if (!roles.includes(req.user.role)) {
            return res.status(403).json({
                success: false,
                error: 'Insufficient permissions',
                message: `Your role is '${req.user.role}'. Required: ${roles.join(', ')}`,
            });
        }
        next();
    };
}

// New helper function for project-level access control
async function checkProjectAccess(req, res, next) {
    try {
        const projectId = req.params.id || req.query.projectId || req.body.projectId;
        if (!projectId) {
            return next(); // No project specified, continue
        }
        
        const projectDoc = await db.collection('projects').doc(projectId).get();
        if (!projectDoc.exists) {
            return res.status(404).json({ success: false, error: 'Project not found' });
        }
        
        const project = projectDoc.data();
        req.project = project; // Attach project data for use in route handler
        
        // Check access based on role
        switch(req.user.role) {
            case 'designer':
                // Designers can only access projects they're assigned to
                if (!project.assignedDesigners || !project.assignedDesigners.includes(req.user.uid)) {
                    return res.status(403).json({ 
                        success: false, 
                        error: 'You are not assigned to this project' 
                    });
                }
                break;
                
            case 'design_lead':
                // Design leads can only access projects assigned to them
                if (project.designLeadUid !== req.user.uid) {
                    return res.status(403).json({ 
                        success: false, 
                        error: 'This project is not assigned to you' 
                    });
                }
                break;
                
            case 'bdm':
                // BDMs can only access their own projects
                if (project.bdmUid !== req.user.uid) {
                    return res.status(403).json({ 
                        success: false, 
                        error: 'You can only access your own projects' 
                    });
                }
                break;
                
            case 'coo':
            case 'director':
            case 'accounts':
                // These roles can access all projects
                break;
                
            default:
                return res.status(403).json({ 
                    success: false, 
                    error: 'Invalid role for project access' 
                });
        }
        
        next();
    } catch (error) {
        console.error('Project access check error:', error);
        return res.status(500).json({ success: false, error: 'Access check failed' });
    }
}

// New helper function for proposal access control (BDM isolation)
async function checkProposalAccess(req, res, next) {
    try {
        const proposalId = req.params.id || req.query.id || req.body.proposalId;
        if (!proposalId || req.user.role !== 'bdm') {
            return next(); // No proposal or not BDM, continue
        }
        
        const proposalDoc = await db.collection('proposals').doc(proposalId).get();
        if (!proposalDoc.exists) {
            return res.status(404).json({ success: false, error: 'Proposal not found' });
        }
        
        const proposal = proposalDoc.data();
        req.proposal = proposal; // Attach proposal data
        
        // BDMs can only access their own proposals
        if (req.user.role === 'bdm' && proposal.createdByUid !== req.user.uid) {
            return res.status(403).json({ 
                success: false, 
                error: 'You can only access your own proposals' 
            });
        }
        
        next();
    } catch (error) {
        console.error('Proposal access check error:', error);
        return res.status(500).json({ success: false, error: 'Access check failed' });
    }
}

module.exports = { 
    verifyToken, 
    requireRole,
    checkProjectAccess,
    checkProposalAccess
};
