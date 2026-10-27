import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const page = readFileSync(new URL('../app/(cabinet)/admin/documents/page.tsx', import.meta.url), 'utf8');
const service = readFileSync(new URL('../../../api/src/documents/documents.service.ts', import.meta.url), 'utf8');

test('admin documents list asks for the server maximum, not the first 200', () => {
  const serverMax = Number(service.match(/Math\.min\((\d+), Math\.max\(1, Number\(filters\.limit\)/)?.[1]);
  assert.equal(serverMax, 2000);
  assert.match(page, new RegExp(`const ADMIN_DOCUMENTS_LIMIT = ${serverMax};`));
  assert.doesNotMatch(page, /limit=200\b/);
  assert.match(page, /limit=\$\{ADMIN_DOCUMENTS_LIMIT\}/);
});

test('admin documents list warns when the server holds more documents than shown', () => {
  assert.match(page, /setTotal\(Number\(d\.total\) \|\| list\.length\)/);
  assert.match(page, /total > docs\.length && \(/);
  assert.match(page, /Показаны \{docs\.length\} из \{total\} документов/);
});
