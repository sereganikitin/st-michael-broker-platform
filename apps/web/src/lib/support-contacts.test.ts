import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('account support shows the broker mailbox and uses the same mailto target', () => {
  const component = readFileSync(
    new URL('../components/SupportContacts.tsx', import.meta.url),
    'utf8',
  );
  assert.match(component, /href="mailto:broker@stmichael\.ru"/);
  assert.match(component, />\s*broker@stmichael\.ru\s*</);
  assert.doesNotMatch(component, /info@zorge9\.com/);
});
