'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const source=fs.readFileSync('scripts/pinned-corporate-invitation.cjs','utf8');
const workflow=fs.readFileSync('.github/workflows/pinned-corporate-mail.yml','utf8');
const {config,failure,PIN}=require('./pinned-corporate-invitation.cjs');
test('certificate input is mandatory and cannot silently fall back',()=>{
 assert.throws(()=>config({}));
 assert.match(source,/hash\(cert.raw\)!==PIN/);assert.match(source,/cert.checkHost\(NAME\)/);
 assert.match(source,/rejectUnauthorized:true/);assert.match(source,/requireTLS:true/);
 assert.doesNotMatch(source,/rejectUnauthorized:\s*false/);
 assert.equal(PIN.length,64);
});
test('transport validates the exact peer pin as well as hostname',()=>{
 assert.match(source,/hash\(peer.raw\)!==PIN/);assert.match(source,/tls.checkServerIdentity\(NAME,peer\)/);
});
test('peer observation preserves the real TLS call and restores it after verify',()=>{
 assert.match(source,/Reflect.apply\(originalConnect,this,args\)/);
 assert.match(source,/prependOnceListener\('secure'/);
 assert.match(source,/finally\{tls.connect=originalConnect;\}/);
 assert.doesNotMatch(source,/authorizationError\s*=|\.authorized\s*=|emit\('secure/);
});
test('inspection returns before account access and all sends are once-only',()=>{
 assert.ok(source.indexOf("env.MAIL_MODE==='inspect'")<source.indexOf('const {PrismaClient}'));
 assert.match(source,/fs.mkdirSync\(dir,\{mode:0o700\}\)/);
 assert.match(source,/flag:'wx'/);assert.match(workflow,/test "\$ATTEMPT" = 1/);
 assert.match(source,/CONFIRM_SEND!=='true'/);
});
test('reset uses deployed recovery method and limits writes to its two token fields',()=>{
 assert.match(source,/AuthService.prototype.forgotPassword.call/);
 assert.match(source,/passwordResetExpiresAt,passwordResetToken/);
 assert.match(source,/rows.length!==1/);assert.match(source,/\+\+updates!==1/);assert.match(source,/\+\+submissions!==1/);
 assert.match(source,/passwordChanged:false/);
 assert.doesNotMatch(source,/authVersion\s*:|resetPassword\(/);
 assert.match(source,/Object.keys\(query.data\).sort\(\).join\(','\)!=='passwordResetExpiresAt,passwordResetToken'/);
});
test('exceptions cannot disclose SMTP data or token URLs',()=>{
 assert.deepEqual(failure({message:'PRIVATE password token',code:'UNKNOWN'}),{code:null,reason:'CONNECTION_OR_SEND_FAILED',certificateReason:null});
 assert.equal(failure({message:'self-signed certificate',code:'ESOCKET'}).certificateReason,'SELF_SIGNED');
 assert.equal(failure({message:'CERTIFICATE_PIN_MISMATCH',code:'ESOCKET'}).certificateReason,'PEER_PIN_MISMATCH');
 assert.match(source,/console.error=\(\)=>\{\}/);
 assert.match(workflow,/StrictHostKeyChecking=yes/);
});
