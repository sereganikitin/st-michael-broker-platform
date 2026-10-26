'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {canonicalKey,normalizedKey,sourceLabel,matchAgencies}=require('./match.cjs');
test('matches established aliases, legal forms and punctuation',()=>{
 assert.equal(canonicalKey('Trend Agent'),canonicalKey('ООО «Онлайн Недвижимость»'));
 assert.equal(canonicalKey('Нмаркет.Про'),canonicalKey('Нмаркет'));
 assert.equal(canonicalKey('АН «Ромашка»'),canonicalKey('ООО Ромашка'));
 assert.equal(normalizedKey('АН'),'ан');assert.equal(normalizedKey(''),null);
});
test('cabinet source parity for normalization and every saved alias',()=>{
 const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
 const source=fs.readFileSync(path.join(__dirname,'../../apps/api/src/loyalty-base/loyalty-base.service.ts'),'utf8');
 const section=source.slice(source.indexOf('const AGENCY_NAME_STOP_TOKENS'),source.indexOf('@Injectable()',source.indexOf('const AGENCY_NAME_STOP_TOKENS')));
 const js=section.replaceAll('export ','').replace('value: unknown): string | null','value)').replace('value: unknown): string | null','value)').replace(': Record<string, string>','').replaceAll(')!',')');
 const context={};vm.createContext(context);vm.runInContext(js+';this.normal=normalizeAgencyMatchKey;this.canonical=canonicalAgencyMatchKey;this.aliases=AGENCY_KEY_ALIASES;',context);
 for(const name of ['АН','',null,'ООО «Ромашка»','Trend Agent','Нмаркет.Про',...Object.keys(context.aliases),...Object.values(context.aliases)]){
  assert.equal(normalizedKey(name),context.normal(name));assert.equal(canonicalKey(name),context.canonical(name));
 }
});
test('total suffix is only removed for aggregator presentation labels',()=>{
 assert.equal(sourceLabel({name:'Trend Agent — ИТОГО',type:'Агрегатор'}),'Trend Agent');
 assert.equal(sourceLabel({name:'Agency — ИТОГО',type:'АН'}),'Agency — ИТОГО');
});
test('never choose one of multiple canonical organizations',()=>{
 const result=matchAgencies([{name:'Trend Agent — ИТОГО',type:'Агрегатор'}],[{id:'1',name:'Онлайн Недвижимость'},{id:'2',name:'TrendAgent'}])[0];
 assert.equal(result.matches.length,2);
});
test('transliteration and spelling suggest review, never canonical match',()=>{
 const r=matchAgencies([{name:'Калинка',type:'АН'}],[{id:'1',name:'Kalinka'}])[0];
 assert.equal(r.matches.length,0);assert.deepEqual(r.candidates,['1']);assert.equal(r.reason,'SIMILARITY_REVIEW_ONLY');
});
test('a legal name and display name never duplicate one target',()=>{
 const r=matchAgencies([{name:'Trend Agent',type:'Агрегатор'}],[{id:'1',name:'TrendAgent',legalName:'ООО Онлайн Недвижимость'}])[0];assert.deepEqual(r.matches,['1']);
});
