'use strict';
const {SPREADSHEET_ID,TABS,normalize,plan}=globalThis.__partnerSheetPlan||require('./plan.cjs');
const {matchAgencies}=globalThis.__partnerSheetMatch||require('./match.cjs');
const {transferPlan}=globalThis.__partnerSheetTransfer||require('./transfer-plan.cjs');
const {verifyRegistry}=globalThis.__partnerSheetRegistry||require('./registry.cjs');
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
  const readOrganizations=()=>db.agency.findMany({select:{id:true,name:true,legalName:true,inn:true,_count:{select:{brokerAgencies:true,deals:true}}},orderBy:{id:'asc'},take:10001});
  const organizations=await readOrganizations();
  if(organizations.length>10000)throw Error('TARGET_LIMIT');
  const mapping=matchAgencies(second.agencies,organizations);
  const publicRow=m=>({tab:m.tab,row:m.row,matches:m.matches.length,candidateCount:m.candidates.length,reason:m.reason});
  // Public legal-identity research is a candidate only, never an import rule.
  // No phone, email, broker, client or deal content is selected or printed.
  const publicInns=new Map([['Партнеры 2026:6',['770470572401']],['Спящие:7',['6165207713','341003103169']],['Спящие:16',['7705271348']],['Спящие:19',['9731116328']]]);
  const identityReview=mapping.filter(m=>m.matches.length!==1).map(m=>{
   const researched=publicInns.get(`${m.tab}:${m.row}`)||[];
   const ids=new Set([...m.matches,...m.candidates]);
   const selected=organizations.filter(o=>ids.has(o.id)||researched.includes(o.inn));
   return {...publicRow(m),publicInnCandidateCount:researched.length,existingCandidates:selected.map(o=>({name:o.name,legalName:o.legalName,inn:o.inn,canonicalMatch:m.matches.includes(o.id),similarityCandidate:m.candidates.includes(o.id),publicInnMatch:researched.includes(o.inn),brokerLinks:o._count.brokerAgencies,dealLinks:o._count.deals}))};
  });
  const transfer=transferPlan(second,organizations);
  const registryChecks=await verifyRegistry(transfer.newAgencyCandidates,process.env.DADATA_API_KEY);
  if(JSON.stringify(organizations)!==JSON.stringify(await readOrganizations()))throw Error('TARGET_CHANGED_DURING_READ');
  console.log('PARTNER_SHEET_PREVIEW='+JSON.stringify({ok:true,readOnly:true,targetBase:'OURS',sourceStable:true,targetStable:true,...second.summary,contentHash:second.contentHash,
   matchingPolicy:'CABINET_KEYS_WITH_REVIEW_ONLY_SIMILARITY',targetOrganizations:organizations.length,matchedRows:mapping.filter(m=>m.matches.length===1).length,unmatchedRows:mapping.filter(m=>m.matches.length===0).map(publicRow),ambiguousRows:mapping.filter(m=>m.matches.length>1).map(publicRow),sourceIssues:second.issues,
   similarityCandidateRows:mapping.filter(m=>m.matches.length===0&&m.candidates.length>0).map(publicRow),identityReview,unresolvedRowsRequireIdentityReview:mapping.filter(m=>m.matches.length!==1).length,
   transferPreparation:{planHash:transfer.planHash,existingBindings:transfer.bindings.length,newAgencyCandidates:transfer.newAgencyCandidates.length,quarantine:transfer.quarantine,registryChecks,sourceIssues:transfer.sourceIssues,aggregatePolicy:transfer.aggregatePolicy},importStarted:false,automaticSyncEnabled:false}));
 }finally{await db.$disconnect();}
}
if(require.main===module||process.env.RUN_PARTNER_SHEET_PREVIEW==='1')main().catch(()=>{console.log('PARTNER_SHEET_PREVIEW={"ok":false,"readOnly":true,"error":"PREVIEW_REFUSED","databaseWrites":false}');process.exitCode=1;});
