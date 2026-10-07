import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { validateAdminPasswordInput } from './admin-password';

test('administrator reauthentication and confirmation are required', () => {
  assert.ok(validateAdminPasswordInput('', 'new-long-password', 'new-long-password'));
  assert.ok(validateAdminPasswordInput('admin-password', 'new-long-password', 'other'));
  assert.equal(validateAdminPasswordInput('admin-password', 'new-long-password', 'new-long-password'), null);
});
test('new-password limits count full Unicode characters', () => {
  for (const size of [11, 129]) assert.ok(validateAdminPasswordInput('admin', '🙂'.repeat(size), '🙂'.repeat(size)));
  for (const size of [12, 128]) assert.equal(validateAdminPasswordInput('admin', '🙂'.repeat(size), '🙂'.repeat(size)), null);
});
test('validation does not echo secret inputs', () => {
  const secret = 'sensitive-admin-test-password';
  assert.doesNotMatch(validateAdminPasswordInput(secret, 'short', 'other')!, /sensitive|short|other/);
});
const form = readFileSync(new URL('../components/AdminPasswordForm.tsx', import.meta.url), 'utf8');
const detail = readFileSync(new URL('../app/(cabinet)/admin/brokers/[id]/page.tsx', import.meta.url), 'utf8');
const profile = readFileSync(new URL('../app/(cabinet)/profile/page.tsx', import.meta.url), 'utf8');
test('password action targets one explicit UUID, with confirmation and double-submit protection', () => {
  assert.match(form, /encodeURIComponent\(id\)/);
  assert.match(form, /window\.confirm/);
  assert.match(form, /if \(pending\.current\) return/);
  assert.match(form, /JSON\.stringify\(\{ currentPassword, newPassword \}\)/);
});
test('secrets are masked, cleared after any outcome, never persisted or logged', () => {
  assert.equal((form.match(/type="password"/g) || []).length, 3);
  assert.match(form, /finally\s*\{\s*setCurrentPassword\(''\); setNewPassword\(''\); setConfirmation\(''\)/);
  assert.doesNotMatch(form, /console\.|localStorage|sessionStorage|clipboard|error\.message/);
});
test('only administrators see the other-user password action; self change logs out', () => {
  assert.match(detail, /isAdmin && currentUser\?\.id !== broker\.id && broker\.status === 'ACTIVE' && !broker\.mergedIntoId/);
  assert.match(profile, /await apiPost\('\/auth\/change-password'[\s\S]*?logout\(\);[\s\S]*?window\.location\.assign\('\/login\?passwordChanged=1'\)/);
});
test('route changes cannot expose an old user form or violate hook ordering', () => {
  assert.match(detail, /if \(loading \|\| \(broker && broker\.id !== id\)\)/);
  assert.match(detail, /activeRouteId\.current !== id \|\| sequence !== loadSequence\.current/);
  assert.ok(detail.indexOf('useEffect(() =>') < detail.indexOf('return <div className="card">Доступ запрещён'));
  assert.equal((form.match(/maxLength=\{256\}/g) || []).length, 3);
  assert.doesNotMatch(form, /minLength=\{12\}|maxLength=\{128\}/);
});
