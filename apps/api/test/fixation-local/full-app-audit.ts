// Disposable verification branch only. No production credentials or business writes.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Test } from '@nestjs/testing';
import { Logger, ValidationPipe } from '@nestjs/common';
import { sign } from 'jsonwebtoken';
import { AmoCrmAdapter } from '@st-michael/integrations';
import { configureLocal, fakeCrm, seedBroker, until, blockedExternal } from './harness';

Logger.overrideLogger(false);
(BigInt.prototype as any).toJSON = function () { return this.toString(); };
async function main() {
  const results: string[] = [];
  const crm = await fakeCrm();
  configureLocal(crm.origin);
  const { AppModule } = await import('../../src/app.module');
  const { ClientFixationService } = await import('../../src/client-fixation/client-fixation.service');
  const { FixationRequestService } = await import('../../src/client-fixation/fixation-request.service');
  const { ZodExceptionFilter } = await import('../../src/common/zod-exception.filter');
  const amo = new AmoCrmAdapter();
  amo.checkUniqueness = (phone: string) => (amo as any).request(`/local-uniqueness?phone=${encodeURIComponent(phone)}`);
  amo.createFixationRequest = async (data: any) => {
    const response = await (amo as any).request('/leads', {method:'POST',body:JSON.stringify([data])}, {retryTransient:false});
    return response._embedded.leads[0];
  };
  amo.syncAgencyCompanyToAmoContact = async () => null;
  const module = await Test.createTestingModule({imports:[AppModule]})
    .overrideProvider(AmoCrmAdapter).useValue(amo).compile();
  const app = module.createNestApplication({logger:false});
  const express = require('express');
  app.use(express.urlencoded({extended:true,limit:'5mb'}));
  app.use(express.json({limit:'5mb'}));
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({whitelist:true,forbidNonWhitelisted:true,transform:true}));
  app.useGlobalFilters(new ZodExceptionFilter());
  const db: any = module.get('PrismaClient');
  const fixation: any = module.get(ClientFixationService);
  fixation.ensureBrokerAmoContact = (id: string) => db.broker.findUniqueOrThrow({where:{id}});
  fixation.sleep = async () => {};
  const outbox = module.get(FixationRequestService);
  let web: ReturnType<typeof spawn> | undefined;
  try {
    await app.listen(4000,'127.0.0.1');
    results.push('Complete AppModule initialized with real database, queues, cron discovery and HTTP parser');
    const ready = await fetch('http://127.0.0.1:4000/api/health/ready');
    assert.equal(ready.status,200);
    const readiness: any = await ready.json();
    assert.equal(readiness.checks.postgresql,'ok'); assert.equal(readiness.checks.redis,'ok');
    results.push('Real readiness PostgreSQL Redis');
    const broker = await seedBroker(db), other = await seedBroker(db), manager = await seedBroker(db,'MANAGER');
    // Real AuthService rejects unregistered seed-only brokers without a password.
    const bcrypt = await import('bcrypt');
    await db.broker.updateMany({where:{id:{in:[broker.id,other.id,manager.id]}},data:{passwordHash:await bcrypt.hash('isolated-test-only-password',4)}});
    const token = (actor = broker) => sign({sub:actor.id,authVersion:0,type:'access'},process.env.JWT_SECRET!,{expiresIn:'15m'});
    const api = async (path: string, data?: any, actor = broker) => {
      const response = await fetch(`http://127.0.0.1:4000/api${path}`,{
        method:data ? 'POST':'GET',headers:{authorization:`Bearer ${token(actor)}`,'content-type':'application/json'},
        ...(data ? {body:JSON.stringify(data)} : {})});
      return {status:response.status,body:await response.json()};
    };
    assert.equal((await fetch('http://127.0.0.1:4000/api/clients/fixation-requests')).status,401);
    assert.equal((await api('/clients/fixation-requests/admin/queue')).status,403);
    assert.equal((await api('/clients/fixation-requests/admin/queue',undefined,manager)).status,200);
    results.push('Real JWT and role gates');
    const phone = '+70001999001';
    await db.agency.upsert({where:{inn:'7700000000'},create:{inn:'7700000000',name:'Synthetic full application'},update:{}});
    const payload = {phone,fullName:'Synthetic full application client',project:'SILVER_BOR',agencyInn:'7700000000',idempotencyKey:randomUUID()};
    const submitted = await Promise.all(Array.from({length:10},()=>api('/clients/fix',payload)));
    assert(submitted.every(r=>r.status===201));
    const id = submitted[0].body.requestId;
    assert(id); assert(submitted.every(r=>r.body.requestId===id));
    await outbox.drain();
    await until(async()=> (await api(`/clients/fixation-requests/${id}`)).body.requestState==='COMPLETED');
    const row = await db.client.findUniqueOrThrow({where:{fixationRequestId:id}});
    assert(row.amoLeadId); assert.equal(crm.posts.filter(p=>p.phone===phone).length,1);
    assert.equal((await api(`/clients/fixation-requests/${id}`,undefined,other)).status,404);
    results.push('Concurrent HTTP intake, real complete provider graph, durable completion, actor isolation, one CRM POST');
    const leadId = Number(row.amoLeadId);
    crm.leads.get(leadId).status_id=143;
    const form = new URLSearchParams({ 'leads[status][0][id]':String(leadId),'leads[status][0][status_id]':'143' });
    const response = await fetch('http://127.0.0.1:4000/api/webhooks/amo/lead-update', {method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:form});
    assert(response.ok);
    assert.equal((await api(`/clients/fixation-requests/${id}`)).body.status,'REJECTED');
    results.push('Real nested form webhook parser and current result readback');
    web = spawn(process.execPath,['../../node_modules/next/dist/bin/next','start','-p','3000','-H','127.0.0.1'], {cwd:'apps/web',env:{...process.env,NODE_ENV:'production'},stdio:'ignore'});
    await until(async()=> {try{return (await fetch('http://127.0.0.1:3000/login')).ok;}catch{return false;}},30000);
    for (const path of ['/login','/fixation','/clients']) {
      const page = await fetch(`http://127.0.0.1:3000${path}`);
      assert.equal(page.status,200); assert((await page.text()).includes('<html'));
    }
    results.push('Compiled full Next application starts and renders login fixation and clients routes');
    assert.equal(blockedExternal.length,0);
    mkdirSync('tmp/fixation-local',{recursive:true});
    writeFileSync('tmp/fixation-local/full-app-audit.json',JSON.stringify({sourceHead:'c115bf76cda1ee7bdec6f2dc3a860baf58e4bc48',passed:results,externalCrm:'HTTP fake only; no real amo sandbox',productionWrites:false},null,2));
    console.log(JSON.stringify({passed:results.length,externalRequests:blockedExternal.length}));
  } finally {
    web?.kill();
    await app.close();
    await db.$disconnect();
    await crm.close();
  }
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e instanceof assert.AssertionError ? e.message : String(e?.code || e?.message || 'AUDIT_FAILED'));process.exit(1);});
