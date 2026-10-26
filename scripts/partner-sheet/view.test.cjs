'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {plan}=require('./plan.cjs'),{buildView}=require('./view.cjs');
const {readFileSync}=require('node:fs');
const {join}=require('node:path');

test('page hides the cabinet details block while retaining source contacts and matched-card navigation',()=>{
 const page=readFileSync(join(__dirname,'../../apps/web/src/app/(cabinet)/admin/agencies-v1-2/page.tsx'),'utf8');
 assert.doesNotMatch(page,/Действующая карточка кабинета|Карточка обновлена:|Не заполнено в кабинете|Незаполненных реквизитов/);
 assert.match(page,/fields=\{period\.fields \|\| \[\]\}/);
 assert.match(page,/\/admin\/loyalty-base\/ours\/agencies\/\$\{item\.matchedAgency\.id\}/);
});
test('keeps all source periods without doubling the agency card or publishing deal identities',()=>{
 const input={'Партнеры 2026':{names:[[1,'A','Agency','АН']],amounts:[[46000,10,2,12]]},'Спящие':{names:[[1,'A','Agency','АН']],amounts:[[45000,50,0,0]]},'Агрегаторы':{names:[[1,'A','Excluded person','Брокер']],amounts:[[45000,0,0,0]]},'Ввод сделок':[[46000,'Партнеры 2026','Agency','Project','PRIVATE-CONTRACT',2,'Подписан',2]]};
 const source=plan(input),view=buildView(source,[{id:'id',name:'Agency',inn:'existing'}],'2026-10-26T00:00:00Z');
 assert.equal(view.items.length,1);assert.equal(view.sourceRowCount,2);assert.equal(view.items[0].periods.length,2);assert.equal(view.items[0].periods[1].totalRub,'0.00');assert.equal(view.matched,1);assert.doesNotMatch(JSON.stringify(view),/PRIVATE-CONTRACT|Excluded person/);
});
test('SDM remains visible but unlinked',()=>{
 const row={tab:'Спящие',row:7,name:'Союз Девелоперов Москвы (СДМ)',normalizedName:'сдм',type:'АН',totalRub:'0.00',baselineRub:'1.00',addedRub:'0.00'};
 const view=buildView({contentHash:'hash',agencies:[row],sourceRows:[row],deals:[],issues:[]},[{id:'id',name:'ИП Лукьянов',inn:'341003103169'}],'now');assert.equal(view.items[0].status,'REVIEW');assert.equal(view.items[0].matchedAgency,null);
});
