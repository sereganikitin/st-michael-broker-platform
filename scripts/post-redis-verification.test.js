'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const workflow=fs.readFileSync('.github/workflows/verify-post-redis-amo-delivery.yml','utf8').replace(/\r\n/g,'\n');
const program=workflow.split("<<'VERIFY'\n")[1].split('\n          VERIFY')[0];
async function run(rows=[],duplicate=false,next=false,probeError=null){
  const calls=[], output=[];
  class PrismaClient{
    constructor(options){assert.match(new URL(options.datasources.db.url).searchParams.get('options'),/default_transaction_read_only=on/);}
    $queryRawUnsafe(sql){assert.equal(sql,"SELECT current_setting('default_transaction_read_only') AS mode");return [{mode:'on'}];}
    client={findMany:async()=>rows.map(r=>({createdAt:'2026-10-20T05:53:00Z',...r}))};
    systemSetting={findMany:async()=>[{value:'PRIVATE_TOKEN'}]};
    async $disconnect(){}
  }
  const lead={id:123,name:'PRIVATE_NAME',pipeline_id:7,created_at:1000,_embedded:{contacts:[{id:9}]}};
  class AmoCrmAdapter {async checkUniqueness(){if(probeError)throw Error(probeError);await this.request('/contacts?query=private');return {rule:'RULE_1'};}}
  const context={require:path=>path.includes('amo-crm.adapter')?{AmoCrmAdapter}:{PrismaClient},URL,Date,Number,Math,JSON,Error,AbortSignal,encodeURIComponent,process:{env:{DATABASE_URL:'postgresql://x:y@localhost/db'},exitCode:0},console:{log:x=>output.push(x)},fetch:async(url,options)=>{
    calls.push({url,options});assert.equal(options.method,'GET');assert.equal(options.redirect,'error');
    const data=url.endsWith('/account')?{}:url.includes('/leads/123?')?lead:{_embedded:{leads:[lead,...(duplicate?[{...lead,id:124}]:[])]},_links:next?{next:{href:'PRIVATE_URL'}}:{}};
    return {ok:true,status:200,json:async()=>data};
  }};
  await vm.runInNewContext(program,context);
  const text=output.join('\n');
  assert.doesNotMatch(text,/PRIVATE_TOKEN|PRIVATE_NAME|PRIVATE_URL|private-client-id/);
  return {report:JSON.parse(output[0].split('=')[1]),calls};
}
test('no real submission means no delivery claim and account GET only',async()=>{
  const {report,calls}=await run();assert.equal(report.deliveryObserved,false);assert.equal(report.newRequests,0);assert.equal(calls.length,1);assert.equal(report.crmWrites,0);
});
test('existing synced lead is verified without writes',async()=>{
  const {report}=await run([{id:'private-client-id',amoSyncStatus:'SYNCED',amoLeadId:123,amoSyncError:null}]);assert.equal(report.verifiedExistingLeads,1);assert.equal(report.duplicateCandidates,0);assert.equal(report.duplicateSearchCoverageComplete,true);
});
test('duplicate candidate and truncated coverage are never hidden',async()=>{
  const {report}=await run([{id:'private-client-id',amoSyncStatus:'SYNCED',amoLeadId:123,amoSyncError:null}],true,true);assert.equal(report.duplicateCandidates,1);assert.equal(report.duplicateSearchCoverageComplete,false);
});
test('failed or pending request is not represented as delivered',async()=>{
  const {report,calls}=await run([{amoSyncStatus:'FAILED',amoLeadId:null,amoSyncError:'private-error'}]);assert.equal(report.deliveryObserved,false);assert.equal(calls.length,1);
});
test('uniqueness log classifier emits only fixed codes and timestamps',()=>{
  const part=workflow.split("st-michael-api node -e '\n")[1];
  const program=part.slice(0,part.indexOf("});'")+3);
  const handlers={}, output=[];
  vm.runInNewContext(program,{Set,JSON,process:{stdin:{on:(event,fn)=>handlers[event]=fn},exit:()=>{throw Error('BOUNDS');}},console:{log:s=>output.push(s)}});
  handlers.data('2026-10-20T05:54:00Z [fixClient] amo checkUniqueness giving up on attempt 3/3: AMO_SYNC_FAILED (errClass=Error, httpStatus=n/a) PRIVATE_PHONE_TOKEN\n2026-10-20T05:54:00Z [fixClient] amo checkUniqueness failed; lead creation is blocked: AMO_SYNC_FAILED\n');
  handlers.end();
  assert.doesNotMatch(output[0],/PRIVATE_PHONE_TOKEN/);
  const result=JSON.parse(output[0].split('=')[1]);
  assert.equal(result.blocked,1);assert.equal(result.failures.AMO_SYNC_FAILED,1);
});
test('targeted uniqueness probe stays GET-only and does not emit phone',async()=>{
  const {report}=await run([{phone:'+70000009999',brokerId:'6e414141-f2ca-4c71-8402-2032c9186568',amoSyncStatus:'SYNCED',amoLeadId:123}]);
  assert.equal(report.targetUniqueness.succeeded,true);assert.equal(report.targetUniqueness.rule,'RULE_1');
});
test('unknown probe error content is redacted',async()=>{
  const {report}=await run([{phone:'+70000009999',brokerId:'6e414141-f2ca-4c71-8402-2032c9186568',amoSyncStatus:'SYNCED',amoLeadId:123}],false,false,'AMO_UNIQUENESS_PRIVATE_TOKEN');
  assert.equal(report.targetUniqueness.errorCode,'UNCLASSIFIED');
});
