import {
  OpsAlertService,
  opsAlertCategoryLabel,
  opsAlertScenarioLabel,
  opsAlertTime,
} from './ops-alert.service';

describe('русские подписи технических уведомлений', () => {
  it('не показывает внутренние коды причин и операций', () => {
    expect(opsAlertCategoryLabel('AMO_AUTH_ERROR')).toBe('ошибка авторизации в amoCRM');
    expect(opsAlertCategoryLabel('UNKNOWN_CODE')).toBe('неизвестная техническая ошибка');
    expect(opsAlertScenarioLabel('REFIX_AFTER_CLOSED')).toBe('повторная фиксация после закрытой заявки');
  });

  it('показывает время по Москве', () => {
    const result = opsAlertTime(new Date('2026-09-02T08:34:56.000Z'));
    expect(result).toContain('02.09.2026');
    expect(result).toContain('11:34:56');
    expect(result).toContain('МСК');
  });
});

describe('OpsAlertService', () => {
  let fetchMock: jest.SpyInstance;
  let originalTelegramBase: string | undefined;

  function createService(values: Record<string, string | undefined>) {
    const config = {
      get: jest.fn((key: string) => values[key]),
    };
    return new OpsAlertService(config as any);
  }

  const telegramResponse = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
  const telegramSuccess = () => telegramResponse({ ok: true });

  beforeEach(() => {
    originalTelegramBase = process.env.TELEGRAM_API_BASE;
    delete process.env.TELEGRAM_API_BASE;
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    if (originalTelegramBase === undefined) delete process.env.TELEGRAM_API_BASE;
    else process.env.TELEGRAM_API_BASE = originalTelegramBase;
  });

  it('sends plain text to every unique configured chat', async () => {
    fetchMock.mockImplementation(async () => telegramSuccess());
    const service = createService({
      OPS_TELEGRAM_BOT_TOKEN: 'ops-token',
      TELEGRAM_BOT_TOKEN: 'fallback-token',
      OPS_ALERT_CHAT_IDS: '-1001, -1002',
      OPS_ALERT_CHAT_ID: '-1002; -1003',
    });

    await expect(service.send('Service is unavailable')).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.telegram.org/botops-token/sendMessage',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          chat_id: '-1001',
          text: 'Service is unavailable',
        }),
        signal: expect.any(AbortSignal),
        redirect: 'error',
      }),
    );
    for (const [, init] of fetchMock.mock.calls) {
      expect(JSON.parse(init.body)).not.toHaveProperty('parse_mode');
    }
  });

  it('uses TELEGRAM_BOT_TOKEN as a fallback', async () => {
    fetchMock.mockResolvedValue(telegramSuccess());
    const service = createService({
      TELEGRAM_BOT_TOKEN: 'fallback-token',
      OPS_ALERT_CHAT_ID: '42',
    });

    await service.send('Alert');

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.telegram.org/botfallback-token/sendMessage');
  });

  it('skips a duplicate key during its cooldown', async () => {
    fetchMock.mockResolvedValue(telegramSuccess());
    const service = createService({
      OPS_TELEGRAM_BOT_TOKEN: 'token',
      OPS_ALERT_CHAT_ID: '42',
    });

    await expect(service.send('First', { dedupKey: 'service-down', cooldownMs: 60_000 })).resolves.toBe(true);
    await expect(service.send('Second', { dedupKey: 'service-down', cooldownMs: 60_000 })).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not consume the dedup cooldown when delivery fails', async () => {
    fetchMock
      .mockResolvedValueOnce(telegramResponse({ ok: false, error_code: 400 }, 400))
      .mockResolvedValueOnce(telegramSuccess());
    const service = createService({
      OPS_TELEGRAM_BOT_TOKEN: 'token',
      OPS_ALERT_CHAT_ID: '42',
    });
    const options = { dedupKey: 'service-down', cooldownMs: 60_000 };

    await expect(service.send('First', options)).rejects.toThrow('Telegram delivery failed');
    await expect(service.send('Retry', options)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the dedup cooldown after partial multi-chat delivery', async () => {
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      const { chat_id: chatId } = JSON.parse(String(init.body));
      if (chatId === '-1002') {
        return telegramResponse({ ok: false, error_code: 400 }, 400);
      }
      return telegramSuccess();
    });
    const service = createService({
      OPS_TELEGRAM_BOT_TOKEN: 'token',
      OPS_ALERT_CHAT_IDS: '-1001,-1002',
    });
    const options = { dedupKey: 'service-down', cooldownMs: 60_000 };

    await expect(service.send('First', options)).rejects.toThrow(
      'Telegram delivery failed for 1 of 2 configured ops chats',
    );
    await expect(service.send('Duplicate', options)).resolves.toBe(false);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects unsuccessful HTTP and Telegram API responses', async () => {
    const service = createService({
      OPS_TELEGRAM_BOT_TOKEN: 'token',
      OPS_ALERT_CHAT_ID: '42',
    });

    fetchMock.mockResolvedValueOnce(telegramResponse({ ok: false }, 502));
    await expect(service.send('HTTP failure')).rejects.toThrow('Telegram delivery failed');

    fetchMock.mockResolvedValueOnce(telegramResponse({ ok: false }, 200));
    await expect(service.send('API failure')).rejects.toThrow('Telegram delivery failed');
  });

  it('returns false without sending when configuration is incomplete', async () => {
    const service = createService({});

    await expect(service.send('Alert')).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('aborts a request after the configured timeout', async () => {
    jest.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    fetchMock.mockImplementation(
      async (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          requestSignal = init.signal as AbortSignal;
          requestSignal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const service = createService({
      OPS_TELEGRAM_BOT_TOKEN: 'token',
      OPS_ALERT_CHAT_ID: '42',
      OPS_TELEGRAM_TIMEOUT_MS: '25',
    });

    const delivery = service.send('Alert');
    const expectation = expect(delivery).rejects.toThrow('Telegram delivery failed');
    await jest.advanceTimersByTimeAsync(25);

    await expectation;
    expect(requestSignal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('honors the existing relay setting without a direct-network fallback', async () => {
    process.env.TELEGRAM_API_BASE = 'http://172.18.0.1:8081/';
    fetchMock.mockRejectedValue(new Error('private native error'));
    const service = createService({ OPS_TELEGRAM_BOT_TOKEN: 'private-token', OPS_ALERT_CHAT_ID: 'private-chat' });
    await expect(service.send('private message')).rejects.toThrow('class=NETWORK_UNKNOWN outcome=unknown');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('http://172.18.0.1:8081/botprivate-token/sendMessage');
    expect(fetchMock.mock.calls[0][1].redirect).toBe('error');
  });

  it.each([
    [403, { ok: false, error_code: 403, description: 'private-token/private-chat/private message' }, 'CHAT_FORBIDDEN'],
    [401, { ok: false, error_code: 401, description: 'private-token' }, 'AUTH_REJECTED'],
    [400, { ok: false, error_code: 400, description: 'Bad Request: chat not found private-chat' }, 'CHAT_NOT_FOUND'],
    [400, { ok: false, error_code: 400, parameters: { migrate_to_chat_id: -100987654321 } }, 'CHAT_MIGRATED'],
    [400, { ok: false, error_code: 400, description: 'Bad Request: message is too long private message' }, 'MESSAGE_TOO_LONG'],
    [400, { ok: false, error_code: 400, description: 'private details' }, 'BAD_REQUEST'],
  ])('projects a safe per-chat rejection class for HTTP %s/%s', async (status, payload, category) => {
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => JSON.parse(String(init.body)).chat_id === 'private-chat'
      ? telegramResponse(payload, Number(status)) : telegramSuccess());
    const service = createService({ OPS_TELEGRAM_BOT_TOKEN: 'private-token', OPS_ALERT_CHAT_IDS: 'delivered-chat,private-chat' });
    const logger = jest.spyOn((service as any).logger, 'error').mockImplementation(() => {});
    await expect(service.sendSafely('private message', { dedupKey: 'same-alert' })).resolves.toBe(false);
    const diagnostic = String(logger.mock.calls[0][0]);
    expect(diagnostic).toContain('failed for 1 of 2 configured ops chats');
    expect(diagnostic).toContain(`chat_slot=2 class=${category} outcome=rejected http_status=${status} telegram_code=${status}`);
    expect(diagnostic).not.toMatch(/private-token|private-chat|private message|delivered-chat|-100987654321/);
    await expect(service.send('same event', { dedupKey: 'same-alert' })).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    [502, { ok: false, description: 'relay: private upstream error' }],
    [500, { ok: false, error_code: 500 }],
    [200, { ok: false }],
    [403, { ok: true }],
    [403, { ok: false, error_code: 400 }],
  ])('never releases a reservation for an ambiguous HTTP/API response %s/%s', async (status, payload) => {
    fetchMock.mockImplementation(async () => telegramResponse(payload, Number(status)));
    const service = createService({ OPS_TELEGRAM_BOT_TOKEN: 'token', OPS_ALERT_CHAT_ID: '42' });
    const options = { dedupKey: 'same-event', cooldownMs: 60_000 };
    await expect(service.send('First', options)).rejects.toThrow('class=HTTP_UNKNOWN outcome=unknown');
    await expect(service.send('Potential duplicate', options)).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['ENETUNREACH', 'ECONNRESET', 'ETIMEDOUT'])('safely classifies %s without retrying an unknown POST', async (networkCode) => {
    fetchMock.mockRejectedValue(Object.assign(new Error('private-token/private-chat/private message'), { cause: { code: networkCode, message: 'private cause' } }));
    const service = createService({ OPS_TELEGRAM_BOT_TOKEN: 'private-token', OPS_ALERT_CHAT_ID: 'private-chat' });
    const options = { dedupKey: 'unknown-event' };
    const delivery = service.send('private message', options);
    await expect(delivery).rejects.toThrow(`class=NETWORK_UNKNOWN outcome=unknown network_code=${networkCode}`);
    await expect(delivery).rejects.not.toThrow(/private-token|private-chat|private message|private cause/);
    await expect(service.send('same event', options)).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never exposes an arbitrary native error code or error thrown before fan-out', async () => {
    const service = createService({ OPS_TELEGRAM_BOT_TOKEN: 'private-token', OPS_ALERT_CHAT_ID: 'private-chat' });
    const logger = jest.spyOn((service as any).logger, 'error').mockImplementation(() => {});
    fetchMock.mockRejectedValue({ cause: { code: 'private-error-code' }, message: 'private message' });
    await service.sendSafely('private message');
    expect(String(logger.mock.calls[0][0])).toContain('class=NETWORK_UNKNOWN');
    expect(String(logger.mock.calls[0][0])).not.toMatch(/private-/);
    jest.spyOn(service, 'send').mockRejectedValue(new Error('private-token/private-chat/private message'));
    await service.sendSafely('private message');
    expect(String(logger.mock.calls[1][0])).toContain('Unclassified Telegram delivery failure');
    expect(String(logger.mock.calls[1][0])).not.toMatch(/private-/);
  });

  it.each(['not JSON private-token', '[]', 'null', '"private message"'])('bounds and rejects malformed response bodies', async (body) => {
    fetchMock.mockImplementation(async () => new Response(body, { status: 200 }));
    const service = createService({ OPS_TELEGRAM_BOT_TOKEN: 'token', OPS_ALERT_CHAT_ID: '42' });
    const options = { dedupKey: 'bad-body' };
    await expect(service.send('Alert', options)).rejects.toThrow('class=INVALID_RESPONSE_UNKNOWN outcome=unknown');
    await expect(service.send('Duplicate', options)).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('aborts oversized bodies before parsing and never retries the POST', async () => {
    fetchMock.mockImplementation(async () => new Response(' '.repeat(64 * 1024 + 1), { status: 200 }));
    const service = createService({ OPS_TELEGRAM_BOT_TOKEN: 'token', OPS_ALERT_CHAT_ID: '42' });
    await expect(service.send('Alert', { dedupKey: 'oversized' })).rejects.toThrow('class=INVALID_RESPONSE_UNKNOWN');
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    await expect(service.send('Duplicate', { dedupKey: 'oversized' })).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('the deadline includes reading a response body, not just HTTP headers', async () => {
    jest.useFakeTimers();
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => new Response(new ReadableStream({
      start(controller) { init.signal!.addEventListener('abort', () => controller.error(new Error('private stalled body'))); },
    }), { status: 200 }));
    const service = createService({ OPS_TELEGRAM_BOT_TOKEN: 'token', OPS_ALERT_CHAT_ID: '42', OPS_TELEGRAM_TIMEOUT_MS: '25' });
    const options = { dedupKey: 'stalled-body' };
    const delivery = service.send('Alert', options);
    const failed = expect(delivery).rejects.toThrow('class=TIMEOUT_UNKNOWN outcome=unknown');
    await jest.advanceTimersByTimeAsync(25);
    await failed;
    await expect(service.send('Duplicate', options)).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retains dedup on rate-limit and respects retry_after per chat for other alert keys', async () => {
    jest.useFakeTimers();
    fetchMock.mockResolvedValueOnce(telegramResponse({ ok: false, error_code: 429, parameters: { retry_after: 30 } }, 429));
    const service = createService({ OPS_TELEGRAM_BOT_TOKEN: 'token', OPS_ALERT_CHAT_ID: '42' });
    await expect(service.send('Alert', { dedupKey: 'first', cooldownMs: 1 })).rejects.toThrow('retry_after_s=30');
    await expect(service.send('Duplicate', { dedupKey: 'first', cooldownMs: 1 })).resolves.toBe(false);
    await jest.advanceTimersByTimeAsync(5_000);
    await expect(service.send('Other event', { dedupKey: 'second' })).rejects.toThrow('retry_after_s=25');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(25_000);
    fetchMock.mockResolvedValueOnce(telegramSuccess());
    await expect(service.send('New event', { dedupKey: 'third' })).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(['private seconds', -1, 0, 86_401, Number.MAX_SAFE_INTEGER])('does not log an unbounded retry_after %s', async (retryAfter) => {
    fetchMock.mockResolvedValueOnce(telegramResponse({ ok: false, error_code: 429, parameters: { retry_after: retryAfter } }, 429));
    const service = createService({ OPS_TELEGRAM_BOT_TOKEN: 'token', OPS_ALERT_CHAT_ID: '42' });
    const delivery = service.send('Alert');
    await expect(delivery).rejects.toThrow('class=RATE_LIMITED');
    await expect(delivery).rejects.not.toThrow('retry_after_s=');
    await expect(service.send('Another distinct event')).rejects.toThrow('class=RATE_LIMITED');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
