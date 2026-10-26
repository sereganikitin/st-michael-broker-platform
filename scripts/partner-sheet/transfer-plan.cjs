'use strict';
const {createHash}=require('node:crypto');
const {matchAgencies,normalizedKey,sourceLabel}=globalThis.__partnerSheetMatch||require('./match.cjs');
// Reviewed correspondences for this sheet only, not global fuzzy aliases.
const REVIEWED={
 'Агрегаторы:6':{source:'Trend Agent',target:'ООО «Онлайн Недвижимость»',inn:'9702028892',reason:'EXISTING_CABINET_ALIAS_LEGAL_ENTITY'},
 'Спящие:16':{source:'Kalinka',target:'Калинка',reason:'REVIEWED_BRAND_TRANSLITERATION'},
};
const NEW_CANDIDATES={
 'Партнеры 2026:6':{source:'ИП Цюрупа Ю.А. (HighPoint)',name:'HighPoint',legalName:'ИП Цюрупа Юлия Андреевна',inn:'770470572401',sourceUrl:'https://highpoint.estate/rules'},
 'Спящие:19':{source:'Wellside',name:'Wellside',legalName:'ООО Веллсайд',inn:'9731116328',sourceUrl:'https://wellside.ru/privacy_policy'},
};
function transferPlan(source,organizations){
 const mapping=matchAgencies(source.agencies,organizations),bindings=[],quarantine=[],newAgencyCandidates=[];
 for(const [index,agency] of source.agencies.entries()){
  const m=mapping[index],key=`${agency.tab}:${agency.row}`,rule=REVIEWED[key];
  let matches=m.matches,reason=m.reason;
  if(rule&&sourceLabel(agency)===rule.source){
   const exact=organizations.filter(o=>(normalizedKey(o.name)===normalizedKey(rule.target)||normalizedKey(o.legalName)===normalizedKey(rule.target))&&(!rule.inn||o.inn===rule.inn));
   // Narrow only; an unrelated name or INN change cannot silently move binding.
   if(exact.length===1&&(m.matches.includes(exact[0].id)||m.candidates.includes(exact[0].id))){matches=[exact[0].id];reason=rule.reason;}
  }
  if(matches.length===1){
   const org=organizations.find(o=>o.id===matches[0]);
   bindings.push({tab:agency.tab,row:agency.row,sourceName:agency.name,targetId:org.id,targetInn:org.inn,reason,
    sourceReported:{currency:'RUB',totalRub:agency.totalRub,addedRub:agency.addedRub,baselineRub:agency.baselineRub,baselineScope:agency.tab==='Спящие'?'BEFORE_2026':'SOURCE_2026_BASELINE'},
    overwriteAgencyIdentity:false,addToCrmTurnover:false});
  }else{
   const candidate=NEW_CANDIDATES[key];
   if(candidate&&agency.name===candidate.source&&m.matches.length===0&&m.candidates.length===0){
    const byInn=organizations.filter(o=>o.inn===candidate.inn);
    if(byInn.length)quarantine.push({tab:agency.tab,row:agency.row,reason:'EXISTING_INN_REQUIRES_REVIEW'});
    else newAgencyCandidates.push({tab:agency.tab,row:agency.row,...candidate,requiresRegistryValidation:true});
   }else quarantine.push({tab:agency.tab,row:agency.row,reason:matches.length>1?'AMBIGUOUS_IDENTITY':'UNPROVEN_IDENTITY'});
  }
 }
 const payload={version:'partner-sheet-transfer-plan-v1',sourceHash:source.contentHash,bindings,newAgencyCandidates,quarantine,sourceIssues:source.issues,
  aggregatePolicy:'REPLACE_SOURCE_SNAPSHOT_NOT_ADD_TO_CRM',databaseWrites:false};
 return {...payload,planHash:createHash('sha256').update(JSON.stringify(payload)).digest('hex')};
}
module.exports={transferPlan};
