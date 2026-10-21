'use strict';
const USERNAME='wladimirvarrior';
const equalName=value=>String(value||'').replace(/^@/,'').toLowerCase()===USERNAME;
function candidateIds(inbox,state){
 const ids=new Set();
 for(const row of inbox)if(equalName(row.fromUsername)&&/^[1-9][0-9]{0,19}$/.test(String(row.chatId)))ids.add(String(row.chatId));
 for(const [id,user] of Object.entries(state?.users||{}))if(equalName(user?.username)&&user?.active===true&&user.chatId===id&&/^[1-9][0-9]{0,19}$/.test(id))ids.add(id);
 return [...ids];
}
async function main(){
 const {PrismaClient}=require('@st-michael/database');const url=new URL(process.env.DATABASE_URL);url.searchParams.set('options','-c default_transaction_read_only=on -c statement_timeout=15000');
 const p=new PrismaClient({datasources:{db:{url:url.toString()}},log:[]});
 try{
  const check=await p.$queryRaw`SELECT current_setting('default_transaction_read_only') AS mode`;if(check[0]?.mode!=='on')throw Error('READONLY');
  const inbox=await p.opsInboxMessage.findMany({where:{fromUsername:{equals:USERNAME,mode:'insensitive'}},select:{chatId:true,fromUsername:true,sentAt:true},orderBy:{sentAt:'desc'},take:100});
  const stored=await p.systemSetting.findUnique({where:{key:'OPS_SUPPORT_ACCESS_STATE'},select:{value:true}});const state=stored?JSON.parse(stored.value):{};
  const ids=candidateIds(inbox,state);if(ids.length>2)throw Error('AMBIGUOUS');
  const token=(process.env.OPS_TELEGRAM_BOT_TOKEN||process.env.TELEGRAM_BOT_TOKEN||'').trim();if(!token)throw Error('TOKEN_MISSING');
  const origin=(process.env.TELEGRAM_API_BASE||'https://api.telegram.org').replace(/\/+$/,'');
  async function tg(method,query=''){if(!['getMe','getChat'].includes(method))throw Error('METHOD');const response=await fetch(origin+'/bot'+token+'/'+method+query,{method:'GET',redirect:'error',signal:AbortSignal.timeout(15000)});const body=await response.json();if(!response.ok||body.ok!==true)throw Error('TELEGRAM_READ_FAILED');return body.result;}
  const me=await tg('getMe');let verified=0,privateInboxSeen=false,supportUserSeen=false,alreadyRecipient=false;
  const current=new Set([process.env.OPS_ALERT_CHAT_ID,process.env.OPS_ALERT_CHAT_IDS].flatMap(v=>String(v||'').split(/[\s,;]+/)).filter(Boolean));
  for(const id of ids){const chat=await tg('getChat','?chat_id='+id);if(String(chat.id)===id&&chat.type==='private'&&equalName(chat.username)){verified++;privateInboxSeen||=inbox.some(r=>String(r.chatId)===id);supportUserSeen||=state.users?.[id]?.active===true;alreadyRecipient||=current.has(id);}}
  console.log('VLADIMIR_TELEGRAM='+JSON.stringify({ok:true,readOnly:true,botUsername:String(me.username||''),candidateCount:ids.length,verifiedTargetCount:verified,privateInboxSeen,supportUserSeen,currentRecipientCount:current.size,alreadyRecipient,canConfigure:verified===1&&(privateInboxSeen||supportUserSeen),messagesSent:0,getUpdatesCalled:false,requestedQuietHours:{start:'19:00',end:'10:00',timeZone:'Europe/Moscow'}}));
 }finally{await p.$disconnect();}
}
module.exports={candidateIds,equalName};
if(require.main===module||process.env.EXEC_VLADIMIR_TELEGRAM==='1')main().catch(()=>{console.log('VLADIMIR_TELEGRAM='+JSON.stringify({ok:false,readOnly:true,error:'INSPECTION_REFUSED',messagesSent:0}));process.exitCode=1;});
