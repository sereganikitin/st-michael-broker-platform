'use strict';
const {SPREADSHEET_ID,TABS,normalize,plan}=require('./plan.cjs');
async function readSource(credentials){
 const {google}=require('googleapis');
 if(credentials?.type!=='service_account'||credentials.token_uri!=='https://oauth2.googleapis.com/token')throw Error('SOURCE_UNAVAILABLE');
 const sheets=google.sheets({version:'v4',auth:new google.auth.GoogleAuth({credentials,scopes:['https://www.googleapis.com/auth/spreadsheets.readonly']})});
 const metadata=async()=>{
  const r=await sheets.spreadsheets.get({spreadsheetId:SPREADSHEET_ID,includeGridData:false,fields:'sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))'},{timeout:10000});
  const map=new Map((r.data.sheets||[]).map(s=>[s.properties.title,s.properties]));
  return TABS.map((title,i)=>{const p=map.get(title);if(!p||p.sheetId!==[790784828,1848986844,1542122657,288161372][i]||p.gridProperties.rowCount>5000)throw Error('SOURCE_SCHEMA_CHANGED');return p;});
 };
 const meta=await metadata();
 const read=async()=>{
  const input={};
  for(const p of meta){
   const title=p.title;
   if(title===TABS[3]){
    const r=await sheets.spreadsheets.values.get({spreadsheetId:SPREADSHEET_ID,range:`'${title}'!A4:H${p.gridProperties.rowCount}`,valueRenderOption:'UNFORMATTED_VALUE'},{timeout:10000});
    const rows=r.data.values||[];if(normalize(rows[0]?.[1])!=='группа'||normalize(rows[0]?.[6])!=='статус сделки')throw Error('SOURCE_SCHEMA_CHANGED');input[title]=rows.slice(1);
   }else{
    const r=await sheets.spreadsheets.values.batchGet({spreadsheetId:SPREADSHEET_ID,ranges:[`'${title}'!A5:D${p.gridProperties.rowCount}`,`'${title}'!P5:S${p.gridProperties.rowCount}`],valueRenderOption:'UNFORMATTED_VALUE'},{timeout:10000});
    const [names,amounts]=(r.data.valueRanges||[]).map(v=>v.values||[]);
    if(normalize(names?.[0]?.[2])!=='партнёр'||normalize(names?.[0]?.[3])!=='тип'||normalize(amounts?.[0]?.[3])!=='сумма итог, млн ₽')throw Error('SOURCE_SCHEMA_CHANGED');input[title]={names:names.slice(1),amounts:amounts.slice(1)};
   }
  }
  return plan(input);
 };
 const first=await read(),second=await read();
 if(first.contentHash!==second.contentHash||JSON.stringify(meta)!==JSON.stringify(await metadata()))throw Error('SOURCE_CHANGED_DURING_READ');
 if(second.issues.some(i=>i.code!=='DUPLICATE_AGENCY_NAME'))throw Error('SOURCE_VALIDATION_FAILED');
 return second;
}
module.exports={readSource};
