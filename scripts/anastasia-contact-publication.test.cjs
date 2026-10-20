'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {digest,OLD,NEW}=require('./anastasia-contact-publication.cjs');
const source=fs.readFileSync('scripts/anastasia-contact-publication.cjs','utf8');
const workflow=fs.readFileSync('.github/workflows/publish-anastasia-contact.yml','utf8');
const vm=require('node:vm');
test('approved portrait is exact, valid WebP and differs from old portrait',()=>{
 const b=fs.readFileSync('apps/web/public/v2/img/manager-daria.webp');
 assert.equal(digest(b),NEW);assert.notEqual(NEW,OLD);assert.equal(b.length,684462);assert.equal(b.toString('ascii',8,12),'WEBP');
});
test('one invitation, verified recipient and role, no password/reset or CRM changes',()=>{
 assert.equal((source.match(/\.sendMail\(/g)||[]).length,1);
 assert.ok(source.indexOf("fs.mkdirSync(dir")<source.indexOf('.sendMail('));
 assert.match(source,/b.role!=='ADMIN'/);assert.match(source,/b.status!=='ACTIVE'/);
 assert.match(source,/default_transaction_read_only=on/);assert.match(source,/rejectUnauthorized:true/);
 assert.doesNotMatch(source,/\.\$executeRaw|p\.[a-zA-Z]+\.(update|create|delete)\(|forgotPassword|rejectUnauthorized:false/);
 assert.match(workflow,/test "\$ATTEMPT" = 1/);assert.match(workflow,/cancel-in-progress: false/);
});
test('portrait preserves original before atomic replacement and verifies HTTPS',()=>{
 assert.ok(source.indexOf("backup+'/original.webp',before")<source.indexOf('fs.renameSync(temp,target)'));
 assert.match(source,/oldHash !== OLD/);assert.match(workflow,/CONTACT_HTTPS_VERIFIED=true/);
 assert.match(workflow,/conclusion=="success"/);assert.doesNotMatch(workflow,/docker (restart|compose)|git (reset|checkout)|curl[^\n]+ -k/);
});
async function simulate({role='ADMIN',alreadyArmed=false,recipientMatches=true}={}) {
 const actions=[],out=[];let sent=0;
 const mail='recipient@example.test',phone='70000000000';
 const fakeFs={mkdirSync:()=>{actions.push('arm');if(alreadyArmed)throw Error('EXISTS');},writeFileSync:()=>actions.push('receipt')};
 class PrismaClient {
  constructor(options){assert.match(options.datasources.db.url,/read_only/);}
  async $queryRawUnsafe(){return [{mode:'on'}];}
  broker={findUnique:async()=>({email:mail,phone,role,status:'ACTIVE',mergedIntoId:null})};
  async $disconnect(){}
 }
 const context={require:x=>x==='node:fs'?fakeFs:x==='node:crypto'?require(x):x==='@st-michael/database'?{PrismaClient}:x==='nodemailer'?{createTransport:options=>{assert.equal(options.tls.rejectUnauthorized,true);return {sendMail:async message=>{assert.equal(message.to,mail);sent++;actions.push('send');return {accepted:[mail],rejected:[]};},close(){}};}}:null,module:{exports:{}},URL,console:{log:x=>out.push(x)},process:{env:{MODE:'invite',DATABASE_URL:'postgresql://u:p@localhost/db',RECIPIENT_HASH:recipientMatches?digest(mail):'wrong',PHONE_HASH:digest(phone),SMTP_HOST:'smtp.example.test',SMTP_USER:'sender',SMTP_PASS:'secret'}}};
 vm.runInNewContext(source,context);
 try{await context.module.exports.main();}catch{}
 return {sent,actions,out};
}
test('invitation is armed before exactly one send and does not expose recipient',async()=>{
 const r=await simulate();assert.equal(r.sent,1);assert.ok(r.actions.indexOf('arm')<r.actions.indexOf('send'));assert.doesNotMatch(r.out.join(''),/recipient@example|secret|70000000000/);
});
test('wrong role or recipient and existing durable marker refuse all mail',async()=>{
 for(const args of [{role:'BROKER'},{recipientMatches:false},{alreadyArmed:true}])assert.equal((await simulate(args)).sent,0);
});
