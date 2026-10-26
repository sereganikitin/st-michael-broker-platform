'use strict';
const {normalizedKey}=globalThis.__partnerSheetMatch||require('./match.cjs');
function exactActiveParty(candidate,suggestions){
 const exact=(Array.isArray(suggestions)?suggestions:[]).filter(s=>s?.data?.inn===candidate.inn);
 if(exact.length!==1)return false;
 const data=exact[0].data,expectedType=candidate.inn.length===12?'INDIVIDUAL':'LEGAL';
 return data.state?.status==='ACTIVE'&&data.type===expectedType&&[data.name?.short,data.name?.full,data.name?.short_with_opf,data.name?.full_with_opf].some(n=>n&&normalizedKey(n)===normalizedKey(candidate.legalName));
}
async function verifyRegistry(candidates,apiKey,request=fetch){
 const output=[];
 for(const candidate of candidates){
  let verified=false;
  if(apiKey)try{
   const response=await request('https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/party',{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{'Content-Type':'application/json',Authorization:`Token ${apiKey}`},body:JSON.stringify({query:candidate.inn,count:5})});
   if(response.ok){const body=await response.text();if(body.length<=65536)verified=exactActiveParty(candidate,JSON.parse(body).suggestions);}
  }catch{}
  output.push({tab:candidate.tab,row:candidate.row,configured:Boolean(apiKey),activeExactLegalIdentity:verified});
 }
 return output;
}
module.exports={exactActiveParty,verifyRegistry};
