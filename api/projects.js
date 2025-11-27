// api/projects.js - CONSOLIDATED with variation code generator + EMAIL NOTIFICATIONS
const admin = require('./_firebase-admin');
const { verifyToken } = require('../middleware/auth');
const util = require('util');
const { sendEmailNotification } = require('./email'); // ✅ EMAIL IMPORT ADDED

const db = admin.firestore();

const allowCors = fn => async (req, res) => {
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST,PUT,DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }
    return await fn(req, res);
};

// Helper function to remove undefined values from objects before Firestore
function sanitizeForFirestore(obj) {
    const sanitized = {};
    for (const [key, value] of Object.entries(obj)) {
        if (value !== undefined) {
            sanitized[key] = value;
        }
    }
    return sanitized;
}

const handler = async (req, res) => {
    try {
        await util.promisify(verifyToken)(req, res);

        // Parse JSON body for POST/PUT
        if ((req.method === 'POST' || req.method === 'PUT') && req.headers['content-type'] === 'application/json') {
            if (!req.body || Object.keys(req.body).length === 0) {
                await new Promise((resolve) => {
                    const chunks = [];
                    req.on('data', (chunk) => chunks.push(chunk));
                    req.on('end', () => {
                        try {
                            const bodyBuffer = Buffer.concat(chunks);
                            req.body = bodyBuffer.length > 0 ? JSON.parse(bodyBuffer.toString()) : {};
                        } catch (e) {
                            console.error("Error parsing JSON body:", e);
                            req.body = {};
                        }
                        resolve();
                    });
                });
            }
        }

        // ============================================
        // GET - Retrieve projects OR generate variation code
        // ============================================
        if (req.method === 'GET') {
            const { id, action, parentId, status } = req.query;

            // ================================================
            // NEW: Generate Variation Code Logic
            // ================================================
            if (action === 'generate-variation-code') {
                if (!parentId) {
                    return res.status(400).json({ success: false, error: 'Parent Project ID (parentId) is required.' });
                }
    
                // 1. Get parent project
                const projectDoc = await db.collection('projects').doc(parentId).get();
                if (!projectDoc.exists) {
                    return res.status(404).json({ success: false, error: 'Parent project not found.' });
                }
                const project = projectDoc.data();
                const baseProjectCode = project.projectCode;
    
                // 2. Query all existing variations for this parent
                const variationsSnapshot = await db.collection('variations')
                    .where('parentProjectId', '==', parentId)
                    .get();
    
                let maxNum = 0;
                const variationRegex = /-V(\d+)$/;
    
                variationsSnapshot.forEach(doc => {
                    const data = doc.data();
                    if (data.variationCode) {
                        const match = data.variationCode.match(variationRegex);
                        if (match && match[1]) {
                            const num = parseInt(match[1], 10);
                            if (num > maxNum) {
                                maxNum = num;
                            }
                        }
                    }
                });
    
                // 3. The new variation number is the max found + 1
                const newVariationNum = maxNum + 1;
                const newVariationCode = `${baseProjectCode}-V${newVariationNum}`;
    
                return res.status(200).json({
                    success: true,
                    variationCode: newVariationCode,
                    variationNumber: newVariationNum
                });
            }

            // Get single project by ID
            if (id) {
                const projectDoc = await db.collection('projects').doc(id).get();
                if (!projectDoc.exists) {
                    return res.status(404).json({ success: false, error: 'Project not found' });
                }
                
                return res.status(200).json({ 
                    success: true, 
                    data: { id: projectDoc.id, ...projectDoc.data() }
                });
            }
            
            // Get all projects (with optional status filter)
            let query = db.collection('projects').orderBy('createdAt', 'desc');
            
            if (status) {
                query = query.where('status', '==', status);
            }
            
            const snapshot = await query.get();
            const projects = snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data()
            }));
            
            return res.status(200).json({ 
                success: true, 
                data: projects 
            });
        }

        // ============================================
        // POST - Create project from proposal
        // ============================================
        if (req.method === 'POST') {
            const { action, proposalId } = req.body;
            
            if (action === 'create_from_proposal') {
                // Only COO or Director can create projects
                if (!['coo', 'director'].includes(req.user.role)) {
                    return res.status(403).json({ 
                        success: false, 
                        error: 'Only COO or Director can create projects' 
                    });
                }
                
                if (!proposalId) {
                    return res.status(400).json({ 
                        success: false, 
                        error: 'Proposal ID is required' 
                    });
                }
                
                // Get proposal data
                const proposalDoc = await db.collection('proposals').doc(proposalId).get();
                if (!proposalDoc.exists) {
                    return res.status(404).json({ 
                        success: false, 
                        error: 'Proposal not found' 
                    });
                }
                
                const proposal = proposalDoc.data();
                
                // Check if proposal is won
                if (proposal.status !== 'won') {
                    return res.status(400).json({ 
                        success: false, 
                        error: 'Only WON proposals can be converted to projects' 
                    });
                }
                
                // Check if project already exists
                if (proposal.projectCreated && proposal.projectId) {
                    const existingProjectDoc = await db.collection('projects').doc(proposal.projectId).get();
                    if(existingProjectDoc.exists) {
                        return res.status(200).json({
                            success: true,
                            message: 'Project already exists for this proposal',
                            projectId: proposal.projectId 
                        });
                    }
                }
                
                // ✅ CRITICAL FIX: Handle Tonnage vs Hours Logic
                const estimationHours = parseFloat(proposal.estimation?.totalHours || 0);
                const estimationUsedTonnage = proposal.estimation?.usedTonnageForDesign || false;
                
                let maxAllocatedHours = 0;
                let maxHoursSource = 'not_set';
                let allocationStatus = 'not_started';
                
                // SCENARIO A: Estimator entered HOURS (not tonnage)
                if (estimationHours > 0 && !estimationUsedTonnage) {
                    maxAllocatedHours = estimationHours;
                    maxHoursSource = 'from_estimation_hours';
                }
                // SCENARIO B: Estimator used TONNAGE - COO will enter hours manually
                else if (estimationUsedTonnage) {
                    maxAllocatedHours = 0; // COO must enter manually (0 signals awaiting entry)
                    maxHoursSource = 'awaiting_coo_manual_entry';
                }
                
                // Create the project
                const projectData = {
                    proposalId: proposalId,
                    projectName: proposal.projectName,
                    projectCode: proposal.pricing?.projectNumber || 'PENDING',
                    clientCompany: proposal.clientCompany,
                    clientContact: proposal.clientContact || '',
                    clientEmail: proposal.clientEmail || '',
                    clientPhone: proposal.clientPhone || '',
                    location: proposal.country || '',
                    bdmName: proposal.createdByName || 'Unknown',
                    bdmUid: proposal.createdByUid || '',
                    bdmEmail: proposal.createdByEmail || proposal.bdmEmail || '',
                    quoteValue: proposal.pricing?.quoteValue || 0,
                    currency: proposal.pricing?.currency || 'USD',
                    status: 'pending_allocation',
                    designStatus: 'not_started',
                    
                    // ✅ NEW CRITICAL FIELDS FOR ALLOCATION LOGIC
                    maxAllocatedHours: maxAllocatedHours,      // Budget ceiling (0 if awaiting COO entry)
                    maxHoursSource: maxHoursSource,            // Source tracking
                    totalAllocatedHours: 0,                    // Sum of designer allocations
                    allocationStatus: allocationStatus,        // Status tracking
                    
                    // Keep estimation for reference
                    estimation: proposal.estimation || null,
                    
                    // Legacy fields for compatibility
                    additionalHours: 0,
                    hoursLogged: 0,
                    
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                    createdByName: req.user.name,
                    createdByUid: req.user.uid,
                    createdByRole: req.user.role
                };
                
                // Sanitize to remove any undefined values
                const sanitizedProjectData = sanitizeForFirestore(projectData);
                
                const projectRef = await db.collection('projects').add(sanitizedProjectData);
                
                // Update proposal with project reference
                await db.collection('proposals').doc(proposalId).update({
                    projectCreated: true,
                    projectId: projectRef.id,
                    projectCreatedAt: admin.firestore.FieldValue.serverTimestamp(),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
                
                // Log activity
                await db.collection('activities').add({
                    type: 'project_created',
                    details: `Project created from proposal: ${proposal.projectName}`,
                    performedByName: req.user.name,
                    performedByRole: req.user.role,
                    performedByUid: req.user.uid,
                    timestamp: admin.firestore.FieldValue.serverTimestamp(),
                    projectId: projectRef.id,
                    proposalId: proposalId
                });
                
                return res.status(200).json({ 
                    success: true, 
                    message: 'Project created successfully',
                    projectId: projectRef.id 
                });
            }
            
            return res.status(400).json({ 
                success: false, 
                error: 'Invalid action' 
            });
        }

        // ============================================
        // PUT - Update project (COO allocation and Design Lead assignment)
        // ============================================
        if (req.method === 'PUT') {
            const { id } = req.query;
            const { action, data } = req.body;
            
            if (!id) {
                return res.status(400).json({ success: false, error: 'Missing project ID' });
            }
            
            const projectRef = db.collection('projects').doc(id);
            const projectDoc = await projectRef.get();
            
            if (!projectDoc.exists) {
                return res.status(404).json({ success: false, error: 'Project not found' });
            }
            
            const project = projectDoc.data();
            let updates = {};
            let activityDetail = '';
            let notifications = [];
            
            if (action === 'allocate_to_design_lead' || action === 'allocate_design_lead') {
                // Only COO or Director can allocate
                if (!['coo', 'director'].includes(req.user.role)) {
                    return res.status(403).json({ 
                        success: false, 
                        error: 'Only COO or Director can allocate projects to Design Leads' 
                    });
                }
                
                // Validate the Design Lead UID from database
                const designLeadUid = data.designLeadUid;
                if (!designLeadUid) {
                    return res.status(400).json({ 
                        success: false, 
                        error: 'Design Lead UID is required' 
                    });
                }
                
                // Validate allocation notes - REQUIRED field
                if (!data.allocationNotes || data.allocationNotes.trim() === '') {
                    return res.status(400).json({ 
                        success: false, 
                        error: 'Allocation notes are required' 
                    });
                }
                
                // Fetch actual user from database to validate
                const designLeadDoc = await db.collection('users').doc(designLeadUid).get();
                if (!designLeadDoc.exists) {
                    return res.status(404).json({ 
                        success: false, 
                        error: 'Design Lead user not found' 
                    });
                }
                
                const designLeadData = designLeadDoc.data();
                if (designLeadData.role !== 'design_lead') {
                    return res.status(400).json({ 
                        success: false, 
                        error: 'Selected user is not a Design Lead' 
                    });
                }
                
                const maxAllocatedHours = parseFloat(data.maxAllocatedHours || 0);
                if (maxAllocatedHours <= 0) {
                     return res.status(400).json({ 
                        success: false, 
                        error: 'Max Allocated Hours must be greater than 0' 
                    });
                }
                
                // Update project with actual Design Lead info
                updates = {
                    designLeadName: designLeadData.name,
                    designLeadUid: designLeadUid,
                    designLeadEmail: designLeadData.email,
                    allocationDate: admin.firestore.FieldValue.serverTimestamp(),
                    allocatedBy: req.user.name,
                    allocatedByUid: req.user.uid,
                    projectStartDate: data.projectStartDate || admin.firestore.FieldValue.serverTimestamp(),
                    targetCompletionDate: data.targetCompletionDate || null,
                    allocationNotes: data.allocationNotes || '',
                    specialInstructions: data.specialInstructions || '',
                    priority: data.priority || 'Normal',
                    status: 'assigned',
                    designStatus: 'allocated',
                    maxAllocatedHours: maxAllocatedHours,
                    additionalHours: parseFloat(data.additionalHours || 0)
                };
                
                activityDetail = `Project allocated to Design Lead: ${designLeadData.name} by ${req.user.name} with ${maxAllocatedHours} hours.`;
                
                // Notify the Design Lead
                notifications.push({
                    type: 'project_allocated',
                    recipientUid: designLeadUid,
                    recipientRole: 'design_lead',
                    message: `New project allocated: "${project.projectName}" (${maxAllocatedHours} hours)`,
                    projectId: id,
                    projectName: project.projectName,
                    clientCompany: project.clientCompany,
                    allocatedBy: req.user.name,
                    priority: 'high'
                });
                
                // Notify BDM about allocation
                if (project.bdmUid) {
                    notifications.push({
                        type: 'project_allocated',
                        recipientUid: project.bdmUid,
                        recipientRole: 'bdm',
                        message: `Project "${project.projectName}" has been allocated to ${designLeadData.name}`,
                        projectId: id,
                        priority: 'normal'
                    });
                }
                
                // ✅ SEND EMAIL NOTIFICATION TO DESIGN MANAGER + COO
                console.log('\n📧 Sending project allocation email...');
                try {
                    const emailResult = await sendEmailNotification('project.allocated', {
                        projectName: project.projectName || 'Project',
                        clientName: project.clientCompany || project.clientName || 'Client',
                        designManagerEmail: designLeadData.email,  // ⚠️ CRITICAL
                        designManager: designLeadData.name,
                        projectValue: project.quoteValue || 'N/A',
                        startDate: data.projectStartDate ? new Date(data.projectStartDate).toLocaleDateString() : 'TBD',
                        projectId: id
                    });
                    
                    console.log('📬 Email Result:', emailResult);
                    
                    if (emailResult.success) {
                        console.log(`✅ Email sent to ${emailResult.recipients} recipients`);
                    } else {
                        console.error('⚠️ Email failed:', emailResult.error);
                    }
                } catch (emailError) {
                    console.error('❌ Email error:', emailError);
                    // Don't fail the allocation just because email failed
                }
                
            } 
            
            // Design Lead assigning designers
            else if (action === 'assign_designers') {
                // Only Design Lead (who is allocated) or COO/Director can assign designers
                if (req.user.role === 'design_lead' && project.designLeadUid !== req.user.uid) {
                    return res.status(403).json({ 
                        success: false, 
                        error: 'You are not the allocated Design Lead for this project' 
                    });
                }
                
                if (!['design_lead', 'coo', 'director'].includes(req.user.role)) {
                    return res.status(403).json({ 
                        success: false, 
                        error: 'Only Design Lead, COO, or Director can assign designers' 
                    });
                }
                
                const designerUids = data.designerUids || [];
                const designerNames = data.designerNames || [];
                const designerEmails = data.designerEmails || [];
                const designerHoursMap = data.designerHours || {};
                const totalAllocatedHours = data.totalAllocatedHours || 0;
                
                // Validate at least one designer is selected
                if (designerUids.length === 0) {
                    return res.status(400).json({
                        success: false,
                        error: 'At least one designer must be assigned'
                    });
                }
                
                const validatedDesigners = [];
                
                // Validation for allocated hours
                const maxHours = (project.maxAllocatedHours || 0) + (project.additionalHours || 0);
                if (maxHours > 0 && totalAllocatedHours > maxHours) {
                    return res.status(400).json({
                        success: false,
                        error: `Total allocated hours (${totalAllocatedHours}) exceeds available budget (${maxHours})`
                    });
                }
                
                // Validate all designers from database
                for (let i = 0; i < designerUids.length; i++) {
                    const uid = designerUids[i];
                    const userDoc = await db.collection('users').doc(uid).get();
                    
                    if (!userDoc.exists) {
                        return res.status(400).json({
                            success: false,
                            error: `Designer not found: ${designerNames[i] || uid}`
                        });
                    }
                    
                    const userData = userDoc.data();
                    if (userData.role !== 'designer') {
                        return res.status(400).json({
                            success: false,
                            error: `User ${userData.name} is not a designer`
                        });
                    }
                    
                    // Use email from frontend or Firestore
                    const designerEmail = designerEmails[i] || userData.email;
                    
                    validatedDesigners.push({
                        uid: uid,
                        name: userData.name,
                        email: designerEmail
                    });
                    
                    // Notify each designer
                    notifications.push({
                        type: 'project_assigned',
                        recipientUid: uid,
                        recipientRole: 'designer',
                        message: `New project assigned: "${project.projectName}" (${designerHoursMap[uid] || 0} hours allocated)`,
                        projectId: id,
                        projectName: project.projectName,
                        clientCompany: project.clientCompany,
                        assignedBy: req.user.name,
                        allocatedHours: designerHoursMap[uid] || 0,
                        priority: 'high'
                    });
                    
                    // ✅ SEND EMAIL NOTIFICATION TO DESIGNER + COO
                    console.log(`\n📧 Sending designer allocation email for ${userData.name}...`);
                    try {
                        const emailResult = await sendEmailNotification('designer.allocated', {
                            projectName: project.projectName || 'Project',
                            clientName: project.clientCompany || project.clientName || 'Client',
                            designerEmail: designerEmail,  // ⚠️ CRITICAL
                            designerRole: 'Designer',
                            designManager: project.designLeadName || req.user.name,
                            allocatedBy: req.user.name,
                            projectId: id
                        });
                        
                        console.log('📬 Email Result:', emailResult);
                        
                        if (emailResult.success) {
                            console.log(`✅ Email sent to ${emailResult.recipients} recipients`);
                        } else {
                            console.error('⚠️ Email failed:', emailResult.error);
                        }
                    } catch (emailError) {
                        console.error('❌ Email error:', emailError);
                        // Don't fail the assignment just because email failed
                    }
                }
                
                updates = {
                    assignedDesigners: validatedDesigners.map(d => d.uid),
                    assignedDesignerNames: validatedDesigners.map(d => d.name),
                    assignedDesignerEmails: validatedDesigners.map(d => d.email),
                    assignmentDate: admin.firestore.FieldValue.serverTimestamp(),
                    assignedBy: req.user.name,
                    assignedByUid: req.user.uid,
                    assignedDesignerHours: designerHoursMap,
                    totalAllocatedHours: totalAllocatedHours,
                    hoursLogged: 0,
                    status: 'in_progress',
                    designStatus: 'in_progress'
                };
                
                activityDetail = `Designers assigned: ${validatedDesigners.map(d => d.name).join(', ')} with a total of ${totalAllocatedHours} hours.`;
            }

            // Design Lead/Manager marking project as complete
            else if (action === 'mark_complete') {
                // Only allocated Design Lead, COO, or Director can complete
                if (req.user.role === 'design_lead' && project.designLeadUid !== req.user.uid) {
                    return res.status(403).json({ 
                        success: false, 
                        error: 'You are not the allocated Design Lead for this project' 
                    });
                }
                
                if (!['design_lead', 'coo', 'director'].includes(req.user.role)) {
                    return res.status(403).json({ 
                        success: false, 
                        error: 'Only the Design Lead, COO, or Director can complete this project' 
                    });
                }
                
                updates = {
                    status: 'completed',
                    designStatus: 'completed',
                    completedAt: admin.firestore.FieldValue.serverTimestamp(),
                    completedBy: req.user.name,
                    completedByUid: req.user.uid
                };
                
                activityDetail = `Project marked as COMPLETED by ${req.user.name}.`;
                
                // Notify the Accounts team
                notifications.push({
                    type: 'project_completed',
                    recipientRole: 'accounts',
                    message: `Project "${project.projectName}" is complete and ready for invoicing.`,
                    projectId: id,
                    projectName: project.projectName,
                    clientCompany: project.clientCompany,
                    priority: 'high'
                });

                // Also notify BDM
                if (project.bdmUid) {
                    notifications.push({
                        type: 'project_completed',
                        recipientUid: project.bdmUid,
                        recipientRole: 'bdm',
                        message: `Your project "${project.projectName}" has been marked complete by the design team.`,
                        projectId: id,
                        priority: 'normal'
                    });
                }
            }
            
            // ============================================
            // NEW: COO Assigning Multiple Designers (Multi-Designer Allocation)
            // ============================================
            else if (action === 'allocate_to_multiple_designers') {
                // Only COO or Director
                if (!['coo', 'director'].includes(req.user.role)) {
                    return res.status(403).json({ success: false, error: 'Permission denied' });
                }

                const { 
                    maxAllocatedHours,     // The Budget (New or Locked)
                    maxHoursSource,        // The Source (New or Locked)
                    totalAllocatedHours,   // The Sum of Assignments (Prev + Current)
                    designerAllocations,   // The New Array of assignments for this session
                    targetCompletionDate,
                    priority,
                    allocationNotes
                } = data;
                
                // ✅ CRITICAL FIX: Validate budget not exceeded
                const newTotal = parseFloat(totalAllocatedHours);
                const budget = parseFloat(maxAllocatedHours);
                
                if (newTotal > budget + 0.1) { // 0.1 float tolerance
                    const overage = (newTotal - budget).toFixed(1);
                    return res.status(400).json({ 
                        success: false, 
                        error: `Allocation exceeds budget by ${overage} hours. Budget: ${budget}, Attempting: ${newTotal}` 
                    });
                }
                
                // ✅ CRITICAL FIX: Calculate allocation status properly
                let allocStatus = 'not_started';
                if (newTotal > 0 && newTotal < budget - 0.1) {
                    allocStatus = 'partial';
                } else if (newTotal >= budget - 0.1) {
                    allocStatus = 'completed'; // ✅ FULLY ALLOCATED - LOCK
                }

                // 2. Merge new allocations with existing hours
                let existingDesignerHours = project.designerHours || {};
                let existingAssignedUids = new Set(project.assignedDesignerUids || []);
                let existingAssignedNames = new Set(project.assignedDesignerNames || []);
                let existingDesignerEmails = new Set(project.assignedDesignerEmails || []);

                // Process new allocations (incremental addition)
                const newAllocations = designerAllocations || [];
                
                for (const alloc of newAllocations) {
                    const currentUid = alloc.designerUid;
                    const currentAmount = parseFloat(alloc.allocatedHours);
                    
                    // Add the new hours to the existing total for this designer
                    existingDesignerHours[currentUid] = (parseFloat(existingDesignerHours[currentUid]) || 0) + currentAmount;

                    // Add to lists if new
                    existingAssignedUids.add(currentUid);
                    existingAssignedNames.add(alloc.designerName);
                    existingDesignerEmails.add(alloc.designerEmail);
                    
                    // Add email notification logic (mimicking existing structure)
                    console.log(`\n📧 Sending designer allocation email (COO) for ${alloc.designerName}...`);
                    try {
                        const emailResult = await sendEmailNotification('designer.allocated', {
                            projectName: project.projectName || 'Project',
                            clientName: project.clientCompany || project.clientName || 'Client',
                            designerEmail: alloc.designerEmail,  
                            designerRole: 'Designer',
                            designManager: project.designLeadName || 'COO Office',
                            allocatedBy: req.user.name,
                            projectId: id
                        });
                        if (!emailResult.success) console.error('⚠️ Email failed:', emailResult.error);
                    } catch (emailError) {
                        console.error('❌ Email error:', emailError);
                    }
                    
                    // Add notification for newly assigned designers
                    notifications.push({
                        type: 'project_assigned_coo',
                        recipientUid: alloc.designerUid,
                        recipientRole: 'designer',
                        message: `New project assigned by COO: "${project.projectName}" (${alloc.allocatedHours} hours allocated)`,
                        projectId: id,
                        projectName: project.projectName,
                        clientCompany: project.clientCompany,
                        assignedBy: req.user.name,
                        allocatedHours: alloc.allocatedHours,
                        priority: 'high'
                    });
                }
                
                // Prepare update object
                updates = {
                    // *** CRITICAL FIELDS FOR BUDGET LOCKING ***
                    maxAllocatedHours: parseFloat(maxAllocatedHours), // LOCK THE BUDGET
                    maxHoursSource: maxHoursSource,                  // LOCK THE SOURCE
                    totalAllocatedHours: parseFloat(totalAllocatedHours), // NEW TOTAL USAGE
                    allocationStatus: allocStatus,                   // ✅ STATUS TRACKING
                    
                    designerHours: existingDesignerHours,
                    assignedDesignerUids: Array.from(existingAssignedUids),
                    assignedDesignerNames: Array.from(existingAssignedNames),
                    assignedDesignerEmails: Array.from(existingDesignerEmails),
                    
                    status: 'in_progress', // Set global project status
                    designStatus: 'in_progress',
                };
                
                // ✅ FIX: Only add optional fields if they have valid values (not undefined)
                if (targetCompletionDate) {
                    updates.targetCompletionDate = targetCompletionDate;
                } else if (!project.targetCompletionDate) {
                    updates.targetCompletionDate = null;
                }
                
                if (priority) {
                    updates.priority = priority;
                } else if (!project.priority) {
                    updates.priority = 'medium';
                }
                
                if (allocationNotes) {
                    updates.allocationNotes = allocationNotes;
                } else if (!project.allocationNotes) {
                    updates.allocationNotes = '';
                }
                
                // Set initial allocation metadata if this is the first allocation
                // Check if totalAllocatedHours was 0 before this update
                if (!project.allocationDate || (project.totalAllocatedHours || 0) === 0) {
                    updates.allocationDate = admin.firestore.FieldValue.serverTimestamp();
                    updates.allocatedBy = req.user.name;
                    updates.allocatedByUid = req.user.uid;
                }
                
                activityDetail = `COO Multi-Designer allocation performed by ${req.user.name}. Total allocated hours: ${parseFloat(totalAllocatedHours).toFixed(1)}. Status: ${allocStatus.replace('_', ' ')}.`;
            }
            // ============================================
            // END: COO Assigning Multiple Designers
            // ============================================
            
            else {
                return res.status(400).json({ 
                    success: false, 
                    error: 'Invalid action' 
                });
            }
            
            // Apply updates
            updates.updatedAt = admin.firestore.FieldValue.serverTimestamp();
            
            // ✅ FIX: Sanitize to remove any undefined values before Firestore
            const sanitizedUpdates = sanitizeForFirestore(updates);
            
            await projectRef.update(sanitizedUpdates);
            
            // Log activity
            await db.collection('activities').add({
                type: `project_${action}`,
                details: activityDetail,
                performedByName: req.user.name,
                performedByRole: req.user.role,
                performedByUid: req.user.uid,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                projectId: id,
                projectName: project.projectName
            });
            
            // Send all notifications
            for (const notification of notifications) {
                await db.collection('notifications').add({
                    ...notification,
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    isRead: false
                });
            }
            
            return res.status(200).json({ 
                success: true, 
                message: 'Project updated successfully' 
            });
        }

        // ============================================
        // DELETE - Delete project (COO/Director only)
        // ============================================
        if (req.method === 'DELETE') {
            const { id } = req.query;
            
            if (!id) {
                return res.status(400).json({ success: false, error: 'Missing project ID' });
            }
            
            // Only COO or Director can delete projects
            if (!['coo', 'director'].includes(req.user.role)) {
                return res.status(403).json({ 
                    success: false, 
                    error: 'Only COO or Director can delete projects' 
                });
            }
            
            const projectRef = db.collection('projects').doc(id);
            const projectDoc = await projectRef.get();
            
            if (!projectDoc.exists) {
                return res.status(404).json({ success: false, error: 'Project not found' });
            }
            
            const project = projectDoc.data();
            
            // Delete the project
            await projectRef.delete();
            
            // Log activity
            await db.collection('activities').add({
                type: 'project_deleted',
                details: `Project deleted: ${project.projectName}`,
                performedByName: req.user.name,
                performedByRole: req.user.role,
                performedByUid: req.user.uid,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                projectId: id,
                projectName: project.projectName
            });
            
            return res.status(200).json({ 
                success: true, 
                message: 'Project deleted successfully' 
            });
        }

        return res.status(405).json({ 
            success: false, 
            error: 'Method not allowed' 
        });

    } catch (error) {
        console.error('Error in projects handler:', error);
        return res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
};

module.exports = allowCors(handler);
