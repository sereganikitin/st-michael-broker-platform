'use strict';
// Read-only production diagnosis. No source content, credentials or PII output.
async function main(){
 let stage='identity';const report={ok:false,databaseWrites:false,sourceWrites:false};let db;
 try{
  const root='/app/scripts/partner-sheet/';
  const {PrismaClient}=require('@st-michael/database');
  const url=new URL(process.env.DATABASE_URL);url.searchParams.set('options','-c default_transaction_read_only=on -c statement_timeout=30000');
  db=new PrismaClient({datasources:{db:{url:url.toString()}},log:[]});
  report.readOnly=(await db.$queryRaw`SELECT current_setting('default_transaction_read_only') AS mode`)[0]?.mode==='on';
  if(!report.readOnly)throw Error('READONLY_REQUIRED');
  stage='source';
  const source=await require(root+'read-source.cjs').readSource(JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON||'{}'));
  report.sourceRows=source.sourceRows.length;report.agencies=source.agencies.length;report.detailRows=source.details.length;
  stage='organizations';
  const organizations=await db.agency.findMany({select:{id:true,name:true,legalName:true,inn:true,phone:true,email:true,address:true,legalAddress:true,bankName:true,bankBik:true,bankAccount:true,correspondentAccount:true,updatedAt:true},take:10001,orderBy:{id:'asc'}});
  stage='projection';
  const view=require(root+'view.cjs').buildView(source,organizations,new Date().toISOString());
  report.viewRows=view.sourceRowCount;report.projectedPeriods=view.items.reduce((n,i)=>n+i.periods.length,0);report.fields=view.audit.sourceFields;
  const {normalize,TABS}=require(root+'plan.cjs');
  const seenRows=new Set(),seenIdentities=new Set();
  report.guards={version:view.version==='agency-v1-2',readOnly:view.readOnly===true,loadedAt:Number.isFinite(Date.parse(view.loadedAt)),sourceHash:/^[a-f0-9]{64}$/.test(view.sourceHash),invalidItems:0,invalidPeriods:0,duplicateRows:0,duplicateIdentities:0};
  for(const item of view.items){
   if(!item.name?.trim()||!['АН','Ключевой','Агрегатор'].includes(item.type)||!['MATCHED','REVIEW','NEW'].includes(item.status)||!Array.isArray(item.periods)||!item.periods.length)report.guards.invalidItems++;
   for(const p of item.periods){
    if(!TABS.slice(0,3).includes(p.tab)||!Number.isInteger(p.row)||p.row<6)report.guards.invalidPeriods++;
    const row=`${p.tab}:${p.row}`,identity=`${p.tab}:${normalize(item.name)}`;
    if(seenRows.has(row))report.guards.duplicateRows++;if(seenIdentities.has(identity))report.guards.duplicateIdentities++;
    seenRows.add(row);seenIdentities.add(identity);
   }
  }
  stage='snapshotValidation';require(root+'snapshot.cjs').validateView(view);
  stage='storage';
  report.storagePermissions=(await db.$queryRaw`SELECT has_table_privilege(current_user, 'system_settings', 'SELECT,INSERT,UPDATE,DELETE') AS allowed`)[0]?.allowed===true;
  const previous=await db.systemSetting.findUnique({where:{key:'partner-sheet-v1-2:verified-snapshot'},select:{value:true}});
  report.snapshotExists=!!previous;
  if(previous){const saved=require(root+'snapshot.cjs').decodeSnapshot(previous.value);report.snapshotRows=saved.sourceRowCount;require(root+'snapshot.cjs').validateView(view,saved);}
  report.ok=true;
 }catch(error){const code=String(error?.code||error?.message||'');report.errorClass=/^(SOURCE_[A-Z_]+|SNAPSHOT_[A-Z_]+|FIELDS_INCOMPLETE|AMOUNT_INVALID|TOTAL_MISMATCH|ROW_COUNT_MISMATCH|PREVIOUS_AGENCY_MISSING|READONLY_REQUIRED|P\d{4})$/.test(code)?code:'UNCLASSIFIED';}
 finally{if(db)await db.$disconnect();}
 console.log('PARTNER_SHEET_DIAGNOSTIC='+JSON.stringify({...report,stage}));
}
main().catch(()=>{console.log('PARTNER_SHEET_DIAGNOSTIC={"ok":false,"databaseWrites":false,"errorClass":"DIAGNOSTIC_FAILED"}');process.exitCode=1;});
