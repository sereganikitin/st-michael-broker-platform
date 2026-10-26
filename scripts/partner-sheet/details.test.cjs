'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {readAgencyDetails,HEADERS,COLUMNS}=require('./details.cjs');
const {buildView}=require('./view.cjs');
const source={contentHash:'core',sourceRows:[{tab:'Партнеры 2026',row:6,name:'Agency',normalizedName:'agency',type:'АН',baselineRub:'1.00',addedRub:'0.00',totalRub:'1.00'}],deals:[],issues:[]};source.agencies=source.sourceRows;
function mock(change){const calls=[];return {calls,spreadsheets:{values:{batchGet:async(args)=>{
 calls.push(args);
 const headers=[...HEADERS];headers[16]=args.ranges[0].includes('Спящие')?'Исторические продажи до 2026, млн ₽ (не считать)':'Сумма на старте, млн ₽';headers[19]=args.ranges[0].includes('Спящие')?'На первую сделку до 30.09':'Комиссия с 01.09';
 const row=Array(25).fill('');row[2]='Agency';row[3]='АН';row[5]='CONTACT';row[15]='01.10.2026';row[20]='3,5%';if(change)change(row,headers);
 return {data:{valueRanges:args.ranges.map((_,i)=>({values:[i===0?headers:row]}))}};
}}}};}
test('reads only validated agency rows and fixed allowed sheets, keeps formatted values and blanks',async()=>{
 const client=mock(),result=await readAgencyDetails(client,'fixed',source);
 assert.deepEqual(client.calls.flatMap(c=>c.ranges),["'Партнеры 2026'!A5:Y5","'Партнеры 2026'!A6:Y6","'Спящие'!A5:Y5","'Агрегаторы'!A5:Y5"]);
 assert.equal(result.details.length,1);assert.equal(result.details[0].fields.length,19);assert.equal(result.details[0].fields.find(f=>f.column==='U').value,'3,5%');assert.equal(result.details[0].fields.find(f=>f.column==='P').value,'01.10.2026');
 assert.equal(result.details[0].fields.find(f=>f.column==='N').value,'');
 assert.ok(client.calls.every(c=>c.valueRenderOption==='FORMATTED_VALUE'));
 assert.notEqual(result.contentHash,source.contentHash);
});
test('rejects changed row identity and header shape',async()=>{
 await assert.rejects(readAgencyDetails(mock(row=>row[3]='Частный'),'fixed',source),/SOURCE_CHANGED/);
 await assert.rejects(readAgencyDetails(mock((row,h)=>h[5]='Wrong'),'fixed',source),/SOURCE_SCHEMA_CHANGED/);
});
test('details change the stability hash, but no source mutation or synthesized values',async()=>{
 const a=await readAgencyDetails(mock(),'fixed',source),b=await readAgencyDetails(mock(row=>row[11]='New'),'fixed',source);
 assert.notEqual(a.contentHash,b.contentHash);assert.equal(source.details,undefined);assert.equal(COLUMNS.length,19);
});
test('view preserves all detail fields, missing cabinet fields and hides placeholder tax ID',async()=>{
 const result=await readAgencyDetails(mock(),'fixed',source);
 const v=buildView(result,[{id:'id',name:'Agency',inn:'NOINN-placeholder',phone:'CABINET',passwordHash:'SECRET'}],'now');
 assert.equal(v.items[0].periods[0].fields.length,19);
 assert.equal(v.items[0].matchedAgency.fields.find(f=>f.key==='inn').value,'');
 assert.equal(v.items[0].matchedAgency.fields.find(f=>f.key==='phone').value,'CABINET');
 assert.equal(v.audit.sourceFields,19);assert.equal(v.audit.sourceFilled,3);assert.equal(v.audit.cabinetMissing,9);
 assert.doesNotMatch(JSON.stringify(v),/SECRET|passwordHash|NOINN-/);
});
