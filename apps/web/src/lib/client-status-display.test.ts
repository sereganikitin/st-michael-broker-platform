import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ClientAmoTransferStatus } from '../components/ClientAmoTransferStatus';
import { clientStatusDisplay, clientTransferUnconfirmed, clientTransferAwaitingFixation } from './client-status-display';

for (const amoSyncStatus of ['FAILED', 'PENDING']) {
  test(`${amoSyncStatus} and NOT_FIXED do not imply a successful fixation`, () => {
    const client = { uniquenessStatus: 'CONDITIONALLY_UNIQUE', fixationStatus: 'NOT_FIXED', amoSyncStatus };
    const result = clientStatusDisplay(client);
    assert.notEqual(result.label, 'Уникален');
    assert.equal(result.showUniquenessExpiry, false);
    assert.match(result.explanation, /передача в amoCRM не подтверждена/i);
    assert.equal(client.uniquenessStatus, 'CONDITIONALLY_UNIQUE');
  });
}
test('historical and already fixed rows retain their uniqueness verdict', () => {
  for (const evidence of [{ amoSyncStatus: 'SYNCED', fixationStatus: 'FIXED' }, { amoSyncStatus: 'FAILED', fixationStatus: 'FIXED' }, {}]) {
    assert.equal(clientStatusDisplay({ uniquenessStatus: 'CONDITIONALLY_UNIQUE', ...evidence }).label, 'Уникален');
  }
});

test('confirmed transfer preserves uniqueness and does not invent a signed inspection act', () => {
  const client = { uniquenessStatus: 'CONDITIONALLY_UNIQUE', fixationStatus: 'NOT_FIXED', amoSyncStatus: 'SYNCED', uniquenessExpiresAt: '2026-11-27T21:30:00.000Z', inspectionActSigned: false };
  const before = { ...client };
  const result = clientStatusDisplay(client);
  assert.equal(result.label, 'Уникален до 28.11.2026');
  assert.equal(result.explanation, '');
  assert.equal(result.showUniquenessExpiry, true);
  assert.equal(clientTransferAwaitingFixation(client), true);
  assert.equal(clientTransferUnconfirmed(client), false);
  assert.deepEqual(client, before);
});
test('rejected, expired and under review verdicts are not replaced with success', () => {
  for (const [uniquenessStatus, label] of [['REJECTED', 'Не уникален'], ['EXPIRED', 'Истёк'], ['UNDER_REVIEW', 'На проверке']]) {
    for (const amoSyncStatus of ['FAILED', 'PENDING', 'SYNCED']) {
      const client = { uniquenessStatus, amoSyncStatus, fixationStatus: 'NOT_FIXED' };
      assert.equal(clientStatusDisplay(client).label, label);
      assert.equal(clientTransferAwaitingFixation(client), false);
    }
  }
});

test('both list and responsive details preserve executor identity alongside confirmed transfer status', () => {
  const source = readFileSync(resolve(__dirname, '../app/(cabinet)/clients/page.tsx'), 'utf8');
  assert.match(source, /isExecutorView\(client, broker\?\.id\) && !clientTransferUnconfirmed\(client\)/);
  assert.match(source, /isExecutorView\(c, broker\?\.id\) && !clientTransferUnconfirmed\(c\)/);
  assert.ok((source.match(/Исполнитель по фиксации/g) || []).length >= 2);
  assert.match(source, /<ClientAmoTransferStatus client=\{client\}/);
  assert.match(source, /<ClientAmoTransferStatus client=\{c\}/);
  assert.doesNotMatch(source, /Клиент не зафиксирован|clientTransferAwaitingFixation/);
});
test('list, details, dashboard and both staff lists consume the same presentation rule', () => {
  const web = resolve(__dirname, '..');
  for (const file of ['app/(cabinet)/clients/page.tsx', 'app/(cabinet)/dashboard/page.tsx', 'app/(cabinet)/admin/brokers/[id]/page.tsx', 'app/(cabinet)/admin/broker-applications/page.tsx']) {
    assert.match(readFileSync(resolve(web, file), 'utf8'), /clientStatusDisplay/);
    assert.match(readFileSync(resolve(web, file), 'utf8'), /ClientAmoTransferStatus/);
  }
  assert.equal(clientTransferUnconfirmed({ amoSyncStatus: 'FAILED', fixationStatus: 'NOT_FIXED' }), true);
});

test('transport badge only confirms transport, including for rejected and reviewed clients', () => {
  for (const uniquenessStatus of ['CONDITIONALLY_UNIQUE', 'REJECTED', 'UNDER_REVIEW', 'EXPIRED']) {
    const html = renderToStaticMarkup(createElement(ClientAmoTransferStatus, { client: { uniquenessStatus, amoSyncStatus: 'SYNCED', fixationStatus: 'NOT_FIXED' } }));
    assert.match(html, />Передан в amoCRM<\/span>/);
    assert.doesNotMatch(html, /не зафиксирован|Уникален до|Акт осмотра подписан/);
  }
  for (const amoSyncStatus of ['FAILED', 'PENDING', null, undefined]) {
    assert.equal(renderToStaticMarkup(createElement(ClientAmoTransferStatus, { client: { amoSyncStatus } })), '');
  }
});

test('missing or invalid dates are not fabricated', () => {
  for (const uniquenessExpiresAt of [null, undefined, 'invalid']) {
    assert.equal(clientStatusDisplay({ uniquenessStatus: 'CONDITIONALLY_UNIQUE', amoSyncStatus: 'SYNCED', fixationStatus: 'NOT_FIXED', uniquenessExpiresAt }).label, 'Уникален');
  }
});
test('staff application contract carries fixation evidence without overwriting uniqueness', () => {
  const source = readFileSync(resolve(__dirname, '../../../api/src/admin/admin.service.ts'), 'utf8');
  assert.match(source, /extra: \{ project: c\.project, uniquenessStatus: c\.uniquenessStatus, fixationStatus: c\.fixationStatus, fromAmoSync \}/);
});
