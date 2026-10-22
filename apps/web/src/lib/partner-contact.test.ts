import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { PARTNER_PHOTO, partnerPhones } from './partner-contact';

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
