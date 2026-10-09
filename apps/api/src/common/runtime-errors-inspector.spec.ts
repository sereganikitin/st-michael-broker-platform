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
