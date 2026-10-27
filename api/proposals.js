// api/proposals.js - COMPLETE UPDATED VERSION WITH PRICING EDIT FUNCTIONALITY
const admin = require('./_firebase-admin');
const { verifyToken } = require('../middleware/auth');
const util = require('util');
const { sendEmailNotification } = require('./email');
const { findDuplicateProposal, findDuplicatePo, parseWonDate } = require('../lib/proposal-rules');

const db = admin.firestore();
const bucket = admin.storage().bucket();

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
        // GET - Retrieve proposals
        // ============================================
        if (req.method === 'GET') {
            const { id } = req.query;
            
            if (id) {
                // Get single proposal
                const doc = await db.collection('proposals').doc(id).get();
                if (!doc.exists) {
                    return res.status(404).json({ success: false, error: 'Proposal not found' });
                }
                
                const proposalData = doc.data();
                
                // BDM isolation
                if (req.user.role === 'bdm' && proposalData.createdByUid !== req.user.uid) {
                    return res.status(403).json({ 
                        success: false, 
                        error: 'Access denied. You can only view your own proposals.' 
                    });
                }

                // Design Lead isolation
                if (req.user.role === 'design_lead') {
                    if (!proposalData.projectCreated || !proposalData.projectId) {
                        return res.status(403).json({ 
                            success: false, 
                            error: 'This proposal has not been converted to a project yet.' 
                        });
                    }
                    const projectDoc = await db.collection('projects').doc(proposalData.projectId).get();
                    if (!projectDoc.exists || projectDoc.data().designLeadUid !== req.user.uid) {
                        return res.status(403).json({ 
                            success: false, 
                            error: 'This proposal is not allocated to you.' 
                        });
                    }
                }

                // Designer isolation
                if (req.user.role === 'designer') {
                    if (!proposalData.projectCreated || !proposalData.projectId) {
                        return res.status(403).json({ 
                            success: false, 
                            error: 'This proposal has not been converted to a project yet.' 
                        });
                    }
                    const projectDoc = await db.collection('projects').doc(proposalData.projectId).get();
                    if (!projectDoc.exists || !(projectDoc.data().assignedDesignerUids || []).includes(req.user.uid)) {
                        return res.status(403).json({ 
                            success: false, 
                            error: 'This proposal is not assigned to you.' 
                        });
                    }
                }
                
                return res.status(200).json({ success: true, data: { id: doc.id, ...proposalData } });
            }
            
            // Get all proposals with role-based filtering
            let proposals = [];

            if (req.user.role === 'bdm') {
                const query = db.collection('proposals')
                    .where('createdByUid', '==', req.user.uid)
                    .orderBy('createdAt', 'desc');
                const snapshot = await query.get();
                proposals = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            }
            else if (req.user.role === 'design_lead') {
                // Query projects by designLeadUid
                const leadSnapshot = await db.collection('projects')
                    .where('designLeadUid', '==', req.user.uid)
                    .get();

                // Also query projects where design lead is in assignedDesignerUids
                const assignedSnapshot = await db.collection('projects')
                    .where('assignedDesignerUids', 'array-contains', req.user.uid)
                    .get();

                // Merge and deduplicate by project id
                const projectMap = new Map();
                leadSnapshot.docs.forEach(doc => projectMap.set(doc.id, doc.data()));
                assignedSnapshot.docs.forEach(doc => projectMap.set(doc.id, doc.data()));

                const proposalIds = Array.from(projectMap.values())
                    .map(p => p.proposalId)
                    .filter(id => id);

                if (proposalIds.length > 0) {
                    const uniqueIds = [...new Set(proposalIds)];
                    const batchSize = 10;
                    for (let i = 0; i < uniqueIds.length; i += batchSize) {
                        const batch = uniqueIds.slice(i, i + batchSize);
                        const proposalsSnapshot = await db.collection('proposals')
                            .where(admin.firestore.FieldPath.documentId(), 'in', batch)
                            .get();
                        proposals.push(...proposalsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
                    }
                    proposals.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
                }
            }
            else if (req.user.role === 'designer') {
                const projectsSnapshot = await db.collection('projects')
                    .where('assignedDesignerUids', 'array-contains', req.user.uid)
                    .get();
                
                const proposalIds = projectsSnapshot.docs
                    .map(doc => doc.data().proposalId)
                    .filter(id => id);

                if (proposalIds.length > 0) {
                    const batchSize = 10;
                    for (let i = 0; i < proposalIds.length; i += batchSize) {
                        const batch = proposalIds.slice(i, i + batchSize);
                        const proposalsSnapshot = await db.collection('proposals')
                            .where(admin.firestore.FieldPath.documentId(), 'in', batch)
                            .get();
                        proposals.push(...proposalsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
                    }
                    proposals.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
                }
            }
            else {
                // COO, Director, Estimator, Accounts see all
                const query = db.collection('proposals').orderBy('createdAt', 'desc');
                const snapshot = await query.get();
                proposals = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            }
            
            return res.status(200).json({ success: true, data: proposals });
        }

        // Light read of every proposal for duplicate checks (project / client / P.O. number only).
        const proposalIndex = async () => (await db.collection('proposals')
            .select('projectName', 'clientCompany', 'status', 'poNumber', 'poDetails', 'createdByName').get())
            .docs.map(doc => ({ id: doc.id, ...doc.data() }));

        // ============================================
        // POST - Create proposal
        // ============================================
        if (req.method === 'POST') {
            const { 
                projectName, 
                clientCompany, 
                projectDescription,
                scopeOfWork,
                projectType,
                country,
                timeline,
                priority,
                projectComments,
                projectLinks, 
                services 
            } = req.body;

            // Accept either projectDescription or scopeOfWork
            const description = projectDescription || scopeOfWork;

            if (!projectName || !clientCompany || !description) {
                return res.status(400).json({ 
                    success: false, 
                    error: 'Missing required fields: projectName, clientCompany, and description are required' 
                });
            }

            // Block a second open proposal for the same project and client (double submits included).
            const duplicate = findDuplicateProposal(await proposalIndex(), { projectName, clientCompany });
            if (duplicate) {
                return res.status(409).json({ success: false, error: `A proposal for "${duplicate.projectName}" (${duplicate.clientCompany}) already exists` +
                    `${duplicate.createdByName ? ' by ' + duplicate.createdByName : ''} with status ${String(duplicate.status || 'draft').replace(/_/g, ' ')}. Open that proposal instead of creating a new one.`, duplicateId: duplicate.id });
            }

            const proposalData = {
                projectName,
                clientCompany,
                projectDescription: description,
                scopeOfWork: description, // Store in both fields for compatibility
                projectType: projectType || [],
                country: country || '',
                timeline: timeline || '',
                priority: priority || 'medium',
                projectComments: projectComments || '',
                projectLinks: projectLinks || [],
                services: services || [],
                status: 'draft',
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                createdByUid: req.user.uid,
                createdBy: req.user.email,
                createdByName: req.user.name,
                createdByRole: req.user.role,
                projectCreated: false,
                changeLog: [
                    { 
                        timestamp: new Date().toISOString(), 
                        action: 'created', 
                        performedByName: req.user.name, 
                        details: 'Proposal created' 
                    }
                ]
            };

            const proposalRef = await db.collection('proposals').add(proposalData);
            
            await db.collection('activities').add({
                type: 'proposal_created',
                details: `New proposal created: ${projectName}`,
                performedByName: req.user.name,
                performedByRole: req.user.role,
                performedByUid: req.user.uid,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                proposalId: proposalRef.id,
                projectName: projectName,
                clientCompany: clientCompany
            });

            // Notify COO, Director, Estimator (per EMAIL_RECIPIENT_MAP) plus
            // any STATIC_EXTRA_RECIPIENTS configured for proposal.created.
            sendEmailNotification('proposal.created', {
                projectName: projectName,
                clientName: clientCompany,
                createdBy: req.user.name,
                createdByEmail: req.user.email,
                proposalId: proposalRef.id
            }).catch(e => console.error('proposal.created email failed:', e.message));

            return res.status(201).json({
                success: true,
                message: 'Proposal created successfully',
                data: { id: proposalRef.id, ...proposalData }
            });
        }

        // ============================================
        // PUT - Update proposal
        // ============================================
        if (req.method === 'PUT') {
            const { id } = req.query;
            const { action, data } = req.body;
            
            if (!id) return res.status(400).json({ success: false, error: 'Missing proposal ID' });
            if (!action) return res.status(400).json({ success: false, error: 'Missing action parameter' });
            
            const proposalRef = db.collection('proposals').doc(id);
            const proposalDoc = await proposalRef.get();
            
            if (!proposalDoc.exists) return res.status(404).json({ success: false, error: 'Proposal not found' });
            
            const proposal = proposalDoc.data();
            let updates = {};
            let activityDetail = '';
            // Logged action name; a P.O. update through mark_won is recorded as update_po, not as another win.
            let logAction = action;
            
            switch (action) {
                case 'add_estimation':
                    if (req.user.role !== 'estimator') {
                        return res.status(403).json({ success: false, error: 'Only Estimators can add estimation' });
                    }
                    
                    // Validate: Must have either manhours OR tonnage (or both)
                    const manhours = parseFloat(data.manhours) || parseFloat(data.totalHours) || 0;
                    const tonnage = parseFloat(data.tonnage) || 0;
                    
                    if (!data || (manhours === 0 && tonnage === 0)) {
                        return res.status(400).json({ 
                            success: false, 
                            error: 'Missing estimation data: Please provide either manhours or tonnage' 
                        });
                    }
                    
                    if (!data.services || data.services.length === 0) {
                        return res.status(400).json({ 
                            success: false, 
                            error: 'Please select at least one service' 
                        });
                    }
                    
                    // Store breakdown if provided
                    const breakdown = {
                        designHours: parseFloat(data.designHours) || 0,
                        detailingHours: parseFloat(data.detailingHours) || 0,
                        checkingHours: parseFloat(data.checkingHours) || 0,
                        revisionHours: parseFloat(data.revisionHours) || 0,
                        pmHours: parseFloat(data.pmHours) || 0
                    };
                    
                    // ✅ CRITICAL FIX: Track if tonnage was used for design hours calculation
                    const usedTonnageForDesign = data.usedTonnageForDesign || false;
                    const tonnageValue = usedTonnageForDesign ? tonnage : null;
                    
                    updates = {
                        estimation: {
                            manhours: manhours,
                            totalHours: manhours, // Also store as totalHours for compatibility
                            tonnage: tonnage,
                            quoteNumber: (data.quoteNumber && String(data.quoteNumber).trim() !== '')
                                ? String(data.quoteNumber).trim()
                                : null,
                            
                            // ✅ NEW CRITICAL FIELDS FOR ALLOCATION LOGIC
                            usedTonnageForDesign: usedTonnageForDesign,  // Boolean flag
                            tonnageValue: tonnageValue,                   // Actual tonnage if used
                            
                            services: data.services || [],
                            estimatedBy: req.user.email,
                            estimatorName: req.user.name,
                            estimatedAt: admin.firestore.FieldValue.serverTimestamp(),
                            breakdown: breakdown,
                            notes: data.notes || ''
                        },
                        status: 'estimated'
                    };
                    
                    // Create activity detail based on what was provided
                    if (manhours > 0 && tonnage > 0) {
                        activityDetail = `Estimation added: ${manhours} manhours, ${tonnage} tons`;
                    } else if (manhours > 0) {
                        activityDetail = `Estimation added: ${manhours} manhours`;
                    } else {
                        activityDetail = `Estimation added: ${tonnage} tons`;
                    }
                    
                    try {
                        const cooSnapshot = await db.collection('users').where('role', '==', 'coo').limit(1).get();
                        if (!cooSnapshot.empty) {
                            const cooEmail = cooSnapshot.docs[0].data().email;
                            sendEmailNotification('estimation.complete', {
                                projectName: proposal.projectName,
                                estimatedBy: req.user.name,
                                manhours: data.manhours,
                                date: new Date().toLocaleDateString(),
                                cooEmail: cooEmail
                            }).catch(e => console.error('Email failed:', e.message));
                        }
                    } catch (e) { console.error('Error preparing estimation email:', e.message); }
                    
                    await db.collection('notifications').add({
                        type: 'estimation_complete',
                        recipientRole: 'coo',
                        proposalId: id,
                        message: `Estimation completed for "${proposal.projectName}" by ${req.user.name}`,
                        createdAt: admin.firestore.FieldValue.serverTimestamp(),
                        isRead: false,
                        priority: 'high'
                    });
                    break;

                case 'add_pricing':
                    if (!['estimator', 'coo', 'director'].includes(req.user.role)) {
                        return res.status(403).json({ success: false, error: 'Only Estimator, COO or Director can add pricing' });
                    }
                    if (!data || !data.projectNumber || !data.quoteValue) {
                        return res.status(400).json({ success: false, error: 'Missing pricing data' });
                    }
                    updates = {
                        pricing: {
                            projectNumber: data.projectNumber,
                            quoteNumber: data.quoteNumber || null,
                            quoteValue: parseFloat(data.quoteValue),
                            currency: data.currency || 'USD',
                            hourlyRate: data.hourlyRate ? parseFloat(data.hourlyRate) : null,
                            profitMargin: data.profitMargin ? parseFloat(data.profitMargin) : null,
                            notes: data.notes || '',
                            costBreakdown: data.costBreakdown || {},
                            pricedBy: req.user.email,
                            pricedByName: req.user.name,
                            pricedByRole: req.user.role,
                            pricedAt: admin.firestore.FieldValue.serverTimestamp()
                        },
                        status: 'pricing_complete'
                    };
                    activityDetail = `Pricing added: ${data.currency} ${data.quoteValue} (Project #: ${data.projectNumber}${data.quoteNumber ? ', Quote #: ' + data.quoteNumber : ''})`;

                    // Notify BOTH COO and Director — either one can approve
                    try {
                        const approverSnapshot = await db.collection('users').where('role', 'in', ['coo', 'director']).get();
                        const approverEmails = approverSnapshot.docs.map(d => d.data().email).filter(Boolean);
                        approverEmails.forEach(approverEmail => {
                            sendEmailNotification('pricing.complete', {
                                projectName: proposal.projectName,
                                quoteValue: `${data.currency} ${data.quoteValue}`,
                                projectNumber: data.projectNumber,
                                pricedBy: req.user.name,
                                date: new Date().toLocaleDateString(),
                                directorEmail: approverEmail,
                                cooEmail: approverEmail
                            }).catch(e => console.error('Pricing email failed:', e.message));
                        });
                    } catch (e) { console.error('Error preparing pricing email:', e.message); }

                    // In-app notifications to both COO and Director
                    await db.collection('notifications').add({
                        type: 'pricing_complete',
                        recipientRole: 'coo',
                        proposalId: id,
                        message: `Pricing completed for "${proposal.projectName}" by ${req.user.name} — awaiting approval`,
                        createdAt: admin.firestore.FieldValue.serverTimestamp(),
                        isRead: false,
                        priority: 'high'
                    });
                    await db.collection('notifications').add({
                        type: 'pricing_complete',
                        recipientRole: 'director',
                        proposalId: id,
                        message: `Pricing completed for "${proposal.projectName}" by ${req.user.name} — awaiting approval`,
                        createdAt: admin.firestore.FieldValue.serverTimestamp(),
                        isRead: false,
                        priority: 'high'
                    });
                    break;

                case 'update_pricing':
                    // Allow Estimator (who entered the pricing), COO or Director to edit existing pricing
                    if (!['estimator', 'coo', 'director'].includes(req.user.role)) {
                        return res.status(403).json({ success: false, error: 'Only Estimator, COO or Director can update pricing' });
                    }
                    
                    if (!data || !data.projectNumber || !data.quoteValue) {
                        return res.status(400).json({ success: false, error: 'Missing required pricing fields' });
                    }

                    // Check if proposal has pricing
                    if (!proposal.pricing) {
                        return res.status(400).json({ success: false, error: 'No existing pricing to update. Use add_pricing instead.' });
                    }
                    
                    // Check if proposal can be edited (not if it's already won/lost/allocated)
                    if (proposal.status === 'won' || proposal.status === 'lost') {
                        return res.status(400).json({ 
                            success: false, 
                            error: 'Cannot edit pricing for won/lost proposals' 
                        });
                    }
                    
                    if (proposal.allocationStatus === 'allocated') {
                        return res.status(400).json({ 
                            success: false, 
                            error: 'Cannot edit pricing after project allocation' 
                        });
                    }

                    // Store old pricing for history (optional)
                    const oldPricing = { ...proposal.pricing };

                    // Update pricing information
                    updates = {
                        pricing: {
                            projectNumber: data.projectNumber,
                            quoteNumber: (data.quoteNumber !== undefined && data.quoteNumber !== '')
                                ? data.quoteNumber
                                : (proposal.pricing.quoteNumber || null),
                            quoteValue: parseFloat(data.quoteValue),
                            currency: data.currency || 'USD',
                            hourlyRate: data.hourlyRate ? parseFloat(data.hourlyRate) : null,
                            profitMargin: data.profitMargin ? parseFloat(data.profitMargin) : null,
                            notes: data.notes || '',
                            costBreakdown: data.costBreakdown || {},
                            pricedBy: proposal.pricing.pricedBy || req.user.email, // Keep original pricer
                            pricedByName: proposal.pricing.pricedByName || req.user.name,
                            pricedAt: proposal.pricing.pricedAt || admin.firestore.FieldValue.serverTimestamp(),
                            lastEditedBy: req.user.email,
                            lastEditedByName: req.user.name,
                            lastEditedAt: admin.firestore.FieldValue.serverTimestamp()
                        }
                    };

                    activityDetail = `Pricing updated: ${data.currency} ${data.quoteValue} (Project #: ${data.projectNumber}) by ${req.user.name}`;
                    
                    // Optional: Store pricing edit history in a subcollection
                    try {
                        await db.collection('proposals').doc(id).collection('pricingHistory').add({
                            oldPricing: oldPricing,
                            newPricing: updates.pricing,
                            editedBy: req.user.email,
                            editedByName: req.user.name,
                            editedAt: admin.firestore.FieldValue.serverTimestamp(),
                            reason: data.editReason || 'No reason provided'
                        });
                    } catch (e) {
                        console.error('Error storing pricing history:', e.message);
                    }

                    // Send email notification about pricing update
                    try {
                        const directorSnapshot = await db.collection('users').where('role', '==', 'director').limit(1).get();
                        if (!directorSnapshot.empty) {
                            const directorEmail = directorSnapshot.docs[0].data().email;
                            sendEmailNotification('pricing.updated', {
                                projectName: proposal.projectName,
                                quoteValue: `${data.currency} ${data.quoteValue}`,
                                projectNumber: data.projectNumber,
                                editedBy: req.user.name,
                                date: new Date().toLocaleDateString(),
                                directorEmail: directorEmail
                            }).catch(e => console.error('Pricing update email failed:', e.message));
                        }
                        
                        // Also notify BDM
                        const bdmUserDoc = await db.collection('users').doc(proposal.createdByUid).get();
                        if (bdmUserDoc.exists) {
                            const bdmEmail = bdmUserDoc.data().email;
                            sendEmailNotification('pricing.updated', {
                                projectName: proposal.projectName,
                                quoteValue: `${data.currency} ${data.quoteValue}`,
                                projectNumber: data.projectNumber,
                                editedBy: req.user.name,
                                date: new Date().toLocaleDateString(),
                                createdByEmail: bdmEmail
                            }).catch(e => console.error('BDM pricing update email failed:', e.message));
                        }
                    } catch (e) { 
                        console.error('Error preparing pricing update email:', e.message); 
                    }
                    
                    // In-app notifications
                    await db.collection('notifications').add({
                        type: 'pricing_updated',
                        recipientRole: 'director',
                        proposalId: id,
                        message: `Pricing updated for "${proposal.projectName}" by ${req.user.name}`,
                        createdAt: admin.firestore.FieldValue.serverTimestamp(),
                        isRead: false,
                        priority: 'high'
                    });

                    await db.collection('notifications').add({
                        type: 'pricing_updated',
                        recipientUid: proposal.createdByUid,
                        recipientRole: 'bdm',
                        proposalId: id,
                        message: `Pricing updated for your proposal "${proposal.projectName}"`,
                        createdAt: admin.firestore.FieldValue.serverTimestamp(),
                        isRead: false,
                        priority: 'normal'
                    });
                    break;

                case 'submit_to_client':
                    if (req.user.role !== 'bdm' || proposal.createdByUid !== req.user.uid) {
                        return res.status(403).json({ success: false, error: 'Only the BDM who created this proposal can submit it to the client' });
                    }
                    if (proposal.status !== 'approved') {
                        return res.status(400).json({ success: false, error: 'Only approved proposals can be submitted to client' });
                    }
                    updates = { 
                        status: 'submitted_to_client',
                        submittedToClientAt: admin.firestore.FieldValue.serverTimestamp()
                    };
                    activityDetail = 'Proposal submitted to client';
                    break;

                case 'mark_won': {
                    if (req.user.role !== 'bdm' || proposal.createdByUid !== req.user.uid) {
                        return res.status(403).json({ success: false, error: 'Only the BDM who created this proposal can mark it as won' });
                    }
                    // Required PO basics
                    const poNumber = (data && data.poNumber) ? String(data.poNumber).trim() : '';
                    const poValueRaw = data ? data.poValue : undefined;
                    const poValue = (poValueRaw !== undefined && poValueRaw !== null && poValueRaw !== '') ? parseFloat(poValueRaw) : NaN;
                    const poCurrency = (data && data.poCurrency) ? String(data.poCurrency).trim().toUpperCase() : 'USD';
                    if (!poNumber) {
                        return res.status(400).json({ success: false, error: 'P.O. Number is required to mark proposal as won' });
                    }
                    if (isNaN(poValue) || poValue <= 0) {
                        return res.status(400).json({ success: false, error: 'Valid P.O. Value is required' });
                    }
                    // A proposal is marked won once. Later calls (the "Update P.O." button) only change the
                    // P.O. details and keep the original won date; a repeated "Won" click is refused.
                    const isPoUpdate = proposal.status === 'won';
                    if (isPoUpdate && !(data && data.poUpdated)) {
                        return res.status(409).json({ success: false, error: 'This proposal is already marked as WON. Use "Update P.O." to change the P.O. details or "Edit won date" to change the date.' });
                    }
                    const samePo = findDuplicatePo(await proposalIndex(), poNumber, id);
                    if (samePo) {
                        return res.status(409).json({ success: false, error: `P.O. number ${poNumber} is already recorded on the won proposal "${samePo.projectName}". Each P.O. can be entered once.` });
                    }
                    let chosenWonDate = null;
                    if (!isPoUpdate && data && data.wonDate) {
                        const parsed = parseWonDate(data.wonDate);
                        if (parsed.error) return res.status(400).json({ success: false, error: parsed.error });
                        chosenWonDate = parsed.date;
                    }

                    // Optional extras supplied by BDM (tracking + attachment)
                    const trackingNumber = (data && data.trackingNumber) ? String(data.trackingNumber).trim() : '';
                    const attachmentUrl = (data && data.attachmentUrl) ? String(data.attachmentUrl) : '';
                    const attachmentName = (data && data.attachmentName) ? String(data.attachmentName) : '';
                    const attachmentFileId = (data && data.attachmentFileId) ? String(data.attachmentFileId) : '';

                    const poDetails = {
                        poNumber: poNumber,
                        value: poValue,
                        currency: poCurrency,
                        trackingNumber: trackingNumber,
                        attachmentUrl: attachmentUrl,
                        attachmentName: attachmentName,
                        attachmentFileId: attachmentFileId,
                        uploadedBy: req.user.email,
                        uploadedByName: req.user.name,
                        uploadedAt: new Date().toISOString()
                    };

                    if (isPoUpdate) {
                        updates = {
                            poNumber: poNumber,
                            poValue: poValue,
                            poCurrency: poCurrency,
                            poDetails: poDetails,
                            hasPO: true,
                            poUpdatedBy: req.user.name,
                            poUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
                        };
                        activityDetail = `P.O. details updated (P.O. ${poNumber}, ${poCurrency} ${poValue})`;
                        logAction = 'update_po';
                        break;
                    }

                    updates = {
                        status: 'won',
                        wonDate: chosenWonDate ? admin.firestore.Timestamp.fromDate(chosenWonDate) : admin.firestore.FieldValue.serverTimestamp(),
                        poNumber: poNumber,
                        poValue: poValue,
                        poCurrency: poCurrency,
                        poAddedBy: req.user.name,
                        poAddedByUid: req.user.uid,
                        poAddedAt: admin.firestore.FieldValue.serverTimestamp(),
                        poDetails: poDetails,
                        hasPO: true
                    };
                    activityDetail = `Proposal marked as WON (P.O. ${poNumber}, ${poCurrency} ${poValue})`;

                    // Send Project Won email to COO & Director
                    try {
                        sendEmailNotification('project.won', {
                            projectName: proposal.projectName,
                            clientName: proposal.clientName || proposal.clientCompany || '',
                            quoteValue: proposal.pricing?.quoteValue || '',
                            poNumber: poNumber,
                            poValue: poValue,
                            poCurrency: poCurrency,
                            createdBy: req.user.name,
                            bdmName: req.user.name,
                            proposalId: id
                        }).catch(e => console.error('Project won email failed:', e.message));
                    } catch (e) { console.error('Error preparing project won email:', e.message); }

                    break;
                }

                case 'update_won_date': {
                    // The BDM who won the proposal (or COO / Director) corrects the won date; history is kept.
                    // No email is sent: the "Project won" email goes out only when the proposal is first marked won.
                    if (!((req.user.role === 'bdm' && proposal.createdByUid === req.user.uid) || ['coo', 'director'].includes(req.user.role))) {
                        return res.status(403).json({ success: false, error: 'Only the BDM who won this proposal, COO or Director can change the won date' });
                    }
                    if (proposal.status !== 'won') {
                        return res.status(400).json({ success: false, error: 'Only a WON proposal has a won date to edit' });
                    }
                    const parsed = parseWonDate(data && data.wonDate);
                    if (parsed.error) return res.status(400).json({ success: false, error: parsed.error });
                    const toDay = ts => ts && (ts.toDate ? ts.toDate() : new Date(ts._seconds != null ? ts._seconds * 1000 : ts.seconds != null ? ts.seconds * 1000 : ts));
                    const previous = toDay(proposal.wonDate);
                    const previousText = previous && Number.isFinite(previous.getTime()) ? previous.toISOString().slice(0, 10) : 'not set';
                    if (previousText === parsed.text) {
                        return res.status(400).json({ success: false, error: 'The won date is already ' + parsed.text });
                    }
                    updates = {
                        wonDate: admin.firestore.Timestamp.fromDate(parsed.date),
                        wonDateEdited: true,
                        wonDateEditedBy: req.user.name,
                        wonDateEditedAt: admin.firestore.FieldValue.serverTimestamp(),
                        wonDateHistory: admin.firestore.FieldValue.arrayUnion({ from: previousText, to: parsed.text, by: req.user.name, at: new Date().toISOString() })
                    };
                    activityDetail = `Won date changed from ${previousText} to ${parsed.text}`;
                    break;
                }

                case 'remove_won_click': {
                    // Remove one recorded "Won" click (data.timestamp). Removing the last one undoes the win.
                    if (!((req.user.role === 'bdm' && proposal.createdByUid === req.user.uid) || ['coo', 'director'].includes(req.user.role))) {
                        return res.status(403).json({ success: false, error: 'Only the BDM who won this proposal, COO or Director can remove a WON entry' });
                    }
                    if (proposal.status !== 'won') {
                        return res.status(400).json({ success: false, error: 'This proposal is not marked as WON' });
                    }
                    const log = Array.isArray(proposal.changeLog) ? proposal.changeLog : [];
                    const target = data && data.timestamp ? log.find(e => e && e.action === 'mark_won' && e.timestamp === data.timestamp) : null;
                    if (data && data.timestamp && !target) {
                        return res.status(404).json({ success: false, error: 'That WON entry was not found; refresh and try again' });
                    }
                    const remaining = log.filter(e => e && e.action === 'mark_won' && e !== target);
                    const undo = !remaining.length;
                    if (undo && proposal.projectCreated && proposal.projectId) {
                        return res.status(409).json({ success: false, error: 'A project has already been created from this win, so it cannot be undone here. Ask the COO or Director.' });
                    }
                    const fmt = iso => (iso ? String(iso).slice(0, 16).replace('T', ' ') : 'unrecorded');
                    activityDetail = undo
                        ? `WON removed${target ? ` (click of ${fmt(target.timestamp)})` : ''}; proposal returned to ${proposal.submittedToClientAt ? 'submitted to client' : 'approved'}`
                        : `Repeat WON entry of ${fmt(target.timestamp)} removed`;
                    // The full log is rewritten here, so the generic log append below is skipped for this action.
                    updates.changeLog = log.filter(e => e !== target).concat({ timestamp: new Date().toISOString(), action: 'remove_won_click', performedByName: req.user.name, details: activityDetail });
                    if (undo) {
                        const del = admin.firestore.FieldValue.delete();
                        Object.assign(updates, { status: proposal.submittedToClientAt ? 'submitted_to_client' : 'approved',
                            wonDate: del, poNumber: del, poValue: del, poCurrency: del, poDetails: del, hasPO: del, poAddedBy: del, poAddedByUid: del, poAddedAt: del,
                            wonDateEdited: del, wonDateEditedBy: del, wonDateEditedAt: del, wonRemovedBy: req.user.name, wonRemovedAt: admin.firestore.FieldValue.serverTimestamp() });
                    } else if (!proposal.wonDateEdited) {
                        // The won date follows the earliest remaining click (a repeat click had reset it), unless the BDM set it by hand.
                        const first = remaining.map(e => e.timestamp).sort()[0];
                        const firstDate = new Date(first);
                        if (Number.isFinite(firstDate.getTime())) updates.wonDate = admin.firestore.Timestamp.fromDate(firstDate);
                    }
                    break;
                }

                case 'mark_lost':
                    if (req.user.role !== 'bdm' || proposal.createdByUid !== req.user.uid) {
                        return res.status(403).json({ success: false, error: 'Only the BDM who created this proposal can mark it as lost' });
                    }
                    updates = { 
                        status: 'lost',
                        lostDate: admin.firestore.FieldValue.serverTimestamp(),
                        lostReason: data?.reason || ''
                    };
                    activityDetail = 'Proposal marked as LOST';
                    break;

                case 'update_basic_info':
                    if (proposal.createdByUid !== req.user.uid && !['coo', 'director'].includes(req.user.role)) {
                        return res.status(403).json({ success: false, error: 'You are not authorized to edit this proposal' });
                    }
                    if (proposal.allocationStatus === 'allocated') {
                        return res.status(400).json({ success: false, error: 'Cannot edit an allocated proposal' });
                    }
                    
                    // Accept both projectDescription and scopeOfWork
                    const description = data.projectDescription || data.scopeOfWork;
                    
                    updates = {
                        projectName: data.projectName || proposal.projectName,
                        clientCompany: data.clientCompany || proposal.clientCompany,
                        projectDescription: description || proposal.projectDescription || proposal.scopeOfWork,
                        scopeOfWork: description || proposal.scopeOfWork || proposal.projectDescription,
                        projectType: data.projectType || proposal.projectType || [],
                        country: data.country || proposal.country || '',
                        timeline: data.timeline || proposal.timeline || '',
                        priority: data.priority || proposal.priority || 'medium',
                        projectComments: data.projectComments || proposal.projectComments || '',
                        projectLinks: data.projectLinks || proposal.projectLinks || [],
                        services: data.services || proposal.services || []
                    };
                    // Renaming must not turn this proposal into a copy of another open one.
                    const renamedDuplicate = findDuplicateProposal(await proposalIndex(), updates, id);
                    if (renamedDuplicate) {
                        return res.status(409).json({ success: false, error: `Another proposal for "${renamedDuplicate.projectName}" (${renamedDuplicate.clientCompany}) already exists. Use that proposal instead.` });
                    }
                    activityDetail = `Proposal updated: ${updates.projectName}`;
                    break;

                case 'approve_proposal':
                    // Either COO or Director can approve — single approval is enough
                    if (!['coo', 'director'].includes(req.user.role)) {
                        return res.status(403).json({ success: false, error: 'Only COO or Director can approve proposals' });
                    }
                    if (proposal.status === 'approved') {
                        return res.status(400).json({ success: false, error: 'Proposal is already approved' });
                    }
                    {
                        const approverRoleLabel = req.user.role === 'coo' ? 'COO' : 'Director';
                        const approvalRecord = {
                            approved: true,
                            approvedBy: req.user.name,
                            approvedByUid: req.user.uid,
                            approvedByRole: req.user.role,
                            approvedAt: admin.firestore.FieldValue.serverTimestamp(),
                            comments: data?.comments || ''
                        };
                        updates = {
                            status: 'approved',
                            approval: approvalRecord,
                            // Keep directorApproval for backward compatibility with existing frontend code
                            directorApproval: approvalRecord
                        };
                        activityDetail = `Proposal approved by ${approverRoleLabel} ${req.user.name}`;

                        // Email trigger to BDM
                        try {
                            const bdmUserDoc = await db.collection('users').doc(proposal.createdByUid).get();
                            if (bdmUserDoc.exists) {
                                const bdmEmail = bdmUserDoc.data().email;
                                sendEmailNotification('project.approved_by_director', {
                                    projectName: proposal.projectName,
                                    approvedBy: req.user.name,
                                    approvedByRole: approverRoleLabel,
                                    date: new Date().toLocaleDateString(),
                                    estimatedValue: `${proposal.pricing?.currency || ''} ${proposal.pricing?.quoteValue || 'N/A'}`,
                                    createdByEmail: bdmEmail
                                }).catch(e => console.error('Approval email failed:', e.message));
                            }
                        } catch (e) { console.error('Error preparing approval email:', e.message); }

                        // In-app notification to BDM — they can now do won/lost entry & quote submission
                        await db.collection('notifications').add({
                            type: 'proposal_approved',
                            recipientUid: proposal.createdByUid,
                            recipientRole: 'bdm',
                            proposalId: id,
                            message: `Your proposal "${proposal.projectName}" has been approved by ${approverRoleLabel} ${req.user.name}. You can now submit the quote and record won/lost.`,
                            createdAt: admin.firestore.FieldValue.serverTimestamp(),
                            isRead: false,
                            priority: 'high'
                        });
                    }
                    break;

                case 'reject_proposal':
                    // Either COO or Director can reject
                    if (!['coo', 'director'].includes(req.user.role)) {
                        return res.status(403).json({ success: false, error: 'Only COO or Director can reject proposals' });
                    }
                    {
                        const rejecterRoleLabel = req.user.role === 'coo' ? 'COO' : 'Director';
                        const rejectionRecord = {
                            approved: false,
                            rejectedBy: req.user.name,
                            rejectedByUid: req.user.uid,
                            rejectedByRole: req.user.role,
                            rejectedAt: admin.firestore.FieldValue.serverTimestamp(),
                            reason: data.reason,
                            comments: data.comments || ''
                        };
                        updates = {
                            status: 'rejected',
                            approval: rejectionRecord,
                            directorApproval: rejectionRecord
                        };
                        activityDetail = `Proposal rejected by ${rejecterRoleLabel} ${req.user.name}: ${data.reason}`;
                        await db.collection('notifications').add({
                            type: 'proposal_rejected',
                            recipientUid: proposal.createdByUid,
                            recipientRole: 'bdm',
                            proposalId: id,
                            message: `Your proposal "${proposal.projectName}" was rejected by ${rejecterRoleLabel}. Reason: ${data.reason}`,
                            createdAt: admin.firestore.FieldValue.serverTimestamp(),
                            isRead: false,
                            priority: 'high'
                        });
                    }
                    break;

                case 'update_allocation_status':
                    if (!['coo', 'director'].includes(req.user.role)) {
                        return res.status(403).json({ success: false, error: 'Only COO or Director can update allocation status' });
                    }
                    updates = {
                        allocationStatus: data.allocationStatus || 'allocated',
                        designLeadName: data.designLeadName || null,
                        designLeadUid: data.designLeadUid || null,
                        allocatedAt: data.allocatedAt || admin.firestore.FieldValue.serverTimestamp(),
                        allocatedBy: req.user.name,
                        allocatedByUid: req.user.uid
                    };
                    activityDetail = `Project allocated to Design Manager: ${data.designLeadName}`;
                    break;

                case 'mark_subcontractor':
                    if (req.user.role !== 'estimator') {
                        return res.status(403).json({ success: false, error: 'Only Estimators can mark proposals as subcontractor' });
                    }

                    const subcontractorName = (data && data.subcontractorName) ? data.subcontractorName.trim() : '';
                    if (!subcontractorName) {
                        return res.status(400).json({ success: false, error: 'Subcontractor name is required' });
                    }

                    updates = {
                        subcontractor: true,
                        subcontractorDetails: {
                            name: subcontractorName,
                            notes: (data && data.notes) ? data.notes : '',
                            markedBy: req.user.email,
                            markedByName: req.user.name,
                            markedAt: admin.firestore.FieldValue.serverTimestamp()
                        },
                        status: 'subcontracted'
                    };
                    activityDetail = `Proposal marked as subcontractor project — Subcontractor: ${subcontractorName}`;

                    // Notify COO about subcontractor assignment
                    try {
                        await db.collection('notifications').add({
                            type: 'subcontractor_assigned',
                            recipientRole: 'coo',
                            proposalId: id,
                            message: `"${proposal.projectName}" marked as subcontractor project (${subcontractorName}) by ${req.user.name}`,
                            createdAt: admin.firestore.FieldValue.serverTimestamp(),
                            isRead: false,
                            priority: 'normal'
                        });
                    } catch (e) { console.error('Error creating subcontractor notification:', e.message); }
                    break;

                default:
                    return res.status(400).json({ success: false, error: 'Invalid action: ' + action });
            }
            
            if (!updates.changeLog) updates.changeLog = admin.firestore.FieldValue.arrayUnion({ 
                timestamp: new Date().toISOString(), 
                action: logAction, 
                performedByName: req.user.name, 
                details: activityDetail || `${logAction.replace(/_/g, ' ')} completed` 
            });
            updates.updatedAt = admin.firestore.FieldValue.serverTimestamp();
            
            await proposalRef.update(updates);
            
            await db.collection('activities').add({
                type: `proposal_${logAction}`, 
                details: activityDetail, 
                performedByName: req.user.name, 
                performedByRole: req.user.role,
                performedByUid: req.user.uid,
                timestamp: admin.firestore.FieldValue.serverTimestamp(), 
                proposalId: id, 
                projectName: proposal.projectName, 
                clientCompany: proposal.clientCompany
            });
            
            return res.status(200).json({ success: true, message: 'Proposal updated successfully' });
        }

        // ============================================
        // DELETE - Delete proposal
        // ============================================
        if (req.method === 'DELETE') {
            const { id } = req.query;
            if (!id) return res.status(400).json({ success: false, error: 'Missing proposal ID' });

            const proposalRef = db.collection('proposals').doc(id);
            const proposalDoc = await proposalRef.get();
            
            if (!proposalDoc.exists) return res.status(404).json({ success: false, error: 'Proposal not found' });
            
            const proposalData = proposalDoc.data();
            if (proposalData.createdByUid !== req.user.uid && req.user.role !== 'director') {
                return res.status(403).json({ success: false, error: 'You are not authorized to delete this proposal.' });
            }
            // A won proposal that already became a project is not deleted from here (the project would be orphaned).
            if (proposalData.projectCreated && proposalData.projectId && req.user.role !== 'director') {
                return res.status(409).json({ success: false, error: 'A project has already been created from this proposal. Ask the COO or Director to remove it.' });
            }

            const filesSnapshot = await db.collection('files').where('proposalId', '==', id).get();
            if (!filesSnapshot.empty) {
                const deletePromises = filesSnapshot.docs.map(doc => {
                    const fileData = doc.data();
                    if (fileData.fileType === 'link') return doc.ref.delete();
                    return Promise.all([
                        bucket.file(fileData.fileName).delete().catch(() => {}),
                        doc.ref.delete()
                    ]);
                });
                await Promise.all(deletePromises);
            }

            await proposalRef.delete();
            await db.collection('activities').add({
                type: 'proposal_deleted',
                details: `Proposal deleted: ${proposalData.projectName}`,
                performedByName: req.user.name,
                performedByRole: req.user.role,
                performedByUid: req.user.uid,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                proposalId: id
            });
            
            return res.status(200).json({ success: true, message: 'Proposal and all associated files deleted successfully' });
        }

        return res.status(405).json({ success: false, error: 'Method not allowed' });
        
    } catch (error) {
        console.error('Proposals API error:', error);
        return res.status(500).json({ success: false, error: 'Internal Server Error', message: error.message });
    }
};

module.exports = allowCors(handler);
