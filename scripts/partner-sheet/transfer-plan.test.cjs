'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {transferPlan}=require('./transfer-plan.cjs');
const row=(tab,row,name,type='АН')=>({tab,row,name,type,totalRub:'100.00',addedRub:'20.00',baselineRub:'80.00'});
const source=agencies=>({contentHash:'a'.repeat(64),agencies,issues:[]});
test('prefer known legal-entity alias without merging alternative TrendAgent card',()=>{
 const result=transferPlan(source([row('Агрегаторы',6,'Trend Agent — ИТОГО','Агрегатор')]),[{id:'main',name:'ООО «Онлайн Недвижимость»',inn:'9702028892'},{id:'other',name:'Trend Agent',inn:'366608971476'}]);
 assert.equal(result.bindings[0].targetId,'main');assert.equal(result.bindings[0].overwriteAgencyIdentity,false);assert.equal(result.bindings[0].addToCrmTurnover,false);
});
test('known legal identity with changed INN cannot narrow ambiguous candidates',()=>{
 const result=transferPlan(source([row('Агрегаторы',6,'Trend Agent — ИТОГО','Агрегатор')]),[{id:'main',name:'ООО Онлайн Недвижимость',inn:'changed'},{id:'other',name:'TrendAgent',inn:'other'}]);
 assert.equal(result.bindings.length,0);assert.equal(result.quarantine.length,1);
});
test('reviewed Kalinka transliteration preserves existing placeholder INN',()=>{
 const result=transferPlan(source([row('Спящие',16,'Kalinka')]),[{id:'old',name:'Калинка',inn:'NOINN-legacy'}]);
 assert.equal(result.bindings[0].targetInn,'NOINN-legacy');assert.equal(result.bindings[0].sourceReported.baselineScope,'BEFORE_2026');
});
test('review does not generalize to arbitrary similarly spelled brands',()=>{
 const result=transferPlan(source([row('Спящие',17,'Kalinka')]),[{id:'old',name:'Калинка',inn:'NOINN-legacy'}]);assert.equal(result.bindings.length,0);assert.equal(result.quarantine.length,1);
});
test('public-source absent entities stay candidates until registry validation',()=>{
 const result=transferPlan(source([row('Спящие',19,'Wellside')]),[]);assert.equal(result.newAgencyCandidates.length,1);assert.equal(result.newAgencyCandidates[0].requiresRegistryValidation,true);assert.equal(result.databaseWrites,false);
});
test('same INN already in base never proposes another organization',()=>{
 const result=transferPlan(source([row('Спящие',19,'Wellside')]),[{id:'old',name:'Another spelling',inn:'9731116328'}]);assert.equal(result.newAgencyCandidates.length,0);assert.equal(result.quarantine[0].reason,'EXISTING_INN_REQUIRES_REVIEW');
});
test('unknown SDM stays quarantined even if a researched INN exists',()=>{
 const result=transferPlan(source([row('Спящие',7,'Союз Девелоперов Москвы (СДМ)')]),[{id:'old',name:'ИП Лукьянов Никита Владимирович',inn:'341003103169'}]);assert.equal(result.bindings.length,0);assert.equal(result.quarantine.length,1);
});
test('repeated planning is deterministic and source amounts are never incremented',()=>{
 const s=source([row('Партнеры 2026',8,'Agency')]),org=[{id:'old',name:'Agency',inn:'existing'}];assert.deepEqual(transferPlan(s,org),transferPlan(s,org));assert.equal(transferPlan(s,org).bindings[0].sourceReported.totalRub,'100.00');
});
