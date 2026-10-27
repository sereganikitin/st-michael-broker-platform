import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { PARTNER_PHOTO, partnerPhones } from './partner-contact';
import { contactDateFromInput, contactDateToInput } from './moscow-contact-date';
import { agencyQueueContact, restoredAgencyFilters, sourcePriority } from './agency-workspace-view';

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
