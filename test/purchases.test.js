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
test('purchase workflow, audit, access controls and upload validation',async t=>{
 const server=app.listen(0);await new Promise(resolve=>server.once('listening',resolve));t.after(()=>server.close());
 const url='http://127.0.0.1:'+server.address().port+'/api/purchases';
 async function call(role,method,path='',body){return fetch(url+path,{method,headers:{...(role?{Authorization:'Bearer '+role}:{}),...(body&&!(body instanceof FormData)?{'Content-Type':'application/json'}:{})},body:body instanceof FormData?body:body?JSON.stringify(body):undefined});}
 assert.equal((await call(null,'GET')).status,401);
 assert.equal((await fetch(url.replace('/purchases','/projects'),{headers:{Authorization:'Bearer purchase'}})).status,403);
 assert.equal((await call('bdm','GET')).status,403);
 assert.equal((await call('forged','GET')).status,403);
 for (const uid of ['unverified','unverified2','purchase','purchase2']) {
   const response = await call(uid,'GET'); assert.equal(response.status,200); assert.equal((await response.json()).role,'purchase');
 }
 for (const uid of ['wrongDomain','wrongDomain2','suspendedPurchase','inactivePurchase']) assert.equal((await call(uid,'GET')).status,403);
 assert.equal((await call('purchase2','GET')).status,200);
 assert.equal((await call('coo','POST','',data)).status,403);
 assert.equal((await call('suspended','GET')).status,403);
 assert.equal((await call('director','POST','',data)).status,403);
 assert.equal((await call('purchase','POST','',{...data,amount:-1})).status,400);
 assert.equal((await call('purchase','POST','',{...data,requiredBy:'2026-02-30'})).status,400);
 let response=await call('purchase','POST','',data);assert.equal(response.status,201);
 const created=(await response.json()).data; const path='/'+created.id;
 response=await call('director','GET',path);let detail=await response.json();assert.equal(detail.activities.length,1);
 assert.equal((await call('director','PUT',path,{...created,stage:'quote'})).status,403);
 assert.equal((await call('purchase','PUT',path,{...created,stage:'quote'})).status,400);
 assert.equal((await call('purchase','PUT',path,{...created,stage:'quote',note:'Quotes requested'})).status,200);
 assert.equal((await call('purchase','PUT',path,{...created,stage:'quote',note:'Stale'})).status,409);
 function upload(bytes,name='quote.pdf') {const form=new FormData();form.append('type','quotation');form.append('file',new Blob([bytes]),name);return form;}
 assert.equal((await call('director','POST',path+'/documents',upload('%PDF-1.7\n'))).status,403);
 assert.equal((await call('purchase','POST',path+'/documents',upload('<script>bad</script>'))).status,400);
 assert.equal(storage.size,0);
 assert.equal((await call('purchase','POST',path+'/documents',upload(new Uint8Array(10*1024*1024+1)))).status,400);
 assert.equal((await call('purchase','POST',path+'/documents',upload('%PDF-1.7\ntest'))).status,201);
 detail=await (await call('director','GET',path)).json();assert.equal(detail.documents.length,1);assert.equal(detail.activities.length,3);assert.equal(detail.data.version,3);assert.equal(detail.documents[0].storagePath,undefined);
 response=await call('director','GET',path+'/documents/'+detail.documents[0].id);assert.equal(response.status,200);assert.match(response.headers.get('content-disposition'),/attachment/);assert.equal(await response.text(),'%PDF-1.7\ntest');
 assert.equal((await call('bdm','GET',path+'/documents/'+detail.documents[0].id)).status,403);
 assert.equal((await call('purchase','PUT',path,{...detail.data,stage:'po',note:'Bypass'})).status,409);
 assert.equal((await call('purchase','POST',path+'/decision',{version:3,decision:'approved'})).status,403);
 assert.equal((await call('purchase','POST',path+'/submit',{version:3})).status,200);
 assert.equal((await call('purchase','PUT',path,{...detail.data,version:4,stage:'rfq'})).status,409);
 assert.equal((await call('purchase','POST',path+'/documents',upload('%PDF-1.7'))).status,409);
 assert.equal((await call('director','POST',path+'/decision',{version:4,decision:'rejected'})).status,400);
 assert.equal((await call('director','POST',path+'/decision',{version:4,decision:'rejected',note:'Need another quote'})).status,200);
 assert.equal((await call('purchase2','POST',path+'/submit',{version:5})).status,200);
 assert.equal((await call('coo','POST',path+'/decision',{version:6,decision:'approved',note:'Approved budget'})).status,200);
 assert.equal((await call('director','POST',path+'/decision',{version:6,decision:'approved'})).status,409);
 detail=await (await call('director','GET',path)).json();
 assert.equal(detail.data.approval.status,'approved');
 assert.equal((await call('purchase','PUT',path,{...detail.data,amount:25,note:'Revised price'})).status,200);
 detail=await (await call('director','GET',path)).json();assert.equal(detail.data.approval.status,'draft');assert.equal(detail.data.stage,'rfq');
 assert.equal((await call('purchase','POST',path+'/submit',{version:8})).status,200);
 assert.equal((await call('purchase2','POST',path+'/withdraw',{version:9})).status,200);
 assert.equal((await call('coo','POST',path+'/decision',{version:9,decision:'approved'})).status,409);
 assert.equal((await call('purchase','POST',path+'/submit',{version:10})).status,200);
 assert.equal((await call('director','POST',path+'/decision',{version:11,decision:'approved'})).status,200);
 detail=await (await call('director','GET',path)).json();
 assert.equal((await call('purchase','PUT',path,{...detail.data,stage:'closed',note:'Complete'})).status,400);
 assert.equal((await call('purchase','PUT',path,{...detail.data,stage:'closed',note:'Complete',paymentReference:'PAY-1'})).status,200);
 assert.equal((await call('purchase','POST',path+'/documents',upload('%PDF-1.7\n'))).status,409);assert.equal(storage.size,1);
 assert.equal((await call('purchase','PUT',path,{...detail.data,version:13,stage:'rfq'})).status,409);
 assert.equal((await call('purchase','GET','/missing')).status,404);
 // Supporting purchase uploads invalidate approval; fulfilment documents do not.
 const extra=(await (await call('purchase2','POST','',data)).json()).data;
 const ep='/'+extra.id;
 assert.equal((await call('purchase','POST',ep+'/submit',{version:1})).status,200);
 assert.equal((await call('director','POST',ep+'/decision',{version:2,decision:'approved'})).status,200);
 const invoice=upload('%PDF-1.7');invoice.set('type','invoice');
 assert.equal((await call('purchase','POST',ep+'/documents',invoice)).status,201);
 assert.equal((await (await call('coo','GET',ep)).json()).data.approval.status,'approved');
 assert.equal((await call('purchase','POST',ep+'/documents',upload('%PDF-1.7'))).status,201);
 assert.equal((await (await call('coo','GET',ep)).json()).data.approval.status,'draft');
 const list=await (await call('director','GET')).json();assert.equal(list.data.length,2);assert.equal(list.role,'director');
});
