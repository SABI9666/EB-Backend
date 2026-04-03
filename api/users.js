// api/users.js - User management API
const admin = require('./_firebase-admin');
const { verifyToken } = require('../middleware/auth');
const util = require('util');

const db = admin.firestore();

const allowCors = fn => async (req, res) => {
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST,PUT,PATCH');
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

        // ============================================
        // GET - Retrieve single user OR users by role
        // ============================================
        if (req.method === 'GET') {
            const { role, includeInactive, id } = req.query;

            // --- MERGED: Get single user by ID ---
            if (id) {
                const userDoc = await db.collection('users').doc(id).get();
                
                if (!userDoc.exists) {
                    return res.status(404).json({ 
                        success: false, 
                        error: 'User not found' 
                    });
                }
                
                const userData = userDoc.data();
                // Return safe data, consistent with list view
                const safeData = {
                    uid: userDoc.id,
                    name: userData.name,
                    email: userData.email,
                    role: userData.role,
                    status: userData.status || 'active',
                    department: userData.department || '',
                    joinDate: userData.joinDate || null,
                    ...(userData.role === 'design_lead' && {
                        activeProjects: userData.activeProjects || 0
                    }),
                    ...(userData.role === 'designer' && {
                        assignedProjects: userData.assignedProjects || 0
                    })
                };
                
                return res.status(200).json({
                    success: true,
                    data: safeData
                });
            }
            // --- END MERGE ---
            
            // --- Get user list (from uploaded file) ---
            
            // Only COO, Director, Design Lead, and Accounts can fetch users list
            if (!['coo', 'director', 'design_lead', 'accounts'].includes(req.user.role)) {
                return res.status(403).json({ 
                    success: false, 
                    error: 'You do not have permission to view users' 
                });
            }
            
            let query = db.collection('users');
            
            // Filter by role if specified
            if (role) {
                // Validate role
                const validRoles = ['bdm', 'estimator', 'coo', 'director', 'design_lead', 'designer', 'accounts'];
                if (!validRoles.includes(role)) {
                    return res.status(400).json({ 
                        success: false, 
                        error: 'Invalid role specified' 
                    });
                }
                query = query.where('role', '==', role);
            }
            
            // Filter out inactive users unless specifically requested
            if (!includeInactive || includeInactive !== 'true') {
                query = query.where('status', '==', 'active');
            }
            
            const snapshot = await query.get();
            const users = [];
            const addedUids = new Set();

            snapshot.docs.forEach(doc => {
                const userData = doc.data();
                addedUids.add(doc.id);
                // Don't send sensitive data
                users.push({
                    uid: doc.id,
                    name: userData.name,
                    email: userData.email,
                    role: userData.role,
                    status: userData.status || 'active',
                    department: userData.department || '',
                    joinDate: userData.joinDate || null,
                    // For Design Leads and Designers, include project counts
                    ...(userData.role === 'design_lead' && {
                        activeProjects: userData.activeProjects || 0
                    }),
                    ...(userData.role === 'designer' && {
                        assignedProjects: userData.assignedProjects || 0
                    })
                });
            });

            // When fetching design_lead role, also include known design lead emails
            // that may still have 'designer' role in Firestore (force-mapped on frontend)
            if (role === 'design_lead') {
                const DESIGN_LEAD_EMAILS = [
                    'muruganantham.tech@edanbrook.in',
                    'kathar.tech@edanbrook.in',
                    'aravindhan.tech@edanbrook.in',
                    'sathish.tech@edanbrook.in',
                    'rebar.lead@edanbrook.com',
                    'rebar.lead1@edanbrook.com'
                ];
                // Fetch all active users and check emails
                const allUsersSnapshot = await db.collection('users')
                    .where('status', '==', 'active')
                    .get();
                allUsersSnapshot.docs.forEach(doc => {
                    if (addedUids.has(doc.id)) return; // Skip already added
                    const userData = doc.data();
                    const email = (userData.email || '').toLowerCase().trim();
                    if (DESIGN_LEAD_EMAILS.includes(email)) {
                        addedUids.add(doc.id);
                        users.push({
                            uid: doc.id,
                            name: userData.name,
                            email: userData.email,
                            role: 'design_lead', // Override to design_lead
                            status: userData.status || 'active',
                            department: userData.department || '',
                            joinDate: userData.joinDate || null,
                            activeProjects: userData.activeProjects || 0
                        });
                    }
                });
            }
            
            // Sort users by name
            users.sort((a, b) => a.name.localeCompare(b.name));
            
            return res.status(200).json({ 
                success: true, 
                data: users,
                count: users.length
            });
        }

        // ============================================
        // POST - Create new user (admin only)
        // ============================================
        if (req.method === 'POST') {
            
            // --- MERGED: Manual body parser for serverless ---
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
            // --- END MERGE ---
            
            // Only Director can create users
            if (req.user.role !== 'director') {
                return res.status(403).json({ 
                    success: false, 
                    error: 'Only Director can create users' 
                });
            }
            
            const { email, name, role, department, password } = req.body;
            
            // Validate required fields
            if (!email || !name || !role || !password) {
                return res.status(400).json({ 
                    success: false, 
                    error: 'Missing required fields: email, name, role, password' 
                });
            }
            
            // Validate role
            const validRoles = ['bdm', 'estimator', 'coo', 'director', 'design_lead', 'designer', 'accounts'];
            if (!validRoles.includes(role)) {
                return res.status(400).json({ 
                    success: false, 
                    error: 'Invalid role specified' 
                });
            }
            
            try {
                // Create authentication user
                const userRecord = await admin.auth().createUser({
                    email: email,
                    password: password,
                    displayName: name,
                    emailVerified: false
                });
                
                // Create user document in Firestore
                const userData = {
                    name: name,
                    email: email,
                    role: role,
                    department: department || '',
                    status: 'active',
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    createdBy: req.user.name,
                    createdByUid: req.user.uid,
                    joinDate: new Date().toISOString(),
                    activeProjects: 0,
                    assignedProjects: 0
                };
                
                await db.collection('users').doc(userRecord.uid).set(userData);
                
                // Log activity
                await db.collection('activities').add({
                    type: 'user_created',
                    details: `New ${role} user created: ${name} (${email})`,
                    performedByName: req.user.name,
                    performedByRole: req.user.role,
                    performedByUid: req.user.uid,
                    timestamp: admin.firestore.FieldValue.serverTimestamp()
                });
                
                return res.status(201).json({ 
                    success: true, 
                    data: {
                        uid: userRecord.uid,
                        ...userData
                    },
                    message: 'User created successfully' 
                });
                
            } catch (authError) {
                console.error('Error creating user:', authError);
                return res.status(400).json({ 
                    success: false, 
                    error: authError.message 
                });
            }
        }

        // ============================================
        // PUT - Update user status or role
        // ============================================
        if (req.method === 'PUT') {
            
            // --- ADDED: Manual body parser for serverless ---
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
            // --- END ADD ---

            // Only Director can update users
            if (req.user.role !== 'director') {
                return res.status(403).json({ 
                    success: false, 
                    error: 'Only Director can update users' 
                });
            }
            
            const { uid } = req.query;
            const { status, role, department } = req.body;
            
            if (!uid) {
                return res.status(400).json({ 
                    success: false, 
                    error: 'User UID is required' 
                });
            }
            
            const userRef = db.collection('users').doc(uid);
            const userDoc = await userRef.get();
            
            if (!userDoc.exists) {
                return res.status(44).json({ 
                    success: false, 
                    error: 'User not found' 
                });
            }
            
            const updates = {};
            
            if (status) {
                if (!['active', 'inactive', 'suspended'].includes(status)) {
                    return res.status(400).json({ 
                        success: false, 
                        error: 'Invalid status. Must be: active, inactive, or suspended' 
                    });
                }
                updates.status = status;
                
                // If suspending/deactivating user, also disable their auth account
                if (status !== 'active') {
                    await admin.auth().updateUser(uid, { disabled: true });
                } else {
                    await admin.auth().updateUser(uid, { disabled: false });
                }
            }
            
            if (role) {
                const validRoles = ['bdm', 'estimator', 'coo', 'director', 'design_lead', 'designer', 'accounts'];
                if (!validRoles.includes(role)) {
                    return res.status(400).json({ 
                        success: false, 
                        error: 'Invalid role specified' 
                    });
                }
                updates.role = role;
            }
            
            if (department !== undefined) {
                updates.department = department;
            }
            
            updates.updatedAt = admin.firestore.FieldValue.serverTimestamp();
            updates.updatedBy = req.user.name;
            updates.updatedByUid = req.user.uid;
            
            await userRef.update(updates);
            
            // Log activity
            const updateDetails = [];
            if (status) updateDetails.push(`status: ${status}`);
            if (role) updateDetails.push(`role: ${role}`);
            if (department !== undefined) updateDetails.push(`department: ${department}`);
            
            await db.collection('activities').add({
                type: 'user_updated',
                details: `User ${userDoc.data().name} updated - ${updateDetails.join(', ')}`,
                performedByName: req.user.name,
                performedByRole: req.user.role,
                performedByUid: req.user.uid,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
            
            return res.status(200).json({ 
                success: true, 
                message: 'User updated successfully' 
            });
        }

        // ============================================
        // PATCH - Migrate/transfer documents from old UID to new UID
        // Used when a user is deleted and re-registered with a new UID
        // ============================================
        if (req.method === 'PATCH') {
            // Only Director or specific admin emails can perform UID migration
            const ADMIN_EMAILS = ['director@edanbrook.com', 'ajit@edanbrook.com', 'sabin@edanbrook.com'];
            if (req.user.role !== 'director' && !ADMIN_EMAILS.includes((req.user.email || '').toLowerCase())) {
                return res.status(403).json({
                    success: false,
                    error: 'Only Director or admin can perform UID migration'
                });
            }

            if (!req.body || Object.keys(req.body).length === 0) {
                await new Promise((resolve) => {
                    const chunks = [];
                    req.on('data', (chunk) => chunks.push(chunk));
                    req.on('end', () => {
                        try {
                            const bodyBuffer = Buffer.concat(chunks);
                            req.body = bodyBuffer.length > 0 ? JSON.parse(bodyBuffer.toString()) : {};
                        } catch (e) {
                            req.body = {};
                        }
                        resolve();
                    });
                });
            }

            const { oldUid, newUid, email } = req.body;

            let resolvedOldUid = oldUid;
            let resolvedNewUid = newUid;

            // Auto-detect UIDs from email
            if (email && (!resolvedOldUid || !resolvedNewUid)) {
                const emailLower = email.toLowerCase();

                // Find NEW UID: the current user doc in Firestore with this email
                if (!resolvedNewUid) {
                    const newUserSnap = await db.collection('users').where('email', '==', emailLower).limit(1).get();
                    if (!newUserSnap.empty) {
                        resolvedNewUid = newUserSnap.docs[0].id;
                    }
                    // Also check Firebase Auth
                    if (!resolvedNewUid) {
                        try {
                            const authUser = await admin.auth().getUserByEmail(emailLower);
                            resolvedNewUid = authUser.uid;
                        } catch (e) { /* user not found in auth */ }
                    }
                }

                // Find OLD UID: scan proposals, projects, activities for this email
                if (!resolvedOldUid) {
                    console.log(`🔍 Searching for old UID for email: ${emailLower}`);

                    // Method 1: Check proposals where createdBy (email field) matches
                    const proposalsByEmail = await db.collection('proposals')
                        .where('createdBy', '==', emailLower).limit(1).get();
                    if (!proposalsByEmail.empty) {
                        const foundUid = proposalsByEmail.docs[0].data().createdByUid;
                        if (foundUid !== resolvedNewUid) {
                            resolvedOldUid = foundUid;
                            console.log(`✅ Found old UID from proposals.createdBy: ${resolvedOldUid}`);
                        }
                    }

                    // Method 2: Check proposals where createdByEmail matches
                    if (!resolvedOldUid) {
                        const proposalsByEmail2 = await db.collection('proposals')
                            .where('createdByEmail', '==', emailLower).limit(1).get();
                        if (!proposalsByEmail2.empty) {
                            const foundUid = proposalsByEmail2.docs[0].data().createdByUid;
                            if (foundUid !== resolvedNewUid) {
                                resolvedOldUid = foundUid;
                                console.log(`✅ Found old UID from proposals.createdByEmail: ${resolvedOldUid}`);
                            }
                        }
                    }

                    // Method 3: Check projects where bdmEmail matches
                    if (!resolvedOldUid) {
                        const projectsByEmail = await db.collection('projects')
                            .where('bdmEmail', '==', emailLower).limit(1).get();
                        if (!projectsByEmail.empty) {
                            const foundUid = projectsByEmail.docs[0].data().bdmUid;
                            if (foundUid && foundUid !== resolvedNewUid) {
                                resolvedOldUid = foundUid;
                                console.log(`✅ Found old UID from projects.bdmEmail: ${resolvedOldUid}`);
                            }
                        }
                    }

                    // Method 4: Check payments where bdmEmail matches
                    if (!resolvedOldUid) {
                        const paymentsByEmail = await db.collection('payments')
                            .where('bdmEmail', '==', emailLower).limit(1).get();
                        if (!paymentsByEmail.empty) {
                            const foundUid = paymentsByEmail.docs[0].data().bdmUid;
                            if (foundUid && foundUid !== resolvedNewUid) {
                                resolvedOldUid = foundUid;
                                console.log(`✅ Found old UID from payments.bdmEmail: ${resolvedOldUid}`);
                            }
                        }
                    }

                    // Method 5: Brute force - scan ALL proposals for orphaned UIDs
                    if (!resolvedOldUid) {
                        console.log('🔍 Brute force scan: checking all proposals for orphaned UIDs...');
                        const allProposalsSnap = await db.collection('proposals').get();
                        const checkedUids = new Set();
                        for (const doc of allProposalsSnap.docs) {
                            const data = doc.data();
                            const uid = data.createdByUid;
                            if (!uid || uid === resolvedNewUid || checkedUids.has(uid)) continue;
                            checkedUids.add(uid);

                            // Check if this UID still exists in users collection
                            const userDoc = await db.collection('users').doc(uid).get();
                            if (!userDoc.exists) {
                                // Orphaned UID found - check if name/email hints match
                                const createdByField = (data.createdBy || '').toLowerCase();
                                const createdByName = (data.createdByName || '').toLowerCase();
                                const emailPrefix = emailLower.split('@')[0];

                                if (createdByField === emailLower ||
                                    createdByField.includes(emailPrefix) ||
                                    createdByName.includes(emailPrefix) ||
                                    emailPrefix.includes(createdByName.split(' ')[0])) {
                                    resolvedOldUid = uid;
                                    console.log(`✅ Found old UID via brute force (name/email match): ${resolvedOldUid}`);
                                    break;
                                }
                            }
                        }

                        // If still not found, just take the first orphaned UID that has proposals
                        if (!resolvedOldUid && checkedUids.size > 0) {
                            // Return all orphaned UIDs so user can pick
                            const orphanedUids = [];
                            for (const uid of checkedUids) {
                                const userDoc = await db.collection('users').doc(uid).get();
                                if (!userDoc.exists) {
                                    // Get a sample proposal for context
                                    const sampleProp = await db.collection('proposals')
                                        .where('createdByUid', '==', uid).limit(1).get();
                                    const sampleData = sampleProp.empty ? {} : sampleProp.docs[0].data();
                                    orphanedUids.push({
                                        uid,
                                        createdBy: sampleData.createdBy || 'unknown',
                                        createdByName: sampleData.createdByName || 'unknown',
                                        sampleProject: sampleData.projectName || 'unknown'
                                    });
                                }
                            }
                            if (orphanedUids.length > 0) {
                                return res.status(400).json({
                                    success: false,
                                    error: `Could not auto-match old UID. Found ${orphanedUids.length} orphaned UID(s). Please check which one belongs to ${emailLower} and provide it manually.`,
                                    detectedNewUid: resolvedNewUid,
                                    orphanedUids: orphanedUids
                                });
                            }
                        }
                    }
                }
            }

            if (!resolvedOldUid || !resolvedNewUid) {
                return res.status(400).json({
                    success: false,
                    error: `Could not resolve UIDs. ${!resolvedOldUid ? 'Old UID not found.' : ''} ${!resolvedNewUid ? 'New UID not found.' : ''} Try providing oldUid and newUid manually.`,
                    detectedOldUid: resolvedOldUid || null,
                    detectedNewUid: resolvedNewUid || null
                });
            }

            if (resolvedOldUid === resolvedNewUid) {
                return res.status(400).json({
                    success: false,
                    error: 'Old UID and New UID are the same. No migration needed.'
                });
            }

            const migrationLog = [];
            let totalBatchOps = 0;

            // Use multiple batches to handle large datasets
            async function runBatch(operations) {
                const BATCH_LIMIT = 400;
                let currentBatch = db.batch();
                let currentCount = 0;
                for (const op of operations) {
                    op(currentBatch);
                    currentCount++;
                    totalBatchOps++;
                    if (currentCount >= BATCH_LIMIT) {
                        await currentBatch.commit();
                        currentBatch = db.batch();
                        currentCount = 0;
                    }
                }
                if (currentCount > 0) {
                    await currentBatch.commit();
                }
            }

            // 1. Migrate proposals (createdByUid)
            const proposalsSnap = await db.collection('proposals').where('createdByUid', '==', resolvedOldUid).get();
            if (!proposalsSnap.empty) {
                await runBatch(proposalsSnap.docs.map(doc => (batch) => {
                    batch.update(doc.ref, { createdByUid: resolvedNewUid, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
                    migrationLog.push(`proposal: ${doc.id}`);
                }));
            }

            // 2. Migrate projects (bdmUid)
            const projectsSnap = await db.collection('projects').where('bdmUid', '==', resolvedOldUid).get();
            if (!projectsSnap.empty) {
                await runBatch(projectsSnap.docs.map(doc => (batch) => {
                    batch.update(doc.ref, { bdmUid: resolvedNewUid, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
                    migrationLog.push(`project (bdm): ${doc.id}`);
                }));
            }

            // 3. Migrate projects (designLeadUid)
            const projectsDLSnap = await db.collection('projects').where('designLeadUid', '==', resolvedOldUid).get();
            if (!projectsDLSnap.empty) {
                await runBatch(projectsDLSnap.docs.map(doc => (batch) => {
                    batch.update(doc.ref, { designLeadUid: resolvedNewUid, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
                    migrationLog.push(`project (designLead): ${doc.id}`);
                }));
            }

            // 4. Migrate payments (bdmUid)
            const paymentsSnap = await db.collection('payments').where('bdmUid', '==', resolvedOldUid).get();
            if (!paymentsSnap.empty) {
                await runBatch(paymentsSnap.docs.map(doc => (batch) => {
                    batch.update(doc.ref, { bdmUid: resolvedNewUid, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
                    migrationLog.push(`payment: ${doc.id}`);
                }));
            }

            // 5. Migrate payments (createdByUid)
            const paymentsCreatedSnap = await db.collection('payments').where('createdByUid', '==', resolvedOldUid).get();
            if (!paymentsCreatedSnap.empty) {
                await runBatch(paymentsCreatedSnap.docs.map(doc => (batch) => {
                    batch.update(doc.ref, { createdByUid: resolvedNewUid, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
                    migrationLog.push(`payment (created): ${doc.id}`);
                }));
            }

            // 6. Migrate notifications (recipientUid)
            const notificationsSnap = await db.collection('notifications').where('recipientUid', '==', resolvedOldUid).get();
            if (!notificationsSnap.empty) {
                await runBatch(notificationsSnap.docs.map(doc => (batch) => {
                    batch.update(doc.ref, { recipientUid: resolvedNewUid });
                    migrationLog.push(`notification: ${doc.id}`);
                }));
            }

            // 7. Migrate tasks (designerUid)
            const tasksSnap = await db.collection('tasks').where('designerUid', '==', resolvedOldUid).get();
            if (!tasksSnap.empty) {
                await runBatch(tasksSnap.docs.map(doc => (batch) => {
                    batch.update(doc.ref, { designerUid: resolvedNewUid, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
                    migrationLog.push(`task: ${doc.id}`);
                }));
            }

            // 8. Migrate timesheets (designerUid)
            const timesheetsSnap = await db.collection('timesheets').where('designerUid', '==', resolvedOldUid).get();
            if (!timesheetsSnap.empty) {
                await runBatch(timesheetsSnap.docs.map(doc => (batch) => {
                    batch.update(doc.ref, { designerUid: resolvedNewUid });
                    migrationLog.push(`timesheet: ${doc.id}`);
                }));
            }

            // 9. Migrate variations (createdByUid)
            const variationsSnap = await db.collection('variations').where('createdByUid', '==', resolvedOldUid).get();
            if (!variationsSnap.empty) {
                await runBatch(variationsSnap.docs.map(doc => (batch) => {
                    batch.update(doc.ref, { createdByUid: resolvedNewUid, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
                    migrationLog.push(`variation: ${doc.id}`);
                }));
            }

            // 10. Copy old user doc to new UID if new doc doesn't have full data
            const oldUserDoc = await db.collection('users').doc(resolvedOldUid).get();
            const newUserDoc = await db.collection('users').doc(resolvedNewUid).get();
            if (oldUserDoc.exists && newUserDoc.exists) {
                const oldData = oldUserDoc.data();
                const newData = newUserDoc.data();
                const mergedData = {
                    ...oldData,
                    ...newData,
                    migratedFromUid: resolvedOldUid,
                    migratedAt: admin.firestore.FieldValue.serverTimestamp()
                };
                const mergeBatch = db.batch();
                mergeBatch.set(db.collection('users').doc(resolvedNewUid), mergedData, { merge: true });
                await mergeBatch.commit();
                migrationLog.push(`user doc merged: ${resolvedOldUid} -> ${resolvedNewUid}`);
            }

            // Log the migration activity
            await db.collection('activities').add({
                type: 'uid_migration',
                details: `UID migration: ${resolvedOldUid} -> ${resolvedNewUid}. ${migrationLog.length} documents updated.`,
                performedByName: req.user.name,
                performedByRole: req.user.role,
                performedByUid: req.user.uid,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                migrationLog: migrationLog
            });

            return res.status(200).json({
                success: true,
                message: `Successfully migrated ${migrationLog.length} documents from old UID to new UID`,
                migratedCount: migrationLog.length,
                oldUid: resolvedOldUid,
                newUid: resolvedNewUid,
                details: migrationLog
            });
        }

        return res.status(405).json({ success: false, error: 'Method not allowed' });
        
    } catch (error) {
        console.error('Users API error:', error);
        // Check for specific auth errors
        if (error.code === 'auth/id-token-expired') {
            return res.status(401).json({ success: false, error: 'Token expired' });
        }
        if (error.code === 'auth/id-token-revoked') {
            return res.status(401).json({ success: false, error: 'Token revoked' });
        }
        return res.status(500).json({ 
            success: false, 
            error: 'Internal Server Error', 
            message: error.message 
        });
    }
};

module.exports = allowCors(handler);
