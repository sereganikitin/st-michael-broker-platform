import * as crypto from 'crypto';

export interface CallStatus {
  id: string;
  status: string;
  duration?: number;
  recording_url?: string;
  start_time?: string;
  end_time?: string;
}

export interface CallbackRequest {
  // Кому Mango сначала наберёт (берёт трубку → дальше дозванивается до to_number).
  // Обычно — мобильный/добавочный брокера. Формат — голые цифры (74950123456).
  from: string;
  // Кому соединять. Формат — голые цифры.
  to: string;
  // Caller ID, который увидит to (обычно — общий офисный номер St Michael).
  // Если не задан — Mango берёт дефолтный исходящий по аккаунту.
  lineNumber?: string;
}

export interface IMangoAdapter {
  initiateCallback(req: CallbackRequest): Promise<{ callId: string }>;
  /** @deprecated stub-метод старого API. Используй initiateCallback. */
  initiateCall(from: string, to: string): Promise<{ callId: string }>;
  getCallRecording(callId: string): Promise<string>;
  getCallStatus(callId: string): Promise<CallStatus>;
}

// Mango VPBX API endpoint. Если ваш аккаунт — Контакт-центр, URL другой,
// поправь после уточнения у коллеги (та задача стоит на эту неделю).
const MANGO_VPBX_URL =
  process.env.MANGO_API_URL || 'https://app.mango-office.ru/vpbx';

/**
 * Mango VPBX integration — outbound callback.
 *
 * Doc: https://www.mango-office.ru/upload/api/vpbx_api.pdf
 * Endpoint: POST {MANGO_VPBX_URL}/commands/callback
 * Auth: HMAC-SHA256 от (vpbx_api_key + json_body + vpbx_api_salt).
 *
 * ENV:
 *   MANGO_API_KEY  — vpbx_api_key из ЛК Mango
 *   MANGO_API_SALT — vpbx_api_salt оттуда же
 *   MANGO_API_URL  — опционально, переопределить базовый URL
 *
 * Результат звонка прилетит в наш webhook /webhooks/mango/call-result,
 * где мы найдём запись Call по mangoCallId и обновим status/duration/recording.
 */
export class MangoAdapter implements IMangoAdapter {
  private get apiKey(): string {
    return process.env.MANGO_API_KEY || '';
  }
  private get apiSalt(): string {
    return process.env.MANGO_API_SALT || '';
  }

  private digits(phone: string): string {
    return String(phone || '').replace(/\D/g, '');
  }

  /**
   * Инициировать callback: Mango звонит сначала `from`, после поднятия трубки
   * дозванивается до `to` и соединяет. callId возвращается СРАЗУ (это наш
   * command_id), реальный mango_call_id придёт в webhook позже.
   */
  async initiateCallback(req: CallbackRequest): Promise<{ callId: string }> {
    if (!this.apiKey || !this.apiSalt) {
      throw new Error('MANGO_API_KEY / MANGO_API_SALT не настроены в .env');
    }
    const commandId = crypto.randomUUID();
    const fromDigits = this.digits(req.from);
    const toDigits = this.digits(req.to);
    if (fromDigits.length < 10 || toDigits.length < 10) {
      throw new Error(`Mango callback: некорректные номера (from=${req.from}, to=${req.to})`);
    }

    const json = JSON.stringify({
      command_id: commandId,
      from: { number: fromDigits },
      to_number: toDigits,
      ...(req.lineNumber ? { line_number: this.digits(req.lineNumber) } : {}),
    });
    const sign = crypto
      .createHash('sha256')
      .update(this.apiKey + json + this.apiSalt)
      .digest('hex');

    const params = new URLSearchParams({
      vpbx_api_key: this.apiKey,
      sign,
      json,
    });

    const res = await fetch(`${MANGO_VPBX_URL}/commands/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Mango callback ${res.status}: ${text.slice(0, 300)}`);
    }
    return { callId: commandId };
  }

  /** Совместимость со старым stub-API. */
  async initiateCall(from: string, to: string): Promise<{ callId: string }> {
    return this.initiateCallback({ from, to });
  }

  async getCallRecording(callId: string): Promise<string> {
    // VPBX API не отдаёт прямую ссылку — запись приходит в webhook
    // call-result (recording_url). Тут — для обратной совместимости.
    return `${MANGO_VPBX_URL}/queries/recording/${callId}`;
  }

  async getCallStatus(callId: string): Promise<CallStatus> {
    // Тоже асинхронно через webhook — это заглушка для интерфейса.
    return {
      id: callId,
      status: 'unknown',
    };
  }
}
