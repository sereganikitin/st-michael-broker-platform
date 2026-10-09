import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const inspector = require('../../../../scripts/inspect-runtime-errors');
const token = '123456:fake_private_token';
const env = { OPS_TELEGRAM_BOT_TOKEN: token, OPS_ALERT_CHAT_IDS: '-10001, -10002;-10001', TELEGRAM_API_BASE: 'http://172.18.0.1:8081' };
const compiled = `process.env.PROFITBASE_FEED_ZORGE || 'https://pb123.profitbase.ru/export/profitbase_xml/abc123?scheme=https'; process.env.PROFITBASE_FEED_SILVER || 'https://pb123.profitbase.ru/export/profitbase_xml/def456?scheme=https'`;

describe('read-only runtime error inspector', () => {
  it.each([
    ['duplicate key value violates unique constraint "brokers_amo_contact_id_key"', 'unique_conflict'],
    ['violates foreign key constraint', 'foreign_key_conflict'],
    ['null value in column violates not-null constraint', 'not_null_conflict'],
    ['invalid input syntax for integer', 'invalid_input'],
    ['canceling statement due to statement timeout', 'statement_timeout'],
    ['deadlock detected', 'deadlock'],
    ['could not serialize access', 'serialization_conflict'],
    ['remaining connection slots are reserved', 'connection_limit'],
    ['password authentication failed', 'authentication_rejected'],
    ['no space left on device', 'disk_capacity'],
    ['terminating connection due to administrator command', 'connection_interrupted'],
    ['an unknown error with PRIVATE_VALUE', 'other_database_error'],
  ])('classifies only error headline: %s', (text, category) => {
    expect(inspector.classifyPostgresLine(`2026-10-09 ERROR: ${text}`)?.category).toBe(category);
    expect(inspector.classifyPostgresLine(`DETAIL: ${text}`)).toBeNull();
  });

  it('never emits statements, detail data, arbitrary constraint names, phones or emails', async () => {
    const report = await inspector.postgresReport(Readable.from([
      'ERROR: duplicate key value violates unique constraint "brokers_amo_contact_id_key"\nDETAIL: phone=+79991112233 email=secret@example.ru\nSTATEMENT: INSERT INTO brokers(password_hash) VALUES (private_hash);\n',
      'ERROR: duplicate key value violates unique constraint "SECRET_CONSTRAINT"\n',
      'LOG: normal operation\n',
    ]));
    expect(report.total).toBe(2);
    expect(report.categories.unique_conflict).toBe(2);
    expect(report.knownUniqueConstraints).toEqual({ brokers_amo_contact_id_key: 1, other: 1 });
    expect(JSON.stringify(report)).not.toMatch(/secret|PRIVATE|INSERT|phone|hash|7999/i);
  });

  it('handles split input without printing a raw fragment', async () => {
    const report = await inspector.postgresReport(Readable.from(['ERROR: dead', 'lock detected\nERROR: password authentication failed']));
    expect(report.categories).toEqual({ deadlock: 1, authentication_rejected: 1 });
  });

  it('counts post-release API errors without copying raw messages or PII', async () => {
    const report = await inspector.apiReport(Readable.from([
      '[Nest] 1 - ERROR [database] request failed PRIVATE@example.ru\n',
      '[Nest] 1 - ERROR [OpsAlertService] [OpsAlert] Failed to deliver alert: token PRIVATE\n',
      '[Nest] 1 - ERROR [SchedulerService] Catalog sync failed: PRIVATE_URL\n',
      '[Nest] 1 - ERROR [OtherService] password=PRIVATE\n[Nest] 1 - LOG [Service] normal\n',
      '[Nest] 1 - LOG [Service] ignored body ERROR [OtherService] PRIVATE\n',
    ]));
    expect(report).toMatchObject({ totalErrorLines: 4, databaseErrorLines: 1, telegramDeliveryErrorLines: 1, catalogSyncErrorLines: 1, otherErrorLines: 1 });
    expect(JSON.stringify(report)).not.toMatch(/PRIVATE|password|example|token/);
  });

  it('does not represent a fresh zero-error container as a complete 24-hour history', async () => {
    const report = await inspector.apiReport(Readable.from(['LOG [HealthService] ready\n']));
    expect(report.scope).toBe('api_current_container_retained_logs_1h');
    expect(report.totalErrorLines).toBe(0);
  });

  it('ignores nested error text in DETAIL and STATEMENT', () => {
    expect(inspector.classifyPostgresLine('2026-10-09 DETAIL: ERROR: duplicate key value violates unique constraint')).toBeNull();
    expect(inspector.classifyPostgresLine("2026-10-09 STATEMENT: SELECT 'ERROR: password authentication failed'")).toBeNull();
    expect(inspector.classifyPostgresLine('ERROR: duplicate key value violates unique constraint "clients_broker_id_amo_lead_id_key"').constraint).toBe('clients_broker_id_amo_lead_id_key');
  });

  it('matches runtime token fallback after trimming', async () => {
    const mock = jest.fn().mockRejectedValue(new Error('network'));
    const report = await inspector.telegramReport({ ...env, OPS_TELEGRAM_BOT_TOKEN: ' ', TELEGRAM_BOT_TOKEN: token }, mock);
    expect(report.configured).toBe(true);
    expect(mock.mock.calls[0][0]).toContain(`/bot${token}/getMe`);
  });

  it('refuses an oversized log line instead of claiming complete coverage', async () => {
    await expect(inspector.postgresReport(Readable.from(['x'.repeat(65537)]))).rejects.toThrow('LINE_BOUND_EXCEEDED');
  });

  it('uses only GETs, deduplicates chat slots, and never emits their IDs/token/profile', async () => {
    const fetchMock = jest.fn(async (url: string, options: any) => {
      expect(options.method).toBe('GET'); expect(options.redirect).toBe('error');
      const data = url.includes('/getMe') ? { id: 77, username: 'PRIVATE_BOT' } : url.includes('/getChatMember') ? { status: 'administrator', user: { id: 77 } } : { id: -10001, title: 'PRIVATE_GROUP' };
      return new Response(JSON.stringify({ ok: true, result: data }), { status: 200 });
    });
    const report = await inspector.telegramReport(env, fetchMock);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(report.messagesSent).toBe(0);
    expect(report.chats).toHaveLength(2);
    expect(report.chats[1].membership).toBe('administrator');
    expect(JSON.stringify(report)).not.toMatch(/10001|10002|PRIVATE|fake_private_token/);
    expect(fetchMock.mock.calls.every(([url]) => !url.includes('sendMessage') && !url.includes('getUpdates'))).toBe(true);
  });

  it.each([[401, 'authentication_rejected'], [403, 'access_denied'], [400, 'request_rejected'], [429, 'rate_limited'], [502, 'upstream_unavailable']])('classifies status %s without response text', async (status, category) => {
    const result = await inspector.boundedGet('https://api.telegram.org', async () => new Response(JSON.stringify({ ok: false, error_code: status, description: 'PRIVATE_VALUE' }), { status }));
    expect(result.category).toBe(category);
    const report = await inspector.telegramReport(env, async () => new Response(JSON.stringify({ ok: false, error_code: status, description: 'PRIVATE_VALUE' }), { status }));
    expect(JSON.stringify(report)).not.toContain('PRIVATE_VALUE');
    expect(report.chats).toEqual([]);
  });

  it('has no retry/fallback on a lost GET or redirect', async () => {
    const fetchMock = jest.fn().mockRejectedValue(new Error(`https://host/bot${token}/PRIVATE`));
    expect((await inspector.telegramReport(env, fetchMock)).botCheck).toBe('network_failure');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses arbitrary relay URL or malformed config', async () => {
    expect(() => inspector.telegramBase({ TELEGRAM_API_BASE: 'https://evil.invalid' })).toThrow();
    await expect(inspector.telegramReport({ ...env, OPS_ALERT_CHAT_IDS: 'invalid', OPS_ALERT_CHAT_ID: '' })).rejects.toThrow();
    await expect(inspector.telegramReport({ ...env, OPS_TELEGRAM_BOT_TOKEN: 'bad' })).rejects.toThrow();
  });

  it('does not contact providers when Telegram is unconfigured', async () => {
    const fetchMock = jest.fn();
    expect(await inspector.telegramReport({}, fetchMock)).toEqual({ configured: false, messagesSent: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cancels feed bodies and reports status only, with no import or price data', async () => {
    const cancel = jest.fn().mockResolvedValue(undefined);
    const mock = jest.fn(async (_url, options) => {
      expect(options.method).toBe('GET'); expect(options.redirect).toBe('error');
      return { status: 500, ok: false, body: { cancel } };
    });
    const report = await inspector.feedReport({}, compiled, mock);
    expect(report).toEqual([{ project: 'ZORGE', httpStatus: 500, category: 'upstream_unavailable', hardenedScopeCompatible: false }, { project: 'SILVER', httpStatus: 500, category: 'upstream_unavailable', hardenedScopeCompatible: false }]);
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(report)).not.toContain('abc123');
  });

  it.each(['http://pb123.profitbase.ru/export/profitbase_xml/a', 'https://evil.invalid/export/profitbase_xml/a', 'https://pb123.profitbase.ru/private', 'https://user:pass@pb123.profitbase.ru/export/profitbase_xml/a'])('refuses feed outside fixed public-export scope %s', (url) => {
    expect(() => inspector.feedUrls({ PROFITBASE_FEED_ZORGE: url }, compiled)).toThrow();
  });

  it.each([
    ['/app/apps/api/dist/catalog/catalog.service.js', '/app/apps/api/dist/catalog/profitbase-feed.js'],
    ['/app/apps/api/dist/src/catalog/catalog.service.js', '/app/apps/api/dist/src/catalog/profitbase-feed.js'],
  ])('validates real feed shape through only the fixed pure sibling of %s', async (catalogPath, helperPath) => {
    const loadProfitbaseOffers = jest.fn().mockResolvedValueOnce([{ number: 'PRIVATE_LOT', price: 'PRIVATE_PRICE' }, {}]).mockResolvedValueOnce([{}]);
    const existsSync = jest.fn().mockReturnValue(true), loadModule = jest.fn().mockReturnValue({ loadProfitbaseOffers });
    const report = await inspector.validatedFeedReport({}, compiled, catalogPath, { existsSync, loadModule });
    expect(existsSync).toHaveBeenCalledWith(helperPath); expect(loadModule).toHaveBeenCalledTimes(1); expect(loadModule).toHaveBeenCalledWith(helperPath);
    expect(loadProfitbaseOffers.mock.calls.map(([url]) => new URL(url).hostname)).toEqual(['pb123.profitbase.ru', 'pb123.profitbase.ru']);
    expect(report).toEqual([{ project: 'ZORGE', validated: true, offerCount: 2 }, { project: 'SILVER', validated: true, offerCount: 1 }]);
    expect(JSON.stringify(report)).not.toMatch(/PRIVATE|abc123|def456|profitbase\.ru|https|price|number/);
  });

  it('explicitly reports not_available on old images without importing or invoking a fallback parser', async () => {
    const loadModule = jest.fn(), existsSync = jest.fn().mockReturnValue(false);
    const report = await inspector.validatedFeedReport({}, compiled, '/app/apps/api/dist/catalog/catalog.service.js', { existsSync, loadModule });
    expect(report).toEqual([{ project: 'ZORGE', validated: false, failureCode: 'not_available' }, { project: 'SILVER', validated: false, failureCode: 'not_available' }]);
    expect(loadModule).not.toHaveBeenCalled();
  });

  it.each(['FEED_XML_INVALID', 'FEED_OFFERS_INVALID', 'FEED_BODY_INCOMPLETE', 'FEED_HTTP_ERROR', 'FEED_URL_INVALID', 'FEED_TIMEOUT'])('keeps %s as a failed validation without provider/XML contents', async (code) => {
    const loadProfitbaseOffers = jest.fn().mockRejectedValue({ code, message: 'PRIVATE_URL_TOKEN_XML <realty-feed>secret@example.ru</realty-feed>', status: 500 });
    const report = await inspector.validatedFeedReport({}, compiled, '/app/apps/api/dist/catalog/catalog.service.js', { existsSync: () => true, loadModule: () => ({ loadProfitbaseOffers }) });
    expect(report).toEqual([{ project: 'ZORGE', validated: false, failureCode: code }, { project: 'SILVER', validated: false, failureCode: code }]);
    expect(loadProfitbaseOffers).toHaveBeenCalledTimes(2); // No diagnostic retry; the pure loader owns bounded GET retries.
    expect(JSON.stringify(report)).not.toMatch(/PRIVATE|secret|realty|status|500|abc123|def456/);
  });

  it('sanitizes unknown helper errors and continues the other independent project check', async () => {
    const loadProfitbaseOffers = jest.fn().mockRejectedValueOnce({ code: 'https://PRIVATE_URL', message: 'PRIVATE_XML' }).mockResolvedValueOnce([{}]);
    const report = await inspector.validatedFeedReport({}, compiled, '/app/apps/api/dist/catalog/catalog.service.js', { existsSync: () => true, loadModule: () => ({ loadProfitbaseOffers }) });
    expect(report).toEqual([{ project: 'ZORGE', validated: false, failureCode: 'FEED_UNKNOWN_FAILURE' }, { project: 'SILVER', validated: true, offerCount: 1 }]);
    expect(JSON.stringify(report)).not.toContain('PRIVATE');
  });

  it.each([['empty array', []], ['non-array', {}], ['oversized array', Array(50_001).fill({})]])('never claims validated for an invalid helper %s', async (_name, offers) => {
    const report = await inspector.validatedFeedReport({}, compiled, '/app/apps/api/dist/catalog/catalog.service.js', { existsSync: () => true, loadModule: () => ({ loadProfitbaseOffers: jest.fn().mockResolvedValue(offers) }) });
    expect(report.every((row: any) => row.validated === false && row.failureCode === 'FEED_RESULT_INVALID')).toBe(true);
  });

  it.each([
    ['valid XML', '<realty-feed><offer internal-id="1"><area><value>50</value></area><price><value>20000000</value></price></offer></realty-feed>', null],
    ['truncated XML', '<realty-feed><offer internal-id="1">', 'FEED_XML_INVALID'],
    ['schema-overflow XML', '<realty-feed><offer internal-id="1"><floor>2147483648</floor></offer></realty-feed>', 'FEED_OFFERS_INVALID'],
  ])('projects actual pure-helper %s without real network or application imports', async (_name, xml, failureCode) => {
    const helper = require('../catalog/profitbase-feed');
    const knownCompiled = compiled.replace(/pb123\.profitbase\.ru/g, 'pb7828.profitbase.ru').replace('abc123', 'a'.repeat(32)).replace('def456', 'b'.repeat(32));
    const fetchImpl = jest.fn(async (_url, options) => { expect(options.method).toBe('GET'); expect(options.redirect).toBe('error'); return new Response(xml); });
    const loadProfitbaseOffers = (url: string) => helper.loadProfitbaseOffers(url, { fetchImpl });
    const report = await inspector.validatedFeedReport({}, knownCompiled, '/app/apps/api/dist/catalog/catalog.service.js', { existsSync: () => true, loadModule: () => ({ loadProfitbaseOffers }) });
    expect(report).toEqual(['ZORGE', 'SILVER'].map((project) => failureCode ? { project, validated: false, failureCode } : { project, validated: true, offerCount: 1 }));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(report)).not.toMatch(/realty-feed|2147483648|20000000|https|profitbase\.ru/);
  });

  it('refuses arbitrary import paths and out-of-scope feed URLs before loading any module', async () => {
    const loadModule = jest.fn(), existsSync = jest.fn();
    await expect(inspector.validatedFeedReport({}, compiled, '/tmp/private-helper.js', { existsSync, loadModule })).rejects.toThrow('COMPILED_FEED_SCOPE_REFUSED');
    await expect(inspector.validatedFeedReport({ PROFITBASE_FEED_ZORGE: 'http://localhost/private' }, compiled, '/app/apps/api/dist/catalog/catalog.service.js', { existsSync, loadModule })).rejects.toThrow('FEED_SCOPE_REFUSED');
    expect(existsSync).not.toHaveBeenCalled(); expect(loadModule).not.toHaveBeenCalled();
  });

  it.each([() => { throw new Error('PRIVATE_IMPORT_FAILURE'); }, () => ({})])('does not bootstrap the app or expose a broken helper import', async (loadModule) => {
    const report = await inspector.validatedFeedReport({}, compiled, '/app/apps/api/dist/catalog/catalog.service.js', { existsSync: () => true, loadModule });
    expect(report.every((row: any) => row.validated === false && row.failureCode === 'FEED_VALIDATOR_LOAD_FAILED')).toBe(true);
    expect(JSON.stringify(report)).not.toContain('PRIVATE');
  });

  it('live report uses the fixed pure helper but never calls catalog sync or mutation methods', () => {
    const source = readFileSync(join(__dirname, '../../../../scripts/inspect-runtime-errors.js'), 'utf8');
    expect(source).toContain('validatedFeeds: await validatedFeedReport(environment, compiledText, compiledCatalogPath)');
    expect(source).toContain('helper.loadProfitbaseOffers(String(url))');
    expect(source).not.toMatch(/syncFromFeed\(|syncSingleFeed\(|sendMessage|\.\$executeRaw|\.lot\.(?:update|create|delete)/);
  });

  it('forces a scoped read-only PostgreSQL connection', () => {
    const url = new URL(inspector.readOnlyUrl('postgresql://private:secret@postgres/broker_platform'));
    expect(url.searchParams.get('options')).toContain('default_transaction_read_only=on');
    expect(() => inspector.readOnlyUrl('postgresql://localhost/other')).toThrow();
  });

  it('workflow preserves pinned source/runtime, physical lock and strict no-send staging', () => {
    const yaml = require('yaml');
    const text = readFileSync(join(__dirname, '../../../../.github/workflows/inspect-production-runtime-errors.yml'), 'utf8');
    const workflow = yaml.parse(text);
    expect(workflow.on.workflow_dispatch).toEqual({});
    const program = workflow.jobs.inspect.steps.find((step: any) => step.run)?.run;
    expect(program).toContain('StrictHostKeyChecking=yes');
    expect(program).toContain('lock_identity');
    expect(program).toContain("'600:0:0'");
    expect(program).toContain('node "$1" --postgres');
    expect(program).toContain('node "$1" --live');
    expect(program).not.toMatch(/sendMessage|getUpdates|deleteWebhook|NODE_TLS_REJECT_UNAUTHORIZED|git checkout/);
  });
});
