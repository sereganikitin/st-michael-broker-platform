'use strict';
const fs=require('node:fs'), crypto=require('node:crypto'), tls=require('node:tls');
const PIN='7e9bd0394103eb36d7e5c9af15df6ecee4e2fad2b60874184092e5adcb0d50de';
const NAME='mail.zorge9.com';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const emit=r=>console.log('PINNED_MAIL='+JSON.stringify(r));
function config(env){
 const cert=new crypto.X509Certificate(Buffer.from(env.SMTP_CERT_BASE64||'','base64'));
 if(hash(cert.raw)!==PIN||!cert.checkHost(NAME)||Date.parse(cert.validFrom)>Date.now()||Date.parse(cert.validTo)<Date.now())throw Error('CERTIFICATE_REFUSED');
 if(env.SMTP_HOST!=='mail.stmichael.ru'||Number(env.SMTP_PORT)!==587||env.SMTP_SECURE!=='false'||!env.SMTP_USER||!env.SMTP_PASS)throw Error('CONFIG_REFUSED');
 return {host:env.SMTP_HOST,port:587,secure:false,requireTLS:true,auth:{user:env.SMTP_USER,pass:env.SMTP_PASS},tls:{ca:cert.toString(),servername:NAME,rejectUnauthorized:true,checkServerIdentity:(_host,peer)=>hash(peer.raw)!==PIN?Error('CERTIFICATE_PIN_MISMATCH'):tls.checkServerIdentity(NAME,peer)},logger:false,debug:false,pool:false,connectionTimeout:15000,greetingTimeout:15000,socketTimeout:15000};
}
function failure(e){
 const codes=['EAUTH','ESOCKET','ETLS','ETIMEDOUT','ETIMEOUT','ECONNRESET','ECONNREFUSED','ENOTFOUND','EAI_AGAIN','CERT_HAS_EXPIRED','DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN','ERR_TLS_CERT_ALTNAME_INVALID','EEXIST','EACCES'];
 const reasons=['CERTIFICATE_REFUSED','CONFIG_REFUSED','MODE_REFUSED','RECIPIENT_REFUSED','SMTP_VERIFY_FAILED'];
 const hint=String(e?.message||'');
 const certificateReason=/self.signed/i.test(hint)?'SELF_SIGNED':/unable to verify|unable to get local issuer/i.test(hint)?'CHAIN_UNVERIFIED':/expired/i.test(hint)?'EXPIRED':/CERTIFICATE_PIN_MISMATCH/.test(hint)?'PEER_PIN_MISMATCH':/altname|hostname|altnames/i.test(hint)?'HOSTNAME_MISMATCH':/certificate/i.test(hint)?'OTHER_CERTIFICATE_FAILURE':null;
 return {code:codes.includes(e?.code)?e.code:null,reason:reasons.includes(e?.message)?e.message:'CONNECTION_OR_SEND_FAILED',certificateReason};
}
async function run(env=process.env,dependencies={}){
 let transport,p,armed=false,sendInvoked=false;const dir=env.MAIL_MODE==='reset'?'/app/uploads/owner-reset-certificate-20261020':'/app/uploads/contact-invitation-certificate-20261020';
 try{
  if(!['inspect','send','reset'].includes(env.MAIL_MODE)||(env.MAIL_MODE!=='inspect'&&env.CONFIRM_SEND!=='true'))throw Error('MODE_REFUSED');
  transport=(dependencies.createTransport||require('nodemailer').createTransport)(config(env));
  if(await transport.verify()!==true)throw Error('SMTP_VERIFY_FAILED');
  if(env.MAIL_MODE==='inspect'){const report={ok:true,mode:'inspect',certificatePinMatched:true,hostnameVerified:NAME,tlsVerified:true,smtpVerified:true,emailSent:false};emit(report);return report;}
  const {PrismaClient}=dependencies.database||require('@st-michael/database');
  const u=new URL(env.DATABASE_URL);u.searchParams.set('options',(env.MAIL_MODE==='reset'?'':'-c default_transaction_read_only=on ')+'-c statement_timeout=15000');
  p=new PrismaClient({datasources:{db:{url:u.toString()}},log:[]});
  if(env.MAIL_MODE==='reset'){
   const email='mefremov@stmichael.ru';
   const rows=await p.broker.findMany({where:{email,status:'ACTIVE',passwordHash:{not:null},mergedIntoId:null},take:2,select:{id:true,email:true,fullName:true,passwordHash:true,passwordResetToken:true,passwordResetExpiresAt:true}});
   if(rows.length!==1)throw Error('RECIPIENT_REFUSED');
   const target=rows[0];
   fs.mkdirSync(dir,{mode:0o700});armed=true;
   fs.writeFileSync(dir+'/armed.json',JSON.stringify({at:new Date().toISOString(),automaticRetry:false}),{flag:'wx',mode:0o600});
   // Invoke the existing deployed recovery method, with its normal token and
   // expiry generation. Only its transport is replaced in this isolated process.
   const nodemailer=require('nodemailer'),original=nodemailer.createTransport;
   const originalError=console.error,originalLog=console.log;
   let updates=0,submissions=0,result,sendFailure;
   const bounded={broker:{findFirst:async(query)=>{if(query?.where?.email!==email||query.where.status!=='ACTIVE'||query.where.passwordHash?.not!==null)throw Error('RECIPIENT_REFUSED');return target;},update:async(query)=>{if(++updates!==1||query?.where?.id!==target.id||Object.keys(query.data).sort().join(',')!=='passwordResetExpiresAt,passwordResetToken')throw Error('RECIPIENT_REFUSED');const changed=await p.broker.updateMany({where:{id:target.id,email,status:'ACTIVE',mergedIntoId:null,passwordHash:target.passwordHash,passwordResetToken:target.passwordResetToken,passwordResetExpiresAt:target.passwordResetExpiresAt},data:query.data});if(changed.count!==1)throw Error('RECIPIENT_REFUSED');return {id:target.id};}}};
   nodemailer.createTransport=()=>({sendMail:async(message)=>{if(++submissions!==1||message.to!==email||typeof message.html!=='string'||!message.html.includes('https://broker.stmichael.ru/reset-password?token='))throw Error('RECIPIENT_REFUSED');sendInvoked=true;try{result=await transport.sendMail(message);return result;}catch(e){sendFailure=e;throw e;}}});
   console.error=()=>{};console.log=()=>{};
   try{const {AuthService}=require('/app/apps/api/dist/auth/auth.service');await AuthService.prototype.forgotPassword.call({prisma:bounded},email);}
   finally{nodemailer.createTransport=original;console.error=originalError;console.log=originalLog;}
   const accepted=!!result&&Array.isArray(result.accepted)&&result.accepted.length===1&&String(result.accepted[0]).toLowerCase()===email&&Array.isArray(result.rejected)&&result.rejected.length===0;
   const report={ok:accepted,mode:'reset',providerAccepted:accepted,mailboxDeliveryVerified:false,tlsVerified:true,certificatePinMatched:true,sendAttempts:submissions,resetRequested:updates===1,passwordChanged:false,automaticRetry:false,...(sendFailure?failure(sendFailure):{})};
   fs.writeFileSync(dir+'/receipt.json',JSON.stringify({...report,at:new Date().toISOString()}),{flag:'wx',mode:0o600});emit(report);return report;
  }
  const b=await p.broker.findUnique({where:{id:'2d935f82-2cf4-4cd2-878e-685cb77defe3'},select:{email:true,role:true,status:true,mergedIntoId:true}});
  if(!b||b.role!=='ADMIN'||b.status!=='ACTIVE'||b.mergedIntoId||hash(String(b.email).toLowerCase())!=='9794e54229e642cc581d8515e53f09bc39ba4f26b5596e3fb0db0def73b78054')throw Error('RECIPIENT_REFUSED');
  fs.mkdirSync(dir,{mode:0o700});armed=true;
  fs.writeFileSync(dir+'/armed.json',JSON.stringify({at:new Date().toISOString(),priorUnconfirmedAttemptPreserved:true,automaticRetry:false}),{flag:'wx',mode:0o600});
  sendInvoked=true;
  const result=await transport.sendMail({from:env.SMTP_FROM||env.SMTP_USER,to:b.email,subject:'Доступ администратора — кабинет ST Michael',text:'Анастасия, здравствуйте!\n\nВ вашем существующем аккаунте ST Michael предоставлен доступ администратора.\n\nВойти в кабинет: https://broker.stmichael.ru/login\nИспользуйте номер телефона и пароль, указанные при регистрации. Пароль не изменён. Если вы забыли пароль, воспользуйтесь ссылкой «Забыли пароль?» на странице входа.\n\nС уважением, команда ST Michael'});
  const accepted=Array.isArray(result.accepted)&&result.accepted.length===1&&String(result.accepted[0]).toLowerCase()===String(b.email).toLowerCase()&&Array.isArray(result.rejected)&&result.rejected.length===0;
  const report={ok:accepted,mode:'send',providerAccepted:accepted,mailboxDeliveryVerified:false,tlsVerified:true,certificatePinMatched:true,hostnameVerified:NAME,sendAttempts:1,automaticRetry:false,passwordChanged:false,databaseWrites:0};
  fs.writeFileSync(dir+'/receipt.json',JSON.stringify({...report,at:new Date().toISOString()}),{flag:'wx',mode:0o600});emit(report);return report;
 }catch(e){const report={ok:false,mode:env.MAIL_MODE,...failure(e),armed,sendInvoked,automaticRetry:false};if(armed){try{fs.writeFileSync(dir+'/failure.json',JSON.stringify(report),{flag:'wx',mode:0o600});}catch{}}emit(report);return report;}
 finally{try{transport?.close();}catch{}try{await p?.$disconnect();}catch{}}
}
module.exports={config,failure,run,PIN,NAME};
if(require.main===module||process.env.EXEC_PINNED_MAIL==='1')run().then(r=>{if(!r.ok)process.exitCode=1;});
