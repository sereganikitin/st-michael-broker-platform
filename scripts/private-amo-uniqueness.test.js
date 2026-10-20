'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('.github/workflows/inspect-private-amo-uniqueness.yml','utf8').replace(/\r\n/g,'\n');
const program=source.split("<<'PROBE'\n")[1].split('\n          PROBE')[0];
async function run(error=null){
  const out=[],calls=[];
  class PrismaClient{
    constructor(x){assert.match(new URL(x.datasources.db.url).searchParams.get('options'),/read_only=on/);}
    $queryRawUnsafe(){return [{mode:'on'}];}
    client={findMany:async()=>[]};systemSetting={findMany:async()=>[{value:'PRIVATE_TOKEN'}]};async $disconnect(){}
  }
  class AmoCrmAdapter{async checkUniqueness(){await this.request('/contacts?query=private');if(error)throw Error(error);return {rule:'NO_CONFLICT'};}}
  const process={env:{AMO_DIAG_EXACT_PHONE:'70000009999',DATABASE_URL:'postgresql://x:y@localhost/db'},exitCode:0};
  await vm.runInNewContext(program,{URL,Set,Map,Buffer,Number,JSON,String,Error,AbortSignal,process,
    require:s=>s.includes('database')?{PrismaClient}:s.includes('fields')?{}:{AmoCrmAdapter},
    console:{log:x=>out.push(x)},fetch:async(url,init)=>{assert.equal(init.method,'GET');assert.equal(init.redirect,'error');calls.push(url);return {ok:true,status:200,text:async()=>JSON.stringify({_embedded:{contacts:[]}})};}});
  assert.equal(out.length,1);assert.doesNotMatch(out[0],/70000009999|PRIVATE_TOKEN|PRIVATE_ERROR/);
  return JSON.parse(out[0].split('=')[1]);
}
test('exact probe has no writes or phone output',async()=>{const r=await run();assert.equal(r.result.succeeded,true);assert.equal(r.crmWrites,0);assert.equal(r.databaseWrites,0);assert.equal(r.redisWrites,0);});
test('known structural error is preserved',async()=>{const r=await run('AMO_UNIQUENESS_LEAD_STAGE_UNCLASSIFIED');assert.equal(r.result.errorCode,'AMO_UNIQUENESS_LEAD_STAGE_UNCLASSIFIED');});
test('unknown error is not disclosed',async()=>{const r=await run('PRIVATE_ERROR');assert.equal(r.result.errorCode,'UNCLASSIFIED');});
test('target only arrives through private secret and SSH stdin',()=>{assert.ok(source.includes('secrets.AMO_DIAG_EXACT_PHONE_20261020'));assert.ok(source.includes('printf "export AMO_DIAG_EXACT_PHONE='));assert.doesNotMatch(source,/workflow_dispatch:\s*\n\s*inputs:/);assert.ok(source.includes('StrictHostKeyChecking=yes'));});
