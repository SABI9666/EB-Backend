// Make a person a Timesheet Portal Super Admin (the only way to grant it).
//   node scripts/ts-bootstrap-superadmin.js owner@example.com          add
//   node scripts/ts-bootstrap-superadmin.js owner@example.com --remove remove
// Needs the same Firebase credentials as the server (FIREBASE_SERVICE_ACCOUNT_KEY_BASE64
// or Application Default Credentials). The person must already have a Firebase login;
// create one in Firebase Console > Authentication if needed.
require('dotenv').config();
const admin = require('../api/_firebase-admin');

(async () => {
    const email = String(process.argv[2] || '').trim().toLowerCase();
    const remove = process.argv.includes('--remove');
    if (!email) { console.error('Usage: node scripts/ts-bootstrap-superadmin.js <email> [--remove]'); process.exit(1); }
    const user = await admin.auth().getUserByEmail(email);
    const ref = admin.firestore().collection('tsPlatform').doc('config');
    const op = remove ? admin.firestore.FieldValue.arrayRemove(user.uid) : admin.firestore.FieldValue.arrayUnion(user.uid);
    await ref.set({ superAdminUids: op, updatedAt: new Date().toISOString() }, { merge: true });
    console.log(`${remove ? 'Removed' : 'Added'} Super Admin: ${email} (${user.uid})`);
    process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
