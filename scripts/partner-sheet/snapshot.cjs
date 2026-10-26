'use strict';
const {createHash}=require('node:crypto');
const {COLUMNS}=require('./details.cjs');
const {normalize,TABS}=require('./plan.cjs');
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
// This is a private integration snapshot, not an import into Agency/Broker/amoCRM.
function validateView(view,previous){
 if(view?.version!=='agency-v1-2'||view.readOnly!==true||!Array.isArray(view.items)||!view.items.length||!Number.isFinite(Date.parse(view.loadedAt))||!/^[a-f0-9]{64}$/.test(view.sourceHash))throw Error('SNAPSHOT_INVALID');
 const identities=new Map(),rows=new Set();let count=0;
 for(const item of view.items){
  if(!item.name?.trim()||!['АН','Ключевой','Агрегатор'].includes(item.type)||!['MATCHED','REVIEW','NEW'].includes(item.status)||!Array.isArray(item.periods)||!item.periods.length)throw Error('SNAPSHOT_INVALID');
  for(const period of item.periods){
   const rowKey=`${period.tab}:${period.row}`,identity=`${period.tab}:${normalize(item.name)}`;
   if(!TABS.slice(0,3).includes(period.tab)||!Number.isInteger(period.row)||period.row<6||rows.has(rowKey))throw Error('SNAPSHOT_INVALID');
   // One agency can have several legitimate source periods on the same tab.
   // Physical sheet rows stay unique; source amounts are never aggregated.
   rows.add(rowKey);identities.set(identity,(identities.get(identity)||0)+1);count++;
   const fields=period.fields;
   if(!Array.isArray(fields)||fields.length!==COLUMNS.length||COLUMNS.some((c,i)=>fields[i]?.column!==String.fromCharCode(65+c)||typeof fields[i]?.value!=='string'||typeof fields[i]?.label!=='string'))throw Error('FIELDS_INCOMPLETE');
   for(const key of ['baselineRub','addedRub','totalRub'])if(!/^\d+\.\d{2}$/.test(period[key]))throw Error('AMOUNT_INVALID');
   const cents=v=>BigInt(v.replace('.',''));
   if(cents(period.totalRub)!==(period.tab==='Спящие'?cents(period.addedRub):cents(period.baselineRub)+cents(period.addedRub)))throw Error('TOTAL_MISMATCH');
  }
 }
 if(count!==view.sourceRowCount||view.audit?.sourceFields!==count*COLUMNS.length||view.matched+view.review+view.new!==view.items.length)throw Error('ROW_COUNT_MISMATCH');
 if(previous){
  const expected=new Map();
  for(const item of previous.items)for(const p of item.periods){const key=`${p.tab}:${normalize(item.name)}`;expected.set(key,(expected.get(key)||0)+1);}
  for(const [key,total] of expected)if((identities.get(key)||0)<total)throw Error('PREVIOUS_AGENCY_MISSING');
 }
 return view;
}
function encodeSnapshot(view){validateView(view);return JSON.stringify({version:1,digest:hash(view),view});}
function decodeSnapshot(text){const envelope=JSON.parse(text);if(envelope.version!==1||envelope.digest!==hash(envelope.view))throw Error('SNAPSHOT_DIGEST_MISMATCH');return validateView(envelope.view);}
module.exports={validateView,encodeSnapshot,decodeSnapshot};
