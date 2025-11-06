// api/projects.js - CONSOLIDATED with variation code generator
const admin = require('./_firebase-admin');
const { verifyToken } = require('../middleware/auth');
const util = require('util');

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
            const { id, action, parentId, status } = req.query; // Added 'status' query param

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
                const variationRegex = /-V(\d+)$/; // Regex to find "-V" followed by digits at the end
    
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
    
                return res.status(200).json({ success: true, data: { variationCode: newVariationCode } });
            }

            // ================================================
            // Get Single Project by ID
            // ================================================
            else if (id) {
                const doc = await db.collection('projects').doc(id).get();
                if (!doc.exists) {
                    return res.status(404).json({ success: false, error: 'Project not found' });
                }
                
                const projectData = { id: doc.id, ...doc.data() };
                
                // Check access based on role and allocation
                if (req.user.role === 'design_lead' && projectData.designLeadUid !== req.user.uid) {
                    return res.status(403).json({ 
                        success: false, 
                        error: 'You are not allocated to this project' 
                    });
                }
                
                if (req.user.role === 'designer' && !(projectData.assignedDesigners || []).includes(req.user.uid)) {
                    return res.status(403).json({ 
                        success: false, 
                        error: 'You are not assigned to this project' 
                    });
                }
                
                // Load tasks for this project
                const tasksSnapshot = await db.collection('tasks')
                    .where('projectId', '==', id)
                    .get();
                projectData.tasks = tasksSnapshot.docs.map(d => ({ id: d.id, ...d.data() }));
                
                // Load deliverables for this project
                const deliverablesSnapshot = await db.collection('deliverables')
                    .where('projectId', '==', id)
                    .orderBy('uploadedAt', 'desc')
                    .get();
                projectData.deliverables = deliverablesSnapshot.docs.map(d => ({ id: d.id, ...d.data() }));
                
                // Load BDM files if Design Lead or Designer
                if (['design_lead', 'designer'].includes(req.user.role)) {
                    const filesSnapshot = await db.collection('files')
                        .where('proposalId', '==', projectData.proposalId)
                        .get();
                    projectData.bdmFiles = filesSnapshot.docs.map(d => ({ id: d.id, ...d.data() }));
                }
                
                return res.status(200).json({ success: true, data: projectData });
            }
            
            // ================================================
            // Get All Projects (with role-based filtering)
            // ================================================
            else {
                let query = db.collection('projects').orderBy('createdAt', 'desc');
                
                // Design Leads ONLY see projects allocated to them by COO
                if (req.user.role === 'design_lead') {
                    query = query.where('designLeadUid', '==', req.user.uid)
                                .where('status', 'in', ['assigned', 'in_progress', 'completed']);
                }
                
                // Designer: Only projects where they are assigned by Design Lead
                else if (req.user.role === 'designer') {
                    // Check for the specific query param from showTasks()
                    if (req.query.assignedToMe === 'true') {
                         query = query.where('assignedDesigners', 'array-contains', req.user.uid);
                    }
                    // Otherwise, a general 'designer' GET might return nothing or be forbidden
                }
                
                // BDM: Only their own projects
                else if (req.user.role === 'bdm') {
                    query = query.where('bdmUid', '==', req.user.uid);
                }
                
                // Accounts: Filter by status if requested (e.g., 'completed')
                if (req.user.role === 'accounts' && status) {
                    query = query.where('status', '==', status);
                }
                
                // COO, Director: See all projects (no filter needed, unless they filter)
                if ((req.user.role === 'coo' || req.user.role === 'director') && status) {
                     query = query.where('status', '==', status);
                }
                
                const snapshot = await query.get();
                const projects = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
                
                return res.status(200).json({ success: true, data: projects });
            }
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
                        return res.status(200).json({ // Return 200 OK, but indicate it already exists
                            success: true, // Not a failure, just already done
                            message: 'Project already exists for this proposal',
                            projectId: proposal.projectId 
                        });
                    }
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
                    location: proposal.country || '', // Use 'country' from proposal
                    bdmName: proposal.createdByName || 'Unknown',
                    bdmUid: proposal.createdByUid || '',
                    bdmEmail: proposal.createdByEmail || proposal.bdmEmail || '',
                    quoteValue: proposal.pricing?.quoteValue || 0,
                    currency: proposal.pricing?.currency || 'USD',
                    status: 'pending_allocation', // Changed from 'pending'
                    designStatus: 'not_started',
                    
                    // Initialize all hour fields
                    maxAllocatedHours: 0,
                    additionalHours: 0,
                    totalAllocatedHours: 0,
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
                const designerHoursMap = data.designerHours || {}; // e.g., { "uid1": 8, "uid2": 10 }
                const totalAllocatedHours = data.totalAllocatedHours || 0; // Total
                
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
                for (const uid of designerUids) {
                    const userDoc = await db.collection('users').doc(uid).get();
                    if (!userDoc.exists) {
                        return res.status(400).json({
                            success: false,
                            error: `User ${uid} not found`
                        });
                    }
                    const userData = userDoc.data();
                    if (userData.role !== 'designer') {
                        return res.status(400).json({
                            success: false,
                            error: `User ${userData.name} is not a designer`
                        });
                    }
                    validatedDesigners.push({
                        uid: uid,
                        name: userData.name,
                        email: userData.email
                    });
                }
                
                updates = {
                    assignedDesigners: validatedDesigners.map(d => d.uid),
                    assignedDesignerNames: validatedDesigners.map(d => d.name),
                    assignedDesignerEmails: validatedDesigners.map(d => d.email),
                    assignmentDate: admin.firestore.FieldValue.serverTimestamp(),
                    assignedBy: req.user.name,
                    assignedByUid: req.user.uid,
                    assignedDesignerHours: designerHoursMap, // Store the map
                    totalAllocatedHours: totalAllocatedHours, // Store the calculated total
                    hoursLogged: 0, // Reset or initialize hours logged when re-assigning
                    status: 'in_progress',
                    designStatus: 'in_progress'
                };
                
                activityDetail = `Designers assigned: ${validatedDesigners.map(d => d.name).join(', ')} with a total of ${totalAllocatedHours} hours.`;
                
                // Notify each designer
                for (const designer of validatedDesigners) {
                    notifications.push({
                        type: 'project_assigned',
                        recipientUid: designer.uid,
                        recipientRole: 'designer',
                        message: `New project assigned: "${project.projectName}" (${designerHoursMap[designer.uid] || 0} hours allocated)`,
                        projectId: id,
                        projectName: project.projectName,
                        clientCompany: project.clientCompany,
                        assignedBy: req.user.name,
                        allocatedHours: designerHoursMap[designer.uid] || 0,
                        priority: 'high'
                    });
                }
            }

            // *** START OF FIX ***
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
            // *** END OF FIX ***
            
            else {
                return res.status(400).json({ 
                    success: false, 
                    error: 'Invalid action' 
                });
            }
            
            // Apply updates
            updates.updatedAt = admin.firestore.FieldValue.serverTimestamp();
            await projectRef.update(updates);
            
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
            
            // If there's a linked proposal, update it
            if (project.proposalId) {
                await db.collection('proposals').doc(project.proposalId).update({
                    projectCreated: false,
                    projectId: null,
                    allocationStatus: null,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
            }
            
            // Log activity
            await db.collection('activities').add({
                type: 'project_deleted',
                details: `Project deleted: ${project.projectName}`,
                performedByName: req.user.name,
                performedByRole: req.user.role,
                performedByUid: req.user.uid,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                projectId: id
            });
            
            return res.status(200).json({ 
                success: true, 
                message: 'Project deleted successfully' 
            });
        }

        return res.status(405).json({ success: false, error: 'Method not allowed' });
        
    } catch (error) {
        console.error('Projects API error:', error);
        return res.status(500).json({ 
            success: false, 
            error: 'Internal Server Error', 
            message: error.message 
        });
    }
};

module.exports = allowCors(handler);
