'use strict';
// Private stdout is consumed by the installer, never published as a job log.
const {createHash}=require('node:crypto');
const ids=(...values)=>[...new Set(values.flatMap(v=>String(v||'').split(/[\s,;]+/)).filter(v=>/^-?\d+$/.test(v)))];
async function main(){
 const {PrismaClient}=require('@st-michael/database');
 const url=new URL(process.env.DATABASE_URL);url.searchParams.set('options','-c default_transaction_read_only=on -c statement_timeout=15000');
 const db=new PrismaClient({datasources:{db:{url:url.toString()}},log:[]});
 try{
  if((await db.$queryRaw`SELECT current_setting('default_transaction_read_only') AS mode`)[0]?.mode!=='on')throw Error();
  const rows=await db.opsInboxMessage.findMany({where:{fromUsername:{equals:'vishstmichael',mode:'insensitive'}},select:{chatId:true},take:100});
  const candidates=ids(...rows.map(r=>r.chatId)).filter(id=>/^[1-9]\d*$/.test(id));
  if(candidates.length!==1)throw Error();
  const target=candidates[0], token=(process.env.OPS_TELEGRAM_BOT_TOKEN||process.env.TELEGRAM_BOT_TOKEN||'').trim();
  const origin=(process.env.TELEGRAM_API_BASE||'https://api.telegram.org').replace(/\/+$/,'');
  async function get(method,query=''){
   const r=await fetch(origin+'/bot'+token+'/'+method+query,{method:'GET',redirect:'error',signal:AbortSignal.timeout(15000)});
   const p=await r.json();if(!r.ok||p.ok!==true)throw Error();return p.result;
  }
  const me=await get('getMe'), chat=await get('getChat','?chat_id='+target);
  if(me.username!=='brokerStMichaelbot'||String(me.id)!==token.split(':')[0]||String(chat.id)!==target||chat.type!=='private'||String(chat.username).toLowerCase()!=='vishstmichael')throw Error();
  const current=ids(process.env.OPS_ALERT_CHAT_IDS,process.env.OPS_ALERT_CHAT_ID);
  if(current.length!==2||current.includes(target))throw Error();
  const admins=ids(process.env.OPS_SUPPORT_ADMIN_IDS||process.env.OPS_ALERT_CHAT_IDS||process.env.OPS_ALERT_CHAT_ID).filter(id=>/^\d+$/.test(id));
  const stored=await db.systemSetting.findUnique({where:{key:'TELEGRAM_NEWS_MODERATOR_CHAT_IDS'},select:{value:true}});
  const moderators=ids(stored?.value).length?ids(stored.value):ids(process.env.TELEGRAM_NEWS_MODERATOR_CHAT_IDS).length?ids(process.env.TELEGRAM_NEWS_MODERATOR_CHAT_IDS):current;
  if(!admins.length||!moderators.length||admins.includes(target)||moderators.includes(target))throw Error();
  const chat2=await get('getChat','?chat_id='+target);
  if(String(chat2.id)!==target||chat2.type!=='private'||String(chat2.username).toLowerCase()!=='vishstmichael')throw Error();
  console.log(JSON.stringify({target,botId:String(me.id),tokenHash:createHash('sha256').update(token).digest('hex'),oldRecipients:current,
   changes:{OPS_ALERT_CHAT_IDS:ids(...current,target).join(','),OPS_SUPPORT_ADMIN_IDS:admins.join(','),TELEGRAM_NEWS_MODERATOR_CHAT_IDS:moderators.join(',')}}));
 }finally{await db.$disconnect();}
}
if(require.main===module||process.env.PREPARE_VISH_RECIPIENT==='1')main().catch(()=>{process.stderr.write('recipient_preparation_refused\n');process.exitCode=1;});
module.exports={ids};
