import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildReport,
  findMisnamedRecordings,
  parsePlaudRecent,
  splitTelegramMessage,
  validateRecordingName,
} from './monitor-plaud-file-names.mjs';

const fixture = `
Recordings in the last 7 days: 4

  0123456789abcdef0123456789abcdef  2026-09-30 11:30:37  2026-09-30  2h11m
  abcdef0123456789abcdef0123456789  2026-09-29 19:17:41 Иван Иванович  2026-09-29  57m40s
  fedcba9876543210fedcba9876543210  11-22 Консультация: Покупка апартаментов  2026-09-23  1h10m
  11111111111111111111111111111111  2026-09-20 15:37:59 Анна  2026-09-20  33m08s
`;

test('parses full untruncated names from plaud recent output', () => {
  const rows = parsePlaudRecent(fixture);
  assert.equal(rows.length, 4);
  assert.equal(rows[1].name, '2026-09-29 19:17:41 Иван Иванович');
});

test('accepts required timestamp and client name', () => {
  assert.equal(validateRecordingName('2026-09-29 19:17:41 Иван Иванович').valid, true);
  assert.equal(validateRecordingName('2026-09-20 15:37:59 Анна').valid, true);
});

test('rejects timestamp-only, legacy, generic and impossible names', () => {
  assert.equal(validateRecordingName('2026-09-30 11:30:37').valid, false);
  assert.equal(validateRecordingName('11-22 Консультация: Покупка апартаментов').valid, false);
  assert.equal(validateRecordingName('2026-09-30 11:30:37 Клиент').valid, false);
  assert.equal(validateRecordingName('2026-02-31 25:70:00 Иван').valid, false);
});

test('finds only recordings that need renaming', () => {
  const rows = parsePlaudRecent(fixture);
  const misnamed = findMisnamedRecordings(rows);
  assert.deepEqual(misnamed.map((row) => row.name), [
    '2026-09-30 11:30:37',
    '11-22 Консультация: Покупка апартаментов',
  ]);
});

test('builds both success and warning reports without exposing tokens', () => {
  const rows = parsePlaudRecent(fixture);
  const warning = buildReport(rows, findMisnamedRecordings(rows), 7, new Date('2026-10-02T06:00:00Z'));
  assert.match(warning, /Нужно переименовать: 2 из 4/u);
  assert.match(warning, /ГГГГ-ММ-ДД ЧЧ:ММ:СС Имя клиента/u);

  const success = buildReport(rows.slice(1, 2), [], 7, new Date('2026-10-02T06:00:00Z'));
  assert.match(success, /Непереименованных встреч не найдено/u);
});

test('splits long Telegram messages under the configured limit', () => {
  const chunks = splitTelegramMessage(['header', ...Array.from({ length: 30 }, (_, i) => `${i}. ${'x'.repeat(20)}`)].join('\n'), 100);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 100));
});

