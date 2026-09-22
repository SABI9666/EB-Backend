const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const express = require('express');
const records = new Map(), storage = new Map();
let sequence = 0;
class Ref {
    constructor(path) { this.path=path; this.id=path.split('/').pop(); }
    collection(name) { return new Query(this.path+'/'+name); }
    async get() { const data=records.get(this.path); return {exists:!!data,id:this.id,data:()=>structuredClone(data)}; }
}
class Query {
    constructor(path) { this.path=path; }
    doc(id='doc'+(++sequence)) { return new Ref(this.path+'/'+id); }
    orderBy(key,direction) { this.key=key;this.direction=direction;return this; }
    limit(n) { this.n=n;return this; }
    startAfter(id) {this.after=id;return this;}
    async get() { let entries=[...records.entries()].filter(([p])=>p.startsWith(this.path+'/')&&p.split('/').length===this.path.split('/').length+1); entries.sort(([a,x],[b,y])=>String(this.key==='__name__'?a.split('/').pop():x[this.key]).localeCompare(String(this.key==='__name__'?b.split('/').pop():y[this.key]))*(this.direction==='desc'?-1:1));if(this.after)entries=entries.filter(([p])=>p.split('/').pop()>this.after);entries=entries.slice(0,this.n);const docs=await Promise.all(entries.map(([p])=>new Ref(p).get()));return {docs,size:docs.length}; }
}
function batch() { const writes=[];return {set:(ref,data)=>writes.push(()=>records.set(ref.path,data)),update:(ref,data)=>writes.push(()=>records.set(ref.path,{...records.get(ref.path),...data})),get:ref=>ref.get(),commit:async()=>writes.forEach(fn=>fn())}; }
const database={collection:name=>new Query(name),batch,runTransaction:async fn=>{const tx=batch();await fn(tx);await tx.commit();}};
const firestore=()=>database;firestore.FieldPath={documentId:()=> '__name__'};
const mock={firestore,apps:[{}],auth:()=>({verifyIdToken:async token=>({uid:token,email:({purchase:'anwar@edanbrook.in',purchase2:'anwar1@edanbrook.in',unverified:'anwar@edanbrook.in',unverified2:'anwar1@edanbrook.in',wrongDomain:'anwar@edanbrook.com',wrongDomain2:'anwar1@edanbrook.com',suspendedPurchase:'anwar@edanbrook.in',inactivePurchase:'anwar1@edanbrook.in'}[token] || token+'@test.local'),email_verified:!['unverified','unverified2','purchase','purchase2'].includes(token)})}),storage:()=>({bucket:()=>({file:path=>({save:async data=>storage.set(path,data),delete:async()=>storage.delete(path),createReadStream:()=>Readable.from(storage.get(path))})})})};
require.cache[require.resolve('../api/_firebase-admin')]={exports:mock};
for(const role of ['coo','director','bdm','suspended','purchase','purchase2','forged','unverified']) records.set('users/'+role,{name:role,role:['forged','unverified'].includes(role)?'purchase':role==='purchase2'?'bdm':role==='suspended'?'coo':role,status:role==='suspended'?'suspended':'active'});
for (const uid of ['unverified2','wrongDomain','wrongDomain2','suspendedPurchase','inactivePurchase']) records.set('users/'+uid,{name:uid,role:'purchase',status:uid==='suspendedPurchase'?'suspended':uid==='inactivePurchase'?'inactive':'active'});
const app=express();app.use(express.json());app.get('/api/projects',require('../middleware/auth').verifyToken,(req,res)=>res.json({success:true}));app.use('/api/purchases',require('../api/purchases'));
const data={project:'Project Alpha',item:'Steel',qty:'2 MT',amount:20,currency:'INR',priority:'normal'};
test('purchase operations require management approval without changing approved data prematurely', async t => {
 const server=app.listen(0);await new Promise(resolve=>server.once('listening',resolve));t.after(()=>server.close());
 const url='http://127.0.0.1:'+server.address().port+'/api/purchases';
 async function call(role,method,path='',body){return fetch(url+path,{method,headers:{...(role?{Authorization:'Bearer '+role}:{}),...(body&&!(body instanceof FormData)?{'Content-Type':'application/json'}:{})},body:body instanceof FormData?body:body?JSON.stringify(body):undefined});}
 const detail=async(path)=>(await (await call('director','GET',path)).json());
 const current=async(path)=>(await detail(path)).data;
 const decide=async(path,decision='approved',role='coo')=>call(role,'POST',path+'/decision',{version:(await current(path)).version,decision,note:decision==='rejected'?'Not accepted':'Reviewed'});
 function upload(version,type='quotation',bytes='%PDF-1.7\ntest',name='quote.pdf') {const form=new FormData();form.append('type',type);form.append('version',String(version));form.append('file',new Blob([bytes]),name);return form;}
 assert.equal((await call(null,'GET')).status,401);
 assert.equal((await fetch(url.replace('/purchases','/projects'),{headers:{Authorization:'Bearer purchase'}})).status,403);
 for (const uid of ['unverified','unverified2','purchase','purchase2']) {
   const response=await call(uid,'GET');assert.equal(response.status,200);assert.equal((await response.json()).role,'purchase');
 }
 for (const uid of ['bdm','forged','wrongDomain','wrongDomain2','suspendedPurchase','inactivePurchase','suspended']) assert.equal((await call(uid,'GET')).status,403);
 for (const role of ['coo','director']) assert.equal((await call(role,'POST','',data)).status,403);
 assert.equal((await call('purchase','POST','',{...data,amount:-1})).status,400);
 assert.equal((await call('purchase','POST','',{...data,requiredBy:'2026-02-30'})).status,400);
 let response=await call('purchase','POST','',data);assert.equal(response.status,201);
 const initial=(await response.json()).data,path='/'+initial.id;
 assert.equal(initial.approval.status,'pending');assert.equal(initial.pendingChange.kind,'initial');
 assert.equal((await call('purchase','POST',path+'/decision',{version:1,decision:'approved'})).status,403);
 assert.equal((await call('director','POST',path+'/decision',{version:1,decision:'rejected'})).status,400);
 assert.equal((await call('purchase','PUT',path,{...initial,amount:40,note:'Change while pending'})).status,409);
 assert.equal((await call('purchase','POST',path+'/delete-request',{version:1,note:'Delete while pending'})).status,409);
 assert.equal((await call('purchase','POST',path+'/documents',upload(1))).status,409);assert.equal(storage.size,0);
 assert.equal((await decide(path)).status,200);
 assert.equal((await current(path)).stage,'rfq');
 assert.equal((await call('director','POST',path+'/decision',{version:1,decision:'approved'})).status,409);
 // Edits are proposals; rejection preserves the original, approval applies exactly once.
 let record=await current(path);
 assert.equal((await call('director','PUT',path,{...record,amount:40,note:'Forbidden'})).status,403);
 assert.equal((await call('purchase','PUT',path,{...record,amount:40})).status,400);
 assert.equal((await call('purchase','PUT',path,{...record,amount:40,note:'Revised price',approval:{status:'approved'}})).status,200);
 assert.equal((await current(path)).amount,20);assert.equal((await current(path)).pendingChange.data.amount,40);
 assert.equal((await decide(path,'rejected','director')).status,200);
 assert.equal((await current(path)).amount,20);assert.equal((await current(path)).approval.status,'approved');
 record=await current(path);
 assert.equal((await call('purchase2','PUT',path,{...record,amount:40,note:'Revised budget'})).status,200);
 assert.equal((await decide(path,'approved','director')).status,200);assert.equal((await current(path)).amount,40);
 assert.equal((await call('purchase','PUT',path,{...record,amount:50,note:'Stale'})).status,409);
 // Every category, including invoice and delivery, queues review and preserves the current stage.
 record=await current(path);
 assert.equal((await call('director','POST',path+'/documents',upload(record.version))).status,403);
 assert.equal((await call('purchase','POST',path+'/documents',upload(record.version,'quotation','<script>bad</script>'))).status,400);
 assert.equal((await call('purchase','POST',path+'/documents',upload(record.version,'quotation',new Uint8Array(10*1024*1024+1)))).status,400);
 assert.equal((await call('purchase','POST',path+'/documents',upload(record.version-1))).status,409);assert.equal(storage.size,0);
 for (const [type,stage] of [['quotation','quote'],['comparison','compare'],['po','po'],['delivery','delivery'],['invoice','match'],['receipt','payment'],['other','payment']]) {
   record=await current(path);
   assert.equal((await call('purchase2','POST',path+'/documents',upload(record.version,type))).status,201);
   const pending=await detail(path),doc=pending.documents.find(d=>d.id===pending.data.pendingChange.documentId);
   assert.equal(pending.data.stage,record.stage);assert.equal(pending.data.approval.status,'pending');assert.equal(doc.status,'pending');assert.equal(doc.storagePath,undefined);
   response=await call('coo','GET',path+'/documents/'+doc.id);assert.equal(response.status,200);assert.equal(await response.text(),'%PDF-1.7\ntest');
   assert.equal((await call('bdm','GET',path+'/documents/'+doc.id)).status,403);
   assert.equal((await call('purchase','POST',path+'/documents',upload(pending.data.version,type))).status,409);
   assert.equal((await decide(path)).status,200);assert.equal((await current(path)).stage,stage);
   assert.equal((await detail(path)).documents.find(d=>d.id===doc.id).status,'approved');
 }
 // Rejected and withdrawn uploads remain audit-visible and never affect approved state.
 record=await current(path);
 assert.equal((await call('purchase','POST',path+'/documents',upload(record.version))).status,201);
 const rejectedDoc=(await current(path)).pendingChange.documentId;
 assert.equal((await decide(path,'rejected')).status,200);
 assert.equal((await current(path)).stage,'payment');assert.equal((await current(path)).approval.status,'approved');
 assert.equal((await detail(path)).documents.find(d=>d.id===rejectedDoc).status,'rejected');
 record=await current(path);
 assert.equal((await call('purchase','POST',path+'/documents',upload(record.version))).status,201);
 record=await current(path);const withdrawnDoc=record.pendingChange.documentId;
 assert.equal((await call('purchase2','POST',path+'/withdraw',{version:record.version})).status,200);
 assert.equal((await current(path)).stage,'payment');assert.equal((await detail(path)).documents.find(d=>d.id===withdrawnDoc).status,'withdrawn');
 // Closing is also an approved change and still requires a payment reference.
 record=await current(path);
 assert.equal((await call('purchase','PUT',path,{...record,stage:'closed',note:'Complete'})).status,400);
 assert.equal((await call('purchase','PUT',path,{...record,stage:'closed',paymentReference:'PAY-1',note:'Complete'})).status,200);
 assert.equal((await current(path)).stage,'payment');assert.equal((await decide(path)).status,200);assert.equal((await current(path)).stage,'closed');
 record=await current(path);
 assert.equal((await call('purchase','PUT',path,{...record,stage:'rfq',note:'Reopen'})).status,409);
 assert.equal((await call('purchase','POST',path+'/documents',upload(record.version))).status,409);
 // Deletion needs a reason and a management decision, with an audit-preserving archive.
 assert.equal((await call('coo','POST',path+'/delete-request',{version:record.version,note:'Delete'})).status,403);
 assert.equal((await call('purchase','POST',path+'/delete-request',{version:record.version})).status,400);
 assert.equal((await call('purchase','POST',path+'/delete-request',{version:record.version,note:'Duplicate'})).status,200);
 assert.equal((await (await call('coo','GET')).json()).data.length,1);
 assert.equal((await decide(path,'rejected')).status,200);assert.equal((await current(path)).deletedAt,undefined);
 record=await current(path);
 assert.equal((await call('purchase','POST',path+'/delete-request',{version:record.version,note:'Confirmed duplicate'})).status,200);
 assert.equal((await decide(path,'approved','director')).status,200);
 assert.equal((await (await call('purchase','GET')).json()).data.length,0);
 const archived=await detail(path);assert.ok(archived.data.deletedAt);assert.ok(archived.documents.length);assert.ok(archived.activities.some(a=>a.action==='approved_delete'));
 assert.equal((await call('purchase','POST',path+'/submit',{version:archived.data.version})).status,404);
 // Existing drafts from the old UI can be approved directly, without data migration.
 records.set('purchases/legacy',{...data,stage:'rfq',approval:{status:'draft'},version:1,createdBy:{uid:'purchase'},updatedAt:new Date().toISOString()});
 assert.equal((await decide('/legacy','approved','director')).status,200);assert.equal((await current('/legacy')).approval.status,'approved');
 // Legacy pending requests and withdrawn new requests remain compatible.
 records.set('purchases/legacyPending',{...data,stage:'approval',approval:{status:'pending',submittedBy:{uid:'purchase'}},version:1,updatedAt:new Date().toISOString()});
 assert.equal((await decide('/legacyPending','rejected')).status,200);
 assert.equal((await call('purchase','POST','/legacyPending/submit',{version:2})).status,200);
 assert.equal((await decide('/legacyPending')).status,200);
 response=await call('purchase','POST','',data);const fresh=(await response.json()).data,fp='/'+fresh.id;
 assert.equal((await call('purchase','POST',fp+'/withdraw',{version:1})).status,200);
 assert.equal((await current(fp)).approval.status,'draft');
 assert.equal((await call('purchase','POST',fp+'/submit',{version:2})).status,200);
 assert.equal((await decide(fp)).status,200);
 assert.equal((await call('purchase','GET','/missing')).status,404);
});
