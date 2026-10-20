'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('.github/workflows/audit-trend-submissions.yml','utf8').replace(/\r\n/g,'\n');
const program=source.split("<<'AUDIT'\n")[1].split('\n          AUDIT')[0];
test('eight exact cases remain read-only and private',async()=>{
  const cases=Array.from({length:8},(_,i)=>({case:i+1,client:'7000000000'+(i+1),agent:'7000000010'+(i+1),projects:['ZORGE9']}));
  const output=[];
  class PrismaClient{
    constructor(x){assert.match(new URL(x.datasources.db.url).searchParams.get('options'),/read_only=on/);}
    $queryRawUnsafe(){return [{mode:'on'}];}
    client={findMany:async()=>[]};broker={findMany:async()=>[]};systemSetting={findMany:async()=>[{value:'PRIVATE_TOKEN'}]};async $disconnect(){}
  }
  class AmoCrmAdapter{async findContactsByPhoneExact(){return [];}async checkUniqueness(){return {rule:'NO_CONFLICT'};}}
  await vm.runInNewContext(program,{URL,Set,Map,Buffer,Number,JSON,String,Error,Date,AbortSignal,process:{env:{AMO_TREND_BATCH:Buffer.from(JSON.stringify(cases)).toString('base64'),DATABASE_URL:'postgresql://x:y@localhost/db'},exitCode:0},require:s=>s.includes('database')?{PrismaClient}:s.includes('fields')?{}:{AmoCrmAdapter},console:{log:x=>output.push(x)}});
  assert.equal(output.length,1);assert.doesNotMatch(output[0],/700000000|700000001|PRIVATE_TOKEN/);
  const r=JSON.parse(output[0].split('=')[1]);assert.equal(r.cases.length,8);assert.equal(r.crmWrites,0);assert.equal(r.databaseWrites,0);assert.equal(r.redisWrites,0);
});
test('transport refuses non-GET and uses pinned SSH/private input',()=>{
  assert.ok(source.includes("init.method!=='GET'"));assert.ok(source.includes('StrictHostKeyChecking=yes'));assert.ok(source.includes('secrets.AMO_TREND_BATCH_20261020'));assert.doesNotMatch(source,/p\.(client|broker)\.(create|update|delete)|method:'POST'|method:'PATCH'/);
});
