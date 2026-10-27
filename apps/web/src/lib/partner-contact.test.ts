import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { PARTNER_PHOTO, partnerPhones } from './partner-contact';
import { contactDateFromInput, contactDateToInput } from './moscow-contact-date';
import { agencyQueueContact, restoredAgencyFilters, sourcePriority } from './agency-workspace-view';
import { createAgencyDraftStore } from './agency-draft-store';
import { supervisorQuery, overdueDuration } from './agency-supervisor';

test('supervisor periods use inclusive Moscow dates and preserve every filter', () => {
  const query = new URLSearchParams(supervisorQuery({from:'2026-10-26',to:'2026-10-27',assigneeId:'operator',campaignId:'campaign',agencyId:'agency',agencyType:'АН'}));
  assert.equal(query.get('from'),'2026-10-26T00:00:00+03:00');
  assert.equal(query.get('to'),'2026-10-27T21:00:00.000Z');
  assert.equal(query.get('assigneeId'),'operator');
  assert.equal(query.get('campaignId'),'campaign');
  assert.equal(query.get('agencyId'),'agency');
  assert.equal(query.get('agencyType'),'АН');
  assert.throws(()=>supervisorQuery({from:'2026-10-27',to:'2026-10-26',assigneeId:'',campaignId:'',agencyId:'',agencyType:''}));
  assert.equal(overdueDuration(1505),'1 д 1 ч');
  assert.equal(overdueDuration(65),'1 ч 5 мин');
});

test('tab drafts survive store recreation, are user scoped and clear only on reset', () => {
  const rows = new Map<string, string>();
  const storage = { get length() { return rows.size; }, key: (i:number) => [...rows.keys()][i] ?? null, getItem:(k:string)=>rows.get(k)??null, setItem:(k:string,v:string)=>{rows.set(k,v);}, removeItem:(k:string)=>{rows.delete(k);} };
  const store = createAgencyDraftStore(() => storage);
  store.write('user-a','contact:1',{version:1,value:{name:'Draft'},baseline:{name:''}});
  assert.equal(store.summary('user-a'),'1:0');
  assert.equal(store.summary('user'),'0:0');
  const restored = createAgencyDraftStore(() => storage);
  assert.equal(JSON.parse(restored.read('user-a','contact:1',{name:''})).value.name,'Draft');
  assert.equal(JSON.parse(restored.read('user-b','contact:1',{name:''})).value.name,'');
  restored.write('user-a','contact:1',{version:1,value:{name:''},baseline:{name:''}});
  assert.equal(rows.size,0);
  assert.equal(restored.summary('user-a'),'0:0');
  restored.write('user-a','other',{version:1,value:'pending',baseline:''});
  restored.write('user-b','other',{version:1,value:'keep',baseline:''});
  restored.clear('user-a');
  assert.equal(restored.summary('user-a'),'0:0');
  assert.equal(restored.summary('user-b'),'1:0');
});

test('tab draft storage failure retains memory copy and exposes warning; corrupted data is ignored', () => {
  const broken = createAgencyDraftStore(() => { throw Error('Storage denied'); });
  broken.write('user','form',{version:1,value:'draft',baseline:''});
  assert.equal(JSON.parse(broken.read('user','form','')).value,'draft');
  assert.equal(broken.summary('user'),'1:1');
  const corrupt = createAgencyDraftStore(() => ({length:1,key:()=> 'agency-v1-2:draft:user:form',getItem:()=>'{bad',setItem:()=>{},removeItem:()=>{}}));
  assert.equal(JSON.parse(corrupt.read('user','form','empty')).value,'empty');
  assert.equal(corrupt.summary('user'),'0:0');
});

test('queue uses active verified contact and alternate phone when agency phone is empty', () => {
  const card={phone:null,callContacts:[{name:'old',phone:'+70000000001',alternatePhone:'',archived:true},{name:'person',phone:'',alternatePhone:'+70000000002',archived:false}]};
  assert.deepEqual(agencyQueueContact(card),{phone:'+70000000002',name:'person'});
  assert.equal(agencyQueueContact({...card,phone:'+70000000003'}).phone,'+70000000003');
  assert.equal(agencyQueueContact({phone:'javascript:123456'}).phone,'Нет телефона');
});

test('saved views restore agency identity and type without accepting malformed filters', () => {
  const agency='11111111-1111-4111-8111-111111111111';
  assert.deepEqual(restoredAgencyFilters({agency,agencyType:'АН'}),{agency,agencyType:'АН'});
  assert.deepEqual(restoredAgencyFilters({agency:['bad'],agencyType:'private'}),{agency:'',agencyType:''});
});

test('queue reports distinct historical priorities without inventing a current value', () => {
  assert.equal(sourcePriority([{fields:[{label:'Приоритет',value:'A'}]},{fields:[{label:'Приоритет',value:'B'}]}]),'A / B');
  assert.equal(sourcePriority([]),'не указан');
});

test('contact datetime accepts browser seconds without appending a second time part', () => {
  for (const input of ['2026-10-27T10:34', '2026-10-27T10:34:00', '2026-10-27T10:34:12.123']) {
    assert.equal(contactDateFromInput(input), '2026-10-27T10:34:00+03:00');
    assert.equal(contactDateToInput(contactDateFromInput(input)), '2026-10-27T10:34');
  }
  assert.equal(contactDateFromInput(''), '');
  assert.equal(contactDateFromInput('not-a-date'), '');
});

test('contact datetime renders existing UTC timestamps in Moscow', () => {
  assert.equal(contactDateToInput('2026-10-26T22:34:00.000Z'), '2026-10-27T01:34');
  assert.equal(contactDateToInput(''), '');
  assert.equal(contactDateToInput('invalid'), '');
});

test('partner phones remain separate dialable links with canonical deduplication', () => {
  const phones = partnerPhones({phone:'+7 (968) 756-16-39', additionalPhones:['+7 930 012 9452', '+7 906 061 7800', '8 930 012 9452', 'javascript:alert(1)']});
  assert.deepEqual(phones.map(p=>p.href), ['tel:+79687561639','tel:+79300129452','tel:+79060617800']);
  assert.equal(phones[1].label, '+7 930 012-94-52');
});
test('legacy contacts keep their phone and malformed extras are ignored', () => {
  assert.equal(partnerPhones({phone:'+7 499 226-22-49',additionalPhones:'not-an-array'}).length,1);
  assert.deepEqual(partnerPhones({}),[]);
});
test('new portrait URL avoids the previously cached asset', () => {
  assert.notEqual(PARTNER_PHOTO,'/v2/img/manager-daria.webp');
  assert.notEqual(PARTNER_PHOTO,'/v2/img/manager-anastasia-20261020.webp');
  const photo=readFileSync(new URL('../../public'+PARTNER_PHOTO,import.meta.url));
  assert.equal(photo.toString('ascii',8,12),'WEBP');
  const component=readFileSync(new URL('../app/v2/LandingV2.tsx',import.meta.url),'utf8');
  assert.match(component,/src=\{PARTNER_PHOTO\}/);
  assert.match(component,/managerPhones\.map/);
});
