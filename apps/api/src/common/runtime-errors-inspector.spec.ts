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

  describe('bounded real-feed compatibility evidence', () => {
    const catalogPath = '/app/apps/api/dist/catalog/catalog.service.js', helperPath = '/app/apps/api/dist/catalog/profitbase-feed.js';
    const helper = (parseValidatedProfitbaseOffers = jest.fn().mockReturnValue([{}])) => ({ validateProfitbaseFeedUrl: jest.fn((url) => url), parseValidatedProfitbaseOffers });
    const deps = (loaded: any, fetchImpl: any) => ({ existsSync: () => true, loadModule: jest.fn(() => loaded), fetchImpl });
    afterEach(() => jest.useRealTimers());

    it('only reports bounded byte counts and successful counts from the fixed runtime pure parser', async () => {
      const loaded = helper(), xml = '<realty-feed>PRIVATE_XML</realty-feed>';
      const fetchImpl = jest.fn(async (_url, options) => { expect(options.method).toBe('GET'); expect(options.redirect).toBe('error'); expect(options.signal).toBeInstanceOf(AbortSignal); return new Response(xml, { headers: { 'content-length': String(Buffer.byteLength(xml)) } }); });
      const dependencies = deps(loaded, fetchImpl);
      const result = await inspector.feedCompatibilityReport({}, compiled, catalogPath, dependencies);
      expect(result).toEqual(['ZORGE', 'SILVER'].map((project) => ({ project, decodedBytes: Buffer.byteLength(xml), declaredBytes: Buffer.byteLength(xml), xmlFieldsValidated: true, offerCount: 1 })));
      expect(dependencies.loadModule).toHaveBeenCalledWith(helperPath);
      expect(loaded.parseValidatedProfitbaseOffers).toHaveBeenCalledTimes(2); expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE|abc123|def456|https|profitbase\.ru/);
    });

    it('projects only a numeric gate from the exact deployed parser frame, not raw XML/error/URLs', async () => {
      const error = { code: 'FEED_OFFERS_INVALID', message: 'PRIVATE_NAME_PRICE_PHONE_URL', stack: 'PRIVATE_NAME\n    at reject (' + helperPath + ':30:11)\n    at Object.parseValidatedProfitbaseOffers (' + helperPath + ':142:17)\n    at SECRET_PATH' };
      const loaded = helper(jest.fn(() => { throw error; }));
      const result = await inspector.feedCompatibilityReport({}, compiled, catalogPath, deps(loaded, jest.fn(async () => new Response('<realty-feed>PRIVATE</realty-feed>'))));
      expect(result.every((row: any) => row.failureCode === 'FEED_OFFERS_INVALID' && row.compiledGateLine === 142 && row.xmlFieldsValidated === false)).toBe(true);
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE|SECRET|PHONE|URL|realty|\/app|abc123/);
    });

    it('projects numeric value/container reasons only for exact emitted gate105', async () => {
      const xml = '<realty-feed><offer internal-id="PRIVATE_ID"><number>PRIVATE_NUMBER</number><price><value/></price><area/></offer></realty-feed>';
      const parse = jest.fn(() => { throw { code: 'FEED_OFFERS_INVALID', message: 'PRIVATE', stack: 'at Object.parseValidatedProfitbaseOffers (' + helperPath + ':105:17)' }; });
      const results = await inspector.feedCompatibilityReport({}, compiled, catalogPath, deps(helper(parse), jest.fn(async () => new Response(xml))));
      expect(results.every((row: any) => JSON.stringify(row.numericFieldShapes) === JSON.stringify({ area: { empty_container: 1 }, price: { empty_value: 1 } }))).toBe(true);
      expect(JSON.stringify(results)).not.toMatch(/PRIVATE|value><|internal-id|NUMBER|https|profitbase\.ru/);
    });

    it.each([
      ['empty_container', '<price/>'],
      ['empty_value', '<price><value/></price>'],
      ['missing_value', '<price><currency>PRIVATE</currency></price>'],
      ['nonnumeric_value', '<price><value>NaN</value></price>'],
      ['negative_value', '<price><value>-1</value></price>'],
      ['non_scalar_value', '<price><value><nested>PRIVATE</nested></value></price>'],
      ['container_type', '<price>PRIVATE</price>'],
    ])('classifies %s without emitting the numeric/raw value', (reason, extra) => {
      const report = inspector.numericFieldShapes('<realty-feed><offer internal-id="PRIVATE_ID">' + extra + '</offer><offer internal-id="ANOTHER_PRIVATE_ID">' + extra + '</offer></realty-feed>');
      expect(report).toEqual({ price: { [reason]: 2 } });
      expect(JSON.stringify(report)).not.toMatch(/PRIVATE|NaN|-1|nested|currency|internal/);
    });

    it.each(['<realty-feed>', '<!DOCTYPE realty-feed><realty-feed><offer/></realty-feed>', '<realty-feed/>'])('does not reparse unbounded/untrusted shape input', (xml) => {
      expect(inspector.numericFieldShapes(xml)).toBeNull();
    });

    it('does not attach field shapes for any other validation gate', async () => {
      const parse = jest.fn(() => { throw { code: 'FEED_OFFERS_INVALID', stack: 'at Object.parseValidatedProfitbaseOffers (' + helperPath + ':142:17)' }; });
      const results = await inspector.feedCompatibilityReport({}, compiled, catalogPath, deps(helper(parse), jest.fn(async () => new Response('<realty-feed><offer internal-id="1"><price/></offer></realty-feed>'))));
      expect(results.every((row: any) => row.numericFieldShapes === undefined)).toBe(true);
    });

    it.each([
      'at Object.parseValidatedProfitbaseOffers (/tmp/evil.js:142:1)',
      'at reject (' + helperPath + ':30:1)',
      'at parseValidatedProfitbaseOffers (/app/apps/api/dist/src/catalog/profitbase-feed.js:142:1)',
      'at parseValidatedProfitbaseOffers (' + helperPath + ':999999999999:1)',
    ])('ignores a non-source-bound parser frame', (stack) => {
      expect(inspector.compiledValidationGate({ stack }, helperPath)).toBeNull();
    });

    it('does not call network or import a parser when the old runtime lacks the helper', async () => {
      const fetchImpl = jest.fn(), loadModule = jest.fn();
      expect(await inspector.feedCompatibilityReport({}, compiled, catalogPath, { existsSync: () => false, loadModule, fetchImpl })).toEqual(['ZORGE', 'SILVER'].map((project) => ({ project, failureCode: 'not_available' })));
      expect(fetchImpl).not.toHaveBeenCalled(); expect(loadModule).not.toHaveBeenCalled();
    });

    it('preserves strict URL/TLS rejection before any diagnostic GET', async () => {
      const fetchImpl = jest.fn(), loaded = helper();
      loaded.validateProfitbaseFeedUrl.mockImplementation(() => { throw { code: 'FEED_URL_INVALID', message: 'PRIVATE_URL' }; });
      const invalid = await inspector.feedCompatibilityReport({}, compiled, catalogPath, deps(loaded, fetchImpl));
      expect(invalid.every((row: any) => row.failureCode === 'FEED_URL_INVALID')).toBe(true);
      const tls = await inspector.feedCompatibilityReport({ NODE_TLS_REJECT_UNAUTHORIZED: '0' }, compiled, catalogPath, deps(helper(), fetchImpl));
      expect(tls.every((row: any) => row.failureCode === 'FEED_TLS_CONFIGURATION_INVALID')).toBe(true);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('refuses disabled TLS in the actual runtime environment even with a supplied clean environment', async () => {
      const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED, fetchImpl = jest.fn();
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
      try {
        const result = await inspector.feedCompatibilityReport({}, compiled, catalogPath, deps(helper(), fetchImpl));
        expect(result.every((row: any) => row.failureCode === 'FEED_TLS_CONFIGURATION_INVALID')).toBe(true);
        expect(fetchImpl).not.toHaveBeenCalled();
      } finally { if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous; }
    });

    it('fails closed on a declared response over64MiB before body read/parser', async () => {
      const loaded = helper(), read = jest.fn(), cancel = jest.fn(async () => {});
      const fetchImpl = jest.fn(async () => ({ status: 200, headers: { get: (key) => key === 'content-length' ? String(64 * 1024 * 1024 + 1) : null }, body: { getReader: () => ({ read, cancel }), cancel } }));
      const result = await inspector.feedCompatibilityReport({}, compiled, catalogPath, deps(loaded, fetchImpl));
      expect(result.every((row: any) => row.failureCode === 'DIAGNOSTIC_BODY_TOO_LARGE' && row.decodedBytes === 0)).toBe(true);
      expect(read).not.toHaveBeenCalled(); expect(loaded.parseValidatedProfitbaseOffers).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalledTimes(2);
    });

    it('fails closed on streamed/decompressed bytes over64MiB before parser', async () => {
      const loaded = helper(), bytes = Buffer.alloc(64 * 1024 * 1024 + 1), cancel = jest.fn(async () => {});
      const fetchImpl = jest.fn(async () => ({ status: 200, headers: { get: () => null }, body: { getReader: () => ({ read: async () => ({ done: false, value: bytes }), cancel, releaseLock: jest.fn() }) } }));
      const result = await inspector.feedCompatibilityReport({}, compiled, catalogPath, deps(loaded, fetchImpl));
      expect(result.every((row: any) => row.failureCode === 'DIAGNOSTIC_BODY_TOO_LARGE' && row.decodedBytes === bytes.byteLength)).toBe(true);
      expect(loaded.parseValidatedProfitbaseOffers).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalledTimes(2);
    });

    it('enforces30s over each request even when fetch ignores AbortSignal, without retry', async () => {
      jest.useFakeTimers(); const signals: AbortSignal[] = [];
      const fetchImpl = jest.fn(async (_url, options) => { signals.push(options.signal); return await new Promise(() => {}); });
      const pending = inspector.feedCompatibilityReport({}, compiled, catalogPath, deps(helper(), fetchImpl));
      await jest.advanceTimersByTimeAsync(60_000); const result = await pending;
      expect(result.every((row: any) => row.failureCode === 'FEED_TIMEOUT')).toBe(true);
      expect(fetchImpl).toHaveBeenCalledTimes(2); expect(signals.every((signal) => signal.aborted)).toBe(true);
    });

    it('enforces30s across a stalled stream without retry and cancels readers', async () => {
      jest.useFakeTimers(); const cancel = jest.fn(async () => {}), read = jest.fn(async () => await new Promise(() => {}));
      const fetchImpl = jest.fn(async () => ({ status: 200, headers: { get: () => null }, body: { getReader: () => ({ read, cancel, releaseLock: jest.fn() }) } }));
      const pending = inspector.feedCompatibilityReport({}, compiled, catalogPath, deps(helper(), fetchImpl));
      await jest.advanceTimersByTimeAsync(60_000); const result = await pending;
      expect(result.every((row: any) => row.failureCode === 'FEED_TIMEOUT')).toBe(true);
      expect(fetchImpl).toHaveBeenCalledTimes(2); expect(cancel).toHaveBeenCalledTimes(2);
    });

    it('retains complete-body and strict UTF8 checks without exposing raw bytes', async () => {
      for (const response of [new Response('PRIVATE', { headers: { 'content-length': '100' } }), new Response(Buffer.from([0xff]))]) {
        const loaded = helper(); const results = await inspector.feedCompatibilityReport({}, compiled, catalogPath, deps(loaded, jest.fn(async () => response.clone())));
        expect(results.every((row: any) => ['FEED_BODY_INCOMPLETE', 'FEED_BODY_INVALID'].includes(row.failureCode))).toBe(true);
        expect(loaded.parseValidatedProfitbaseOffers).not.toHaveBeenCalled(); expect(JSON.stringify(results)).not.toContain('PRIVATE');
      }
    });
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
    expect(workflow.jobs.inspect['timeout-minutes']).toBe(12);
    expect(workflow.on.workflow_dispatch).toEqual({});
    const program = workflow.jobs.inspect.steps.find((step: any) => step.run)?.run;
    expect(program).toContain('StrictHostKeyChecking=yes');
    expect(program).toContain('lock_identity');
    expect(program).toContain("'600:0:0'");
    expect(program).toContain('node "$1" --postgres');
    expect(program).toContain('node "$1" --live');
    expect(program).toContain('timeout --foreground 10m ssh');
    expect(program).not.toMatch(/sendMessage|getUpdates|deleteWebhook|NODE_TLS_REJECT_UNAUTHORIZED|git checkout/);
  });
});
