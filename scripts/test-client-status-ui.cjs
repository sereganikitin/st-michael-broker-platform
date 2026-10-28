'use strict';
// Synthetic, localhost-only regression. No production requests or writes.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.CLIENT_UI_URL || 'http://127.0.0.1:3138';
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(base)) throw Error('LOCAL_ONLY');
const owner = { id: '11111111-1111-4111-8111-111111111111', fullName: 'Synthetic owner' };
const executor = { id: '22222222-2222-4222-8222-222222222222', fullName: 'Synthetic executor' };
const rows = [
  ['Approved sample', 'CONDITIONALLY_UNIQUE', 'SYNCED'],
  ['Review sample', 'UNDER_REVIEW', 'SYNCED'],
  ['Rejected sample', 'REJECTED', 'SYNCED'],
  ['Failed sample', 'CONDITIONALLY_UNIQUE', 'FAILED'],
  ['Pending sample', 'CONDITIONALLY_UNIQUE', 'PENDING'],
].map(([fullName, uniquenessStatus, amoSyncStatus], i) => ({
  id: `33333333-3333-4333-8333-${String(i + 1).padStart(12, '0')}`,
  fullName, uniquenessStatus, amoSyncStatus, fixationStatus: 'NOT_FIXED', inspectionActSigned: false,
  broker: owner, responsibleBroker: executor, project: 'ZORGE_9', phone: '+70000000000',
  uniquenessExpiresAt: uniquenessStatus === 'CONDITIONALLY_UNIQUE' ? '2026-11-27T21:30:00Z' : null,
  createdAt: '2026-10-28T10:00:00Z', status: 'NEW', deals: [], meetings: [], uniquenessHistory: [],
}));
(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  let writes = 0;
  try {
    for (const mode of ['ADMIN', 'EXECUTOR']) {
      const current = mode === 'ADMIN' ? { ...owner, role: 'ADMIN' } : { ...executor, role: 'BROKER' };
      const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, timezoneId: 'UTC' });
      await context.addInitScript(id => {
        localStorage.setItem('accessToken', 'synthetic');
        localStorage.setItem('stm_onboarding_seen_' + id, '1');
      }, current.id);
      await context.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== base) return route.abort();
        if (!url.pathname.startsWith('/api/')) return route.continue();
        if (request.method() !== 'GET') { writes++; return route.abort(); }
        let body = {};
        if (url.pathname === '/api/auth/me') body = { ...current, status: 'ACTIVE', agencies: [] };
        if (url.pathname === '/api/clients') body = { clients: rows, total: rows.length, totalPages: 1 };
        if (url.pathname.startsWith('/api/clients/')) body = rows.find(row => row.id === url.pathname.split('/').pop()) || {};
        await route.fulfill({ json: body });
      });
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      await page.goto(base + '/clients');
      const approved = page.getByRole('row').filter({ hasText: 'Approved sample' });
      await approved.waitFor();
      assert.match(await approved.innerText(), /Передан в amoCRM/);
      if (mode === 'ADMIN') {
        assert.match(await approved.innerText(), /Уникален до 28\.11\.2026/);
        assert.equal(await approved.getByText('28.11.2026', { exact: true }).count(), 1);
      }
      else {
        assert.match(await approved.innerText(), /Исполнитель по фиксации/);
        assert.doesNotMatch(await approved.innerText(), /Уникален до/);
      }
      for (const [name, label] of [['Review sample', 'На проверке'], ['Rejected sample', 'Не уникален']]) {
        const text = await page.getByRole('row').filter({ hasText: name }).innerText();
        if (mode === 'ADMIN') assert.ok(text.includes(label));
        else assert.match(text, /Исполнитель по фиксации/);
        assert.doesNotMatch(text, /Уникален до/);
      }
      assert.match(await page.getByRole('row').filter({ hasText: 'Failed sample' }).innerText(), /Передача не подтверждена/);
      assert.match(await page.getByRole('row').filter({ hasText: 'Pending sample' }).innerText(), /Передача проверяется/);
      assert.doesNotMatch(await page.locator('body').innerText(), /Клиент не зафиксирован/);
      await approved.locator('td').first().click();
      await page.getByRole('heading', { name: 'Approved sample', exact: true }).waitFor();
      assert.doesNotMatch(await page.locator('body').innerText(), /Акт осмотра подписан|не зафиксирован/);
      if (mode === 'ADMIN') assert.match(await page.locator('body').innerText(), /28\.11\.2026, 00:30/);
      await page.screenshot({ path: `work/client-status-${mode.toLowerCase()}.png`, fullPage: false });
      await context.close();
    }
    assert.equal(writes, 0);
    console.log('PASS: admin/executor list and details; uniqueness/transport separation; conflicts and failures preserved; UTC browser displays Moscow date; zero API writes');
  } finally { await browser.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
