'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const source=fs.readFileSync(path.join(__dirname,'../../apps/web/src/lib/agency-table.ts'),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
const context={exports:{}};vm.runInNewContext(compiled,context);const {agencyTableRows}=context.exports;
const {agencyVisibleColumns}=context.exports;
const {AGENCY_COLUMNS}=context.exports;
const p=(tab,row,total)=>({tab,row,baselineRub:total,addedRub:'0.00',totalRub:total});
const items=[{key:'a',name:'Альфа',type:'АН',status:'MATCHED',matchedAgency:{name:'Другое имя'},periods:[p('Партнеры 2026',6,'10.00'),p('Спящие',10,'2.00')]},{key:'b',name:'Бета',type:'Агрегатор',status:'NEW',matchedAgency:null,periods:[p('Агрегаторы',7,'9007199254740993.02')]},{key:'c',name:'Гамма',type:'Ключевой',status:'REVIEW',matchedAgency:null,periods:[p('Спящие',9,'9007199254740993.01')]}];
const options={search:'',type:'',status:'',source:'',sort:null,direction:'asc'};
const rows=(patch={})=>agencyTableRows(items,{...options,...patch});
test('filters combine, aliases are searched and source filtering is per period',()=>{
 assert.equal(rows({search:'  ДРУГОЕ   ИМЯ  ',source:'Спящие',type:'АН',status:'MATCHED'}).length,1);
 assert.equal(rows({type:'Агрегатор',status:'MATCHED'}).length,0);assert.equal(rows({source:'Спящие'}).length,2);
});
test('money sorting is exact, numeric and reversible without aggregating periods',()=>{
 assert.equal(rows({sort:'total'}).map(r=>r.period.totalRub).join(','),'2.00,10.00,9007199254740993.01,9007199254740993.02');
 assert.equal(rows({sort:'total',direction:'desc'})[0].item.key,'b');assert.equal(items[0].periods.length,2);assert.equal(rows().length,4);
});
test('all six columns sort with stable unique row identities',()=>{
 for(const sort of ['name','status','source','baseline','added','total']){
  const result=rows({sort});assert.equal(result.length,4);assert.equal(new Set(result.map(r=>r.rowKey)).size,4);
 }
 assert.equal(rows({sort:'source'})[2].period.row,9);assert.equal(rows({sort:'added'})[0].item.key,'a');
 assert.equal(rows()[0].period.row,6);
 assert.equal(rows({sort:'name',direction:'desc'})[0].item.name,'Гамма');
 assert.equal(rows({sort:'status'})[0].item.status,'REVIEW');
});

test('page has three combined filters, six sortable headers, reset and no informational banner',()=>{
 const page=fs.readFileSync(path.join(__dirname,'../../apps/web/src/app/(cabinet)/admin/agencies-v1-2/page.tsx'),'utf8');
 assert.match(page,/Все типы/);assert.match(page,/Все статусы/);assert.match(page,/Все листы/);
 assert.match(page,/aria-sort=/);assert.match(page,/Сбросить/);
 assert.doesNotMatch(page,/Поля источника: заполнено|Нажмите на строку или название|Обновление из источника|Отдельное представление таблицы партнёров/);
});

test('column preferences keep the row identity, remove unknowns and duplicates and preserve canonical order',()=>{
 assert.equal(agencyVisibleColumns(null).length,6);
 assert.equal(agencyVisibleColumns([]).join(','),'name');
 assert.equal(agencyVisibleColumns(['total','bad','total','status']).join(','),'name,status,total');
});

test('visible columns shape headers and details, with a dedicated scroll region and controls',()=>{
 const page=fs.readFileSync(path.join(__dirname,'../../apps/web/src/app/(cabinet)/admin/agencies-v1-2/page.tsx'),'utf8');
 assert.match(page,/visibleColumns\.map/);assert.match(page,/colSpan=\{visibleColumns\.length\}/);
 assert.match(page,/overflow-x-auto/);assert.match(page,/Прокрутить таблицу влево/);assert.match(page,/Прокрутить таблицу вправо/);
 assert.match(page,/agency-v1-2-visible-columns/);
});

test('all nineteen source fields are selectable and sortable, default remains six columns',()=>{
 assert.equal(AGENCY_COLUMNS.length,25);
 assert.equal(agencyVisibleColumns(AGENCY_COLUMNS.map(c=>c.key)).length,25);
 const enriched=JSON.parse(JSON.stringify(items));
 for(const [i,item] of enriched.entries())for(const period of item.periods)period.fields=AGENCY_COLUMNS.filter(c=>c.key.startsWith('field:')).map(c=>({column:c.key.slice(6),label:c.title,value:c.kind==='date'?['31.01.2026','01.02.2026','31.12.2025'][i]:c.kind==='number'?['10,0%','2%','0,8%'][i]:['Б','А','В'][i]}));
 for(const column of AGENCY_COLUMNS)assert.equal(agencyTableRows(enriched,{...options,sort:column.key}).length,4);
 assert.equal(agencyTableRows(enriched,{...options,sort:'field:H'})[0].item.key,'c');
 assert.equal(agencyTableRows(enriched,{...options,sort:'field:U'})[0].item.key,'c');
 const filtered=agencyTableRows(enriched,{...options,filters:[{field:'field:H',operator:'gte',value:'2026-01-01'},{field:'field:U',operator:'lte',value:'2'}]});
 assert.equal(filtered.length,1);assert.equal(filtered[0].item.key,'b');
 assert.equal(agencyTableRows(enriched,{...options,filters:[{field:'field:H',operator:'gte',value:'2026-02-31'}]}).length,0);
});

test('blank, exact and combined source filters preserve phone text and exact money',()=>{
 const enriched=JSON.parse(JSON.stringify(items));
 enriched[0].periods[0].fields=[{column:'F',label:'Номер телефона',value:'+7 001 002-03-04'},{column:'J',label:'Ответственный менеджер',value:'  Анна  '}];
 const filter=(filters)=>agencyTableRows(enriched,{...options,filters});
 assert.equal(filter([{field:'field:F',operator:'notEmpty',value:''}]).length,1);
 assert.equal(filter([{field:'field:F',operator:'empty',value:''}]).length,3);
 assert.equal(filter([{field:'field:F',operator:'contains',value:'001'},{field:'field:J',operator:'equals',value:'анна'}]).length,1);
 assert.equal(filter([{field:'total',operator:'gte',value:'9007199254740993.02'}]).length,1);
 assert.equal(filter([{field:'field:F',operator:'gte',value:'1'}]).length,0);
 assert.equal(filter([{field:'field:H',operator:'gte',value:'not a date'}]).length,0);
});
