'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {exactActiveParty,verifyRegistry}=require('./registry.cjs');
const candidate={tab:'Спящие',row:19,inn:'9731116328',legalName:'ООО Веллсайд'};
const entry={data:{inn:candidate.inn,type:'LEGAL',state:{status:'ACTIVE'},name:{short:'ВЕЛЛСАЙД'}}};
test('requires exact active legal entity, not a prefix or missing state',()=>{
 assert.equal(exactActiveParty(candidate,[entry]),true);
 for(const change of [{inn:'1234567890'},{state:{}},{state:{status:'LIQUIDATED'}},{type:'INDIVIDUAL'},{name:{short:'Other'}}])assert.equal(exactActiveParty(candidate,[{data:{...entry.data,...change}}]),false);
 assert.equal(exactActiveParty(candidate,[entry,entry]),false);
});
test('absent credentials and failed requests never authorize creation',async()=>{
 let called=false;const missing=await verifyRegistry([candidate],'',async()=>{called=true;});assert.equal(called,false);assert.equal(missing[0].activeExactLegalIdentity,false);
 const failed=await verifyRegistry([candidate],'private',async()=>{throw Error('private details');});assert.equal(failed[0].activeExactLegalIdentity,false);assert.doesNotMatch(JSON.stringify(failed),/private/);
});
