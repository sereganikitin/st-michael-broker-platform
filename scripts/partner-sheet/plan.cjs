'use strict';
// Read-only planning. Never imports contacts, phone columns, or call history.
const {createHash}=require('node:crypto');
const SPREADSHEET_ID='1LaFdVsWCV6ETaLWt5A3Otasui1NuhkSvwf6fSCzZ6o0';
const TABS=Object.freeze(['Партнеры 2026','Спящие','Агрегаторы','Ввод сделок']);
const AGENCY_TYPES=new Set(['АН','Ключевой','Агрегатор']);
const OTHER_TYPES=new Set(['Частный','Новый брокер','Брокер','Брокер не указан']);
const normalize=value=>String(value??'').normalize('NFC').trim().replace(/\s+/gu,' ').toLocaleLowerCase('ru-RU');
function centsFromMillions(value){
 if(typeof value==='number'&&(!Number.isFinite(value)||value<0))throw Error('INVALID_AMOUNT');
 const text=String(value??'').trim();
 if(!/^\d+(?:\.\d+)?$/.test(text))throw Error('INVALID_AMOUNT');
 const [whole,decimal='']=text.split('.');
 const padded=(decimal+'000000000').slice(0,9);
 const amount=BigInt(whole)*100000000n+BigInt(padded.slice(0,8))+(Number(padded[8])>=5?1n:0n);
 if(amount>999999999999999999n)throw Error('AMOUNT_TOO_LARGE');
 return amount;
}
const rubles=amount=>(amount/100n).toString()+'.'+(amount%100n).toString().padStart(2,'0');
function plan(input){
 const issues=[],agencies=[],sourceRows=[],excludedTypes={},deals=[],seen=new Map();
 for(const tab of TABS.slice(0,3)){
  if(!input[tab]||!Array.isArray(input[tab].names)||!Array.isArray(input[tab].amounts))throw Error('TAB_DATA_REQUIRED');
  const {names,amounts}=input[tab];
  let reachedCommissionTable=false;
  names.forEach((row,index)=>{
   const rowNumber=index+6,type=String(row[3]??'').trim(),name=String(row[2]??'').trim();
   // The workbook has a numeric commission lookup table below the registry.
   // Its volume thresholds are not partner row numbers.
   if(normalize(row[0])==='от объёма, млн ₽')reachedCommissionTable=true;
   if(reachedCommissionTable)return;
   // Footer dictionaries and prose are not partner rows.
   if(!type&&!Number.isInteger(row[0]))return;
   if(!name){issues.push({tab,row:rowNumber,code:'NAME_MISSING'});return;}
   if(OTHER_TYPES.has(type)){excludedTypes[type]=(excludedTypes[type]||0)+1;return;}
   if(!AGENCY_TYPES.has(type)){issues.push({tab,row:rowNumber,code:'TYPE_REQUIRES_REVIEW'});return;}
   const key=normalize(name);
   try{
    const [lastDate,baseline,added,total]=amounts[index]||[];
    const totalCents=centsFromMillions(total),newCents=centsFromMillions(added),baselineCents=centsFromMillions(baseline);
    if(totalCents!==(tab==='Спящие'?newCents:baselineCents+newCents))throw Error('TOTAL_FORMULA_MISMATCH');
    const record={tab,row:rowNumber,name,normalizedName:key,type,totalRub:rubles(totalCents),addedRub:rubles(newCents),baselineRub:rubles(baselineCents),lastDate:lastDate??null};
    sourceRows.push(record);
    if(seen.has(key)){issues.push({tab,row:rowNumber,code:'DUPLICATE_AGENCY_NAME'});return;}seen.set(key,true);
    agencies.push(record);
   }catch(error){issues.push({tab,row:rowNumber,code:error.message});}
  });
 }
 if(!Array.isArray(input['Ввод сделок']))throw Error('DEAL_DATA_REQUIRED');
 const dduKeys=new Set();
 input['Ввод сделок'].forEach((row,index)=>{
  if(!row.slice(0,7).some(c=>c!==''&&c!==null&&c!==undefined))return; // Ignore prefilled zero formulas.
  const rowNumber=index+5;
  try{
   const [date,group,partner,project,contract,amount,status,accounted]=row;
   if(!TABS.slice(0,3).includes(group))throw Error('UNKNOWN_GROUP');
   if(!String(partner??'').trim()||!String(contract??'').trim()||!String(project??'').trim())throw Error('DEAL_IDENTITY_MISSING');
   const key=normalize(project)+'|'+normalize(contract);
   if(dduKeys.has(key))throw Error('DUPLICATE_DDU');dduKeys.add(key);
   if(!Number.isInteger(date)||date<30000||date>100000)throw Error('INVALID_DEAL_DATE');
   const amountCents=centsFromMillions(amount),accountedCents=centsFromMillions(accounted);
   if(accountedCents!==(status==='Подписан'?amountCents:0n))throw Error('ACCOUNTED_AMOUNT_MISMATCH');
   deals.push({row:rowNumber,group,partner,project,contract,date,status,amountRub:rubles(amountCents),accountedRub:rubles(accountedCents)});
  }catch(error){issues.push({tab:'Ввод сделок',row:rowNumber,code:error.message});}
 });
 const summary={agencyRows:agencies.length,agencyTypes:agencies.reduce((r,a)=>(r[a.type]=(r[a.type]||0)+1,r),{}),excludedTypes,
  dealRows:deals.length,signedDealRows:deals.filter(d=>d.status==='Подписан').length,issues:issues.length,
  contactsRead:false,callTabsRead:false,contactsCreated:false,databaseWrites:false};
 return {version:'agency-sheet-preview-v2',spreadsheetId:SPREADSHEET_ID,contentHash:createHash('sha256').update(JSON.stringify(input)).digest('hex'),agencies,sourceRows,deals,issues,summary};
}
module.exports={SPREADSHEET_ID,TABS,normalize,centsFromMillions,rubles,plan};
