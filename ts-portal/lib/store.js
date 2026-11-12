// Timesheet Portal data access.
//
// Every collection used by the portal starts with "ts" so the portal never
// reads or writes anything the EB Tracker app uses:
//   tsPlatform/config                 { superAdminUids[] }
//   tsUsers/{uid}                     { companyId, email }   one login -> one company
//   tsCompanies/{companyId}           company profile + status + settings
//     members/{uid}                   name, email, role, supervisorUid, status
//     projects/{projectId}            code, name, pmUid, memberUids[], active
//     sheets/{uid}_{weekStart}        one weekly timesheet
//     auditLog/{id}                   who changed what
let _db = null;
let _auth = null;

function admin() { return require('../../api/_firebase-admin'); }
function db() {
    if (!_db) _db = admin().firestore();
    return _db;
}
function auth() {
    if (!_auth) _auth = admin().auth();
    return _auth;
}
// Tests swap in an in-memory Firestore and a fake Auth.
function _setForTests(deps) {
    _db = deps.db || null;
    _auth = deps.auth || null;
}

const platformRef = () => db().collection('tsPlatform').doc('config');
const userLinkRef = uid => db().collection('tsUsers').doc(uid);
const companiesCol = () => db().collection('tsCompanies');
const companyRef = cid => companiesCol().doc(cid);
// The ONLY way route code reaches company data: always scoped by company id.
const col = (cid, name) => companyRef(cid).collection(name);

const now = () => new Date().toISOString();
const docs = snap => snap.docs.map(d => ({ id: d.id, ...d.data() }));

module.exports = { db, auth, _setForTests, platformRef, userLinkRef, companiesCol, companyRef, col, now, docs };
