'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const source=fs.readFileSync(path.join(__dirname,'../../apps/web/src/lib/agency-table.ts'),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
const context={exports:{}};vm.runInNewContext(compiled,context);const {agencyTableRows}=context.exports;
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
 assert.doesNotMatch(page,/Поля источника: заполнено|Нажмите на строку или название|Обновление из источника/);
});
