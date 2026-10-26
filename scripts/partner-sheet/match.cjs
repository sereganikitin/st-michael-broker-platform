'use strict';
// Mirror the cabinet's established agency keys; parity is checked against
// loyalty-base.service.ts. Similarity is candidate discovery, NOT identity.
const STOP=new Set(['ооо','оао','зао','пао','ао','ип','ан','агентство','недвижимости','llc','ltd']);
function normalizedKey(value){
 const tokens=String(value??'').normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
 if(!tokens.length)return null;
 const meaningful=tokens.filter(t=>!STOP.has(t));return (meaningful.length?meaningful:tokens).join('')||null;
}
const ALIASES={trendagent:normalizedKey('ООО «Онлайн Недвижимость»'),нмаркетпро:normalizedKey('Нмаркет')};
const canonicalKey=value=>{const key=normalizedKey(value);return key?(ALIASES[key]||key):null;};
const sourceLabel=agency=>agency.type==='Агрегатор'?agency.name.replace(/\s+—\s+ИТОГО\s*$/u,''):agency.name;
const LATIN={а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'i',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'kh',ц:'ts',ч:'ch',ш:'sh',щ:'shch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya'};
const latinKey=value=>[...(normalizedKey(value)||'')].map(c=>LATIN[c]??c).join('');
function distance(a,b){
 let row=Array.from({length:b.length+1},(_,i)=>i);
 for(let i=1;i<=a.length;i++){const next=[i];for(let j=1;j<=b.length;j++)next[j]=Math.min(next[j-1]+1,row[j]+1,row[j-1]+(a[i-1]===b[j-1]?0:1));row=next;}
 return row[b.length];
}
function matchAgencies(agencies,organizations){
 return agencies.map(agency=>{
  const label=sourceLabel(agency),key=canonicalKey(label),matches=new Map(),candidates=new Map();
  for(const org of organizations){
   for(const name of [org.name,org.legalName].filter(Boolean)){
    if(key&&key===canonicalKey(name))matches.set(org.id,org);
    else {
     const a=latinKey(label),b=latinKey(name);
     if(a.length>=5&&b.length>=5&&(a===b||distance(a,b)<=Math.min(2,Math.floor(Math.max(a.length,b.length)*0.15))))candidates.set(org.id,org);
    }
   }
  }
  for(const id of matches.keys())candidates.delete(id);
  return {tab:agency.tab,row:agency.row,matches:[...matches.keys()],candidates:[...candidates.keys()],reason:matches.size?'CABINET_CANONICAL_KEY':candidates.size?'SIMILARITY_REVIEW_ONLY':'NO_MATCH'};
 });
}
module.exports={normalizedKey,canonicalKey,sourceLabel,matchAgencies};
