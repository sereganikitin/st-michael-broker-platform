'use strict';
const {SPREADSHEET_ID,TABS,normalize,plan}=globalThis.__partnerSheetPlan||require('./plan.cjs');
async function main(){
 const {google}=require('googleapis'),{PrismaClient}=require('@st-michael/database');
 const credentials=JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON||'{}');
 if(credentials.type!=='service_account'||credentials.token_uri!=='https://oauth2.googleapis.com/token')throw Error('GOOGLE_CREDENTIALS_INVALID');
 const sheets=google.sheets({version:'v4',auth:new google.auth.GoogleAuth({credentials,scopes:['https://www.googleapis.com/auth/spreadsheets.readonly']})});
 const getMeta=async()=>{
  const response=await sheets.spreadsheets.get({spreadsheetId:SPREADSHEET_ID,includeGridData:false,fields:'sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))'});
  const map=new Map((response.data.sheets||[]).map(s=>[s.properties.title,s.properties]));
  const expected=[790784828,1848986844,1542122657,288161372];
  return TABS.map((name,i)=>{const p=map.get(name);if(!p||p.sheetId!==expected[i]||p.gridProperties.rowCount>5000)throw Error('SOURCE_SCHEMA_CHANGED');return p;});
 };
 const metadata=await getMeta();
 const read=async()=>{
  const input={};
  for(const p of metadata){
   const tab=p.title;
   if(tab===TABS[3]){
    const r=await sheets.spreadsheets.values.get({spreadsheetId:SPREADSHEET_ID,range:`'${tab}'!A4:H${p.gridProperties.rowCount}`,valueRenderOption:'UNFORMATTED_VALUE'});
    const rows=r.data.values||[];
    if(normalize(rows[0]?.[1])!=='группа'||normalize(rows[0]?.[6])!=='статус сделки')throw Error('DEAL_HEADERS_CHANGED');
    input[tab]=rows.slice(1);
   }else{
    const r=await sheets.spreadsheets.values.batchGet({spreadsheetId:SPREADSHEET_ID,ranges:[`'${tab}'!A5:D${p.gridProperties.rowCount}`,`'${tab}'!P5:S${p.gridProperties.rowCount}`],valueRenderOption:'UNFORMATTED_VALUE'});
    const [names,amounts]=(r.data.valueRanges||[]).map(r=>r.values||[]);
    if(normalize(names?.[0]?.[2])!=='партнёр'||normalize(names?.[0]?.[3])!=='тип'||normalize(amounts?.[0]?.[3])!=='сумма итог, млн ₽')throw Error('AGENCY_HEADERS_CHANGED');
    input[tab]={names:names.slice(1),amounts:amounts.slice(1)};
   }
  }
  return plan(input);
 };
 const first=await read(),second=await read();
 if(first.contentHash!==second.contentHash||JSON.stringify(metadata)!==JSON.stringify(await getMeta()))throw Error('SOURCE_CHANGED_DURING_READ');
 const url=new URL(process.env.DATABASE_URL);url.searchParams.set('options','-c default_transaction_read_only=on -c statement_timeout=30000');
 const db=new PrismaClient({datasources:{db:{url:url.toString()}},log:[]});
 try{
  if((await db.$queryRaw`SELECT current_setting('default_transaction_read_only') AS mode`)[0]?.mode!=='on')throw Error('READONLY_REQUIRED');
  // Explicit user choice: registered agencies in OURS, never the ANNA dataset.
  const readOrganizations=()=>db.agency.findMany({select:{id:true,name:true,legalName:true},orderBy:{id:'asc'},take:10001});
  const organizations=await readOrganizations();
  if(organizations.length>10000)throw Error('TARGET_LIMIT');
  const index=new Map();
  for(const org of organizations)for(const name of [org.name,org.legalName]){
   if(!name)continue;const key=normalize(name);if(!index.has(key))index.set(key,new Set());index.get(key).add(org.id);
  }
  const mapping=second.agencies.map(a=>({tab:a.tab,row:a.row,matches:index.get(a.normalizedName)?.size||0}));
  if(JSON.stringify(organizations)!==JSON.stringify(await readOrganizations()))throw Error('TARGET_CHANGED_DURING_READ');
  console.log('PARTNER_SHEET_PREVIEW='+JSON.stringify({ok:true,readOnly:true,targetBase:'OURS',sourceStable:true,targetStable:true,...second.summary,contentHash:second.contentHash,
   targetOrganizations:organizations.length,matchedRows:mapping.filter(m=>m.matches===1).length,unmatchedRows:mapping.filter(m=>m.matches===0),ambiguousRows:mapping.filter(m=>m.matches>1),sourceIssues:second.issues,
   unresolvedRowsRequireTaxId:mapping.filter(m=>m.matches!==1).length,importStarted:false,automaticSyncEnabled:false}));
 }finally{await db.$disconnect();}
}
if(require.main===module||process.env.RUN_PARTNER_SHEET_PREVIEW==='1')main().catch(()=>{console.log('PARTNER_SHEET_PREVIEW={"ok":false,"readOnly":true,"error":"PREVIEW_REFUSED","databaseWrites":false}');process.exitCode=1;});
