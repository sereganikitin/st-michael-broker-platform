'use strict';
// Read-only proof for the one case shown in the owner's alert. No CRM writer.
const {createHash}=require('node:crypto');
const ID='eeac5e36-7440-4585-895d-465fa70a9813';
const SELECT={id:true,phone:true,fullName:true,project:true,createdAt:true,updatedAt:true,amoLeadId:true,amoSyncStatus:true,amoSyncError:true,amoSyncAttempts:true,brokerId:true,responsibleBrokerId:true,fixationStatus:true,uniquenessStatus:true,broker:{select:{id:true,amoContactId:true}},responsibleBroker:{select:{id:true,amoContactId:true}}};
const norm=v=>{let s=String(v||'').replace(/\D/g,'');if(s.length===11&&s[0]==='8')s='7'+s.slice(1);if(s.length===10)s='7'+s;return /^7\d{10}$/.test(s)?s:null;};
const snapshot=r=>createHash('sha256').update(JSON.stringify(r,(_,v)=>typeof v==='bigint'?String(v):v)).digest('hex');
function field(entity,id){const f=(entity.custom_fields_values||[]).filter(x=>Number(x.field_id)===id);if(f.length>1)throw Error('FIELD_AMBIGUOUS');return f[0]?.values||[];}
function classify(row,lead,contactId){
 const ids=(lead._embedded?.contacts||[]).map(x=>Number(x.id));
 const broker=Number((row.responsibleBroker||row.broker)?.amoContactId);
 const delta=Number(lead.created_at)-Math.floor(new Date(row.createdAt).getTime()/1000);
 const project={ZORGE9:'Зорге 9',SILVER_BOR:'Берзарина 37',TOLBUKHINA:'Толбухина'}[row.project];
 return {leadId:Number(lead.id),pipelineId:Number(lead.pipeline_id),statusId:Number(lead.status_id),exactGeneratedName:lead.name===`Фиксация: ${row.fullName} (${row.project})`,clientContactLinked:ids.includes(contactId),brokerContactLinked:Number.isSafeInteger(broker)&&broker>0&&ids.includes(broker),contactRoleCollision:contactId===broker,createdSecondsFromCase:delta,createdWithinWindow:delta>=-120&&delta<=900,projectMatches:!!project&&field(lead,839179).some(x=>x.value===project),fromBroker:field(lead,665195).some(x=>Number(x.enum_id)===985337)};
}
async function main(){
 const {PrismaClient}=require('@st-michael/database');const u=new URL(process.env.DATABASE_URL);u.searchParams.set('options','-c default_transaction_read_only=on -c statement_timeout=15000');
 const p=new PrismaClient({datasources:{db:{url:u.toString()}},log:[]});let calls=0;
 try{
  const mode=await p.$queryRaw`SELECT current_setting('default_transaction_read_only') AS mode`;if(mode[0]?.mode!=='on')throw Error('READONLY_REFUSED');
  const row=await p.client.findUnique({where:{id:ID},select:SELECT});if(!row)throw Error('CASE_MISSING');
  const token=await p.systemSetting.findUnique({where:{key:'AMO_ACCESS_TOKEN'},select:{value:true}});const access=token?.value||process.env.AMO_ACCESS_TOKEN;if(!access)throw Error('TOKEN_MISSING');
  async function get(path){if(!/^\/api\/v4\/(?:account|contacts(?:\/[1-9]\d*)?|leads(?:\/[1-9]\d*)?)(?:\?.*)?$/.test(path)||++calls>90)throw Error('GET_BOUND');const response=await fetch('https://stmichael.amocrm.ru'+path,{method:'GET',headers:{Authorization:'Bearer '+access},redirect:'error',signal:AbortSignal.timeout(20000)});if(response.status===204)return {};if(!response.ok)throw Error('HTTP_'+response.status);const text=await response.text();if(text.length>4000000)throw Error('BODY_BOUND');return JSON.parse(text);}
  const account=await get('/api/v4/account');if(Number(account.id)!==28552900)throw Error('ACCOUNT_REFUSED');
  const phone=norm(row.phone);if(!phone)throw Error('PHONE_REFUSED');const contacts=[];let complete=false;
  for(let page=1;page<=10;page++){const result=await get('/api/v4/contacts?limit=250&page='+page+'&query='+phone.slice(-10));const list=result._embedded?.contacts||[];if(!Array.isArray(list))throw Error('CONTACT_SHAPE');for(const c of list)if(field(c,557903).some(x=>norm(x.value)===phone))contacts.push(c);if(!result._links?.next){complete=true;break;}}
  if(!complete)throw Error('PAGINATION_BOUND');const candidates=new Map();
  for(const contact of contacts){const full=await get('/api/v4/contacts/'+contact.id+'?with=leads');const links=full._embedded?.leads||[];if(links.length>50)throw Error('LEAD_BOUND');for(const l of links){const lead=await get('/api/v4/leads/'+l.id+'?with=contacts');candidates.set(Number(l.id),classify(row,lead,Number(contact.id)));}}
  // Search the exact generated title too: a lost create response must not be
  // mistaken for absence merely because the contact relation is missing.
  let titleSearchComplete=false,titleMatches=0;
  const title=`Фиксация: ${row.fullName} (${row.project})`;
  for(let page=1;page<=10;page++){
   const result=await get('/api/v4/leads?limit=250&page='+page+'&query='+encodeURIComponent(title));
   const list=result._embedded?.leads||[];if(!Array.isArray(list))throw Error('LEAD_SHAPE');
   for(const item of list){if(item.name!==title)continue;titleMatches++;if(!candidates.has(Number(item.id))){const lead=await get('/api/v4/leads/'+item.id+'?with=contacts');candidates.set(Number(item.id),classify(row,lead,contacts.length===1?Number(contacts[0].id):-1));}}
   if(!result._links?.next){titleSearchComplete=true;break;}
  }
  if(!titleSearchComplete)throw Error('PAGINATION_BOUND');
  const after=await p.client.findUnique({where:{id:ID},select:SELECT});if(snapshot(row)!==snapshot(after))throw Error('CASE_DRIFT');
  const records=[...candidates.values()];const strong=records.filter(c=>c.exactGeneratedName&&c.clientContactLinked&&c.brokerContactLinked&&!c.contactRoleCollision&&c.createdWithinWindow&&c.projectMatches&&c.fromBroker);
  const error=String(row.amoSyncError||'');
  console.log('EXACT_CASE='+JSON.stringify({ok:true,caseId:ID,readOnly:true,databaseUnchanged:true,providerWrites:0,localStatus:row.amoSyncStatus,localLeadId:row.amoLeadId===null?null:String(row.amoLeadId),attempts:row.amoSyncAttempts,createdAt:row.createdAt,updatedAt:row.updatedAt,reconciliationRequired:error.startsWith('AMO_CREATE_RECONCILIATION_REQUIRED:'),networkCause:error.endsWith('AMO_NETWORK_ERROR'),unconfirmedCause:error.endsWith('AMO_FIXATION_CREATE_UNCONFIRMED_NO_LEAD'),fixationStatus:row.fixationStatus,uniquenessStatus:row.uniquenessStatus,exactContacts:contacts.length,titleSearchComplete,titleMatches,leadCandidates:records,strongCandidates:strong.length,gets:calls,linkAuthorized:false}));
 }finally{await p.$disconnect();}
}
module.exports={ID,norm,classify};
if(require.main===module||process.env.EXEC_EXACT_CASE==='1')main().catch(e=>{const allowed=['READONLY_REFUSED','CASE_MISSING','TOKEN_MISSING','ACCOUNT_REFUSED','PHONE_REFUSED','PAGINATION_BOUND','CONTACT_SHAPE','LEAD_BOUND','CASE_DRIFT','GET_BOUND','BODY_BOUND','FIELD_AMBIGUOUS','HTTP_401','HTTP_403','HTTP_429'];console.log('EXACT_CASE='+JSON.stringify({ok:false,readOnly:true,providerWrites:0,failure:allowed.includes(e.message)?e.message:'DEPENDENCY_FAILURE'}));process.exitCode=1;});
