'use strict';
const {transferPlan}=require('./transfer-plan.cjs');
function buildView(source,organizations,loadedAt){
 const transfer=transferPlan(source,organizations);
 const bySource=new Map(transfer.bindings.map(b=>[`${b.tab}:${b.row}`,b]));
 const items=source.agencies.map(a=>{
  const binding=bySource.get(`${a.tab}:${a.row}`),target=binding&&organizations.find(o=>o.id===binding.targetId);
  const periods=source.sourceRows.filter(row=>row.normalizedName===a.normalizedName).map(row=>({tab:row.tab,row:row.row,lastDate:row.lastDate,baselineRub:row.baselineRub,addedRub:row.addedRub,totalRub:row.totalRub,baselineScope:row.tab==='Спящие'?'BEFORE_2026':'SOURCE_2026_BASELINE'}));
  const isQuarantined=transfer.quarantine.some(q=>q.tab===a.tab&&q.row===a.row);
  return {key:`${a.tab}:${a.row}`,name:a.name,type:a.type,periods,status:binding?'MATCHED':isQuarantined?'REVIEW':'NEW',matchedAgency:target?{id:target.id,name:target.name}:null};
 });
 // Contract identifiers are not returned to the browser; source agency
 // amounts already include them and must never be added a second time.
 return {version:'agency-v1-2',loadedAt,sourceHash:source.contentHash,items,sourceRowCount:source.sourceRows.length,dealRowCount:source.deals.length,
  matched:items.filter(i=>i.status==='MATCHED').length,review:items.filter(i=>i.status==='REVIEW').length,new:items.filter(i=>i.status==='NEW').length,
  readOnly:true,excludedTabs:['Контакты','Обзвон БТ'],warning:'Суммы из таблицы показаны отдельно и не прибавляются к обороту amoCRM. Исторические периоды не суммируются между собой.'};
}
module.exports={buildView};
