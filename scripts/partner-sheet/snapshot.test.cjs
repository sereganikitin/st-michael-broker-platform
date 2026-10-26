'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {validateView,encodeSnapshot,decodeSnapshot}=require('./snapshot.cjs');
const {COLUMNS}=require('./details.cjs');
const view=()=>({version:'agency-v1-2',readOnly:true,loadedAt:'2026-10-26T12:00:00.000Z',sourceHash:'a'.repeat(64),sourceRowCount:1,matched:1,review:0,new:0,audit:{sourceFields:19},items:[{name:'Agency',type:'АН',status:'MATCHED',periods:[{tab:'Партнеры 2026',row:6,baselineRub:'10.00',addedRub:'2.00',totalRub:'12.00',fields:COLUMNS.map(c=>({column:String.fromCharCode(65+c),label:'Label',value:''}))}]}]});
test('complete snapshots roundtrip with integrity, allow new agencies and absolute amount updates',()=>{
 const a=view(),b=decodeSnapshot(encodeSnapshot(a));assert.deepEqual(a,b);
 b.items[0].periods[0].totalRub='13.00';b.items[0].periods[0].addedRub='3.00';validateView(b,a);
 const extra=JSON.parse(JSON.stringify(b.items[0]));extra.name='New';extra.periods[0].row=7;b.items.push(extra);b.sourceRowCount++;b.matched++;b.audit.sourceFields+=19;validateView(b,a);
});
test('reject corruption, truncated fields, duplicate rows, amount mismatch and lost agencies',()=>{
 const text=encodeSnapshot(view());assert.throws(()=>decodeSnapshot(text.replace('Agency','Changed')),/DIGEST/);
 for(const mutate of [v=>v.items[0].periods[0].fields.pop(),v=>v.items[0].periods[0].totalRub='11.00',v=>v.sourceRowCount++,v=>v.items[0].periods[0].tab='Контакты']){
  const v=view();mutate(v);assert.throws(()=>validateView(v));
 }
 const a=view(),b=view();b.items[0].name='Different';assert.throws(()=>validateView(b,a),/PREVIOUS_AGENCY_MISSING/);
});
