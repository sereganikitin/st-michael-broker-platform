'use strict';
// One approved public portrait and one invitation, never an application deploy.
const fs = require('node:fs');
const crypto = require('node:crypto');
const digest = x => crypto.createHash('sha256').update(x).digest('hex');
const OLD = '40da6a435191fdc52aa65d4967cc34f0cd5a1d6af993829db477613fa9a29c5c';
const NEW = '33c3296e0b596d68742829e3986b38f41c239b99ce5dc0a4dab0514d222bba94';
const emit = x => console.log('CONTACT_PUBLICATION=' + JSON.stringify(x));
async function main() {
  const mode = process.env.MODE;
  if (!['plan', 'photo', 'invite', 'invite-status'].includes(mode)) throw Error('MODE');
  if (!mode.startsWith('invite')) {
    const target = '/app/apps/web/public/v2/img/manager-daria.webp';
    const backup = '/app/data/contact-publication-20261020';
    if (!fs.lstatSync(target).isFile() || fs.lstatSync(target).isSymbolicLink()) throw Error('TARGET');
    const before = fs.readFileSync(target);
    const oldHash = digest(before);
    if (mode === 'plan') { emit({mode, oldMatches:oldHash===OLD, newMatches:oldHash===NEW, bytes:before.length, writes:0}); return; }
    if (oldHash !== OLD) throw Error('OLD_HASH');
    const incoming = fs.readFileSync(process.env.PORTRAIT);
    if (digest(incoming)!==NEW || incoming.length!==684462 || incoming.toString('ascii',0,4)!=='RIFF' || incoming.toString('ascii',8,12)!=='WEBP') throw Error('PORTRAIT');
    fs.mkdirSync(backup, {mode:0o700}); // EEXIST refuses an uncertain/repeated attempt.
    fs.writeFileSync(backup+'/original.webp',before,{flag:'wx',mode:0o600});
    if (digest(fs.readFileSync(backup+'/original.webp'))!==OLD) throw Error('BACKUP');
    if (digest(fs.readFileSync(target))!==OLD) throw Error('DRIFT');
    const temp=target+'.20261020.pending';
    fs.writeFileSync(temp,incoming,{flag:'wx',mode:0o644});
    fs.renameSync(temp,target);
    if (digest(fs.readFileSync(target))!==NEW) throw Error('VERIFY');
    emit({mode, published:true, backupVerified:true, sha256:NEW, bytes:incoming.length, applicationRestarted:false, databaseWrites:0});
    return;
  }
  const {PrismaClient}=require('@st-michael/database');
  const u=new URL(process.env.DATABASE_URL);u.searchParams.set('options','-c default_transaction_read_only=on -c statement_timeout=15000');
  const p=new PrismaClient({datasources:{db:{url:u.toString()}},log:[]});
  let transport;
  try {
    const rows=await p.$queryRawUnsafe("SELECT current_setting('default_transaction_read_only') AS mode");
    if(rows.length!==1||rows[0].mode!=='on')throw Error('READONLY');
    const b=await p.broker.findUnique({where:{id:'2d935f82-2cf4-4cd2-878e-685cb77defe3'},select:{phone:true,email:true,role:true,status:true,mergedIntoId:true}});
    if(mode==='invite-status') {
      const dir='/app/uploads/contact-invitation-20261020';
      const receiptPath=dir+'/receipt.json';
      let accepted=null;
      if(fs.existsSync(receiptPath)) accepted=JSON.parse(fs.readFileSync(receiptPath,'utf8')).providerAccepted===true;
      emit({mode,accountExists:!!b,admin:b?.role==='ADMIN',active:b?.status==='ACTIVE',emailMatches:!!b?.email&&digest(b.email.toLowerCase())===process.env.RECIPIENT_HASH,phoneMatches:!!b?.phone&&digest(b.phone.replace(/\D/g,''))===process.env.PHONE_HASH,smtpConfigured:!!(process.env.SMTP_HOST&&process.env.SMTP_USER&&process.env.SMTP_PASS),armed:fs.existsSync(dir+'/armed.json'),providerAccepted:accepted,sendAttempts:0,databaseWrites:0});
      return;
    }
    // Exact recipient is read privately from the already verified account.
    if(!b||b.role!=='ADMIN'||b.status!=='ACTIVE'||b.mergedIntoId||digest(b.email.toLowerCase())!==process.env.RECIPIENT_HASH||digest(b.phone.replace(/\D/g,''))!==process.env.PHONE_HASH)throw Error('RECIPIENT');
    if(!process.env.SMTP_HOST||!process.env.SMTP_USER||!process.env.SMTP_PASS)throw Error('SMTP_CONFIG');
    const port=Number(process.env.SMTP_PORT||465);if(!Number.isInteger(port)||port<1||port>65535)throw Error('SMTP_PORT');
    const dir='/app/uploads/contact-invitation-20261020';
    fs.mkdirSync(dir,{mode:0o700}); // Durable once-only gate, before SMTP can run.
    fs.writeFileSync(dir+'/armed.json',JSON.stringify({armedAt:new Date().toISOString(),retryAuthorized:false}),{flag:'wx',mode:0o600});
    transport=require('nodemailer').createTransport({host:process.env.SMTP_HOST,port,secure:process.env.SMTP_SECURE!=='false',auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS},tls:{rejectUnauthorized:true},requireTLS:true,pool:false,logger:false,debug:false,connectionTimeout:15000,greetingTimeout:15000,socketTimeout:15000});
    const r=await transport.sendMail({from:process.env.SMTP_FROM||process.env.SMTP_USER,to:b.email,subject:'Доступ администратора — кабинет ST Michael',text:'Анастасия, здравствуйте!\n\nДля вашего существующего аккаунта в кабинете ST Michael предоставлен доступ администратора.\nВойти: https://broker.stmichael.ru/login\nИспользуйте ваш зарегистрированный номер телефона и установленный при регистрации пароль. Пароль не изменён. Если вы его забыли, воспользуйтесь ссылкой «Забыли пароль?» на странице входа.\n\nС уважением, команда ST Michael'});
    const ok=Array.isArray(r.accepted)&&r.accepted.length===1&&Array.isArray(r.rejected)&&r.rejected.length===0;
    fs.writeFileSync(dir+'/receipt.json',JSON.stringify({providerAccepted:ok,at:new Date().toISOString(),retryAuthorized:false}),{flag:'wx',mode:0o600});
    emit({mode,providerAccepted:ok,mailboxDeliveryVerified:false,attempts:1,automaticRetry:false,databaseWrites:0,passwordChanged:false});
    if(!ok)process.exitCode=1;
  } finally {try{transport?.close()}catch{} await p.$disconnect();}
}
if(require.main===module||process.env.CONTACT_EXECUTE==='1')main().catch(e=>{const allowed=['MODE','TARGET','OLD_HASH','PORTRAIT','BACKUP','DRIFT','VERIFY','READONLY','RECIPIENT','SMTP_CONFIG','SMTP_PORT'];emit({ok:false,error:allowed.includes(e?.message)?e.message:'SCOPED_OPERATION_REFUSED_OR_UNCONFIRMED',code:['EEXIST','ENOENT','EACCES','MODULE_NOT_FOUND','EAUTH','ESOCKET','ETIMEDOUT'].includes(e?.code)?e.code:null,automaticRetry:false});process.exitCode=1;});
module.exports={digest,OLD,NEW,main};
