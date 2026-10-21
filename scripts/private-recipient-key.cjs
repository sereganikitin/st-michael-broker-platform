'use strict';
// Local-only key material. Never add the generated directory to a handoff.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
if(process.argv[2]==='generate'){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'stm-recipient-key-'));
 const pair=crypto.generateKeyPairSync('rsa',{modulusLength:4096,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
 fs.writeFileSync(path.join(dir,'private.pem'),pair.privateKey,{mode:0o600});
 console.log(JSON.stringify({directory:dir,publicKey:Buffer.from(pair.publicKey).toString('base64')}));
}else if(process.argv[2]==='sync'){
 const dir=path.resolve(process.argv[3]),run=process.argv[4];
 if(!/^stm-recipient-key-[A-Za-z0-9]+$/.test(path.basename(dir))||path.dirname(dir)!==path.resolve(os.tmpdir())||!/^\d+$/.test(run))throw Error('INPUT');
 const call=(args,input)=>{const r=spawnSync('gh',args,{input,encoding:'utf8',windowsHide:true});if(r.status!==0)throw Error('GITHUB_REQUEST_FAILED');return r.stdout;};
 const jobs=JSON.parse(call(['api',`repos/sereganikitin/st-michael-broker-platform/actions/runs/${run}/jobs`]));
 const job=jobs.jobs.find(j=>j.name==='install');if(!job)throw Error('JOB');
 const log=call(['api',`repos/sereganikitin/st-michael-broker-platform/actions/jobs/${job.id}/logs`]);
 const matches=[...log.matchAll(/TECHNICAL_RECIPIENT_RESULT=(\{"ok"[^\r\n]+\})/g)];if(matches.length!==1)throw Error('REPORT');
 const report=JSON.parse(matches[0][1]);if(!report.ok||!report.configured)throw Error('INSTALL_NOT_CONFIRMED');
 const value=JSON.parse(crypto.privateDecrypt({key:fs.readFileSync(path.join(dir,'private.pem')),oaepHash:'sha256'},Buffer.from(report.sealedRecipients,'base64')).toString());
 if(Object.keys(value).join()!=='OPS_ALERT_CHAT_IDS'||!/^\d+(,\d+){2}$/.test(value.OPS_ALERT_CHAT_IDS))throw Error('SCOPE');
 call(['secret','set','OPS_ALERT_CHAT_IDS','--repo','sereganikitin/st-michael-broker-platform'],value.OPS_ALERT_CHAT_IDS);
 delete report.sealedRecipients;report.githubRecipientsSynchronized=true;
 fs.unlinkSync(path.join(dir,'private.pem'));fs.rmdirSync(dir);
 console.log(JSON.stringify(report));
}else throw Error('MODE');
