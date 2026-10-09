import { Injectable, Logger } from '@nestjs/common';
import { telegramApiBase } from '../common/telegram-api-base';
import { ConfigService } from '@nestjs/config';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_DEDUP_COOLDOWN_MS = 5 * 60_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

type TelegramFailureClass =
  | 'TIMEOUT_UNKNOWN' | 'NETWORK_UNKNOWN' | 'HTTP_UNKNOWN' | 'INVALID_RESPONSE_UNKNOWN'
  | 'AUTH_REJECTED' | 'CHAT_FORBIDDEN' | 'CHAT_NOT_FOUND' | 'CHAT_MIGRATED'
  | 'MESSAGE_TOO_LONG' | 'BAD_REQUEST' | 'RATE_LIMITED' | 'API_REJECTED';

interface TelegramFailure {
  category: TelegramFailureClass;
  outcome: 'rejected' | 'unknown';
  httpStatus?: number;
  telegramCode?: number;
  retryAfterSeconds?: number;
  networkCode?: string;
}

const SAFE_NETWORK_CODES = new Set([
  'ENETUNREACH', 'EHOSTUNREACH', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET',
  'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
  'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

class TelegramChatFailure extends Error {
  constructor(readonly details: TelegramFailure) {
    super('Telegram chat delivery was not confirmed');
  }
}

class TelegramDeliveryFailure extends Error {}

function boundedInteger(value: unknown, minimum: number, maximum: number): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value : undefined;
}

function safeFailureSummary(details: TelegramFailure, ordinal: number): string {
  return [
    `chat_slot=${ordinal}`, `class=${details.category}`, `outcome=${details.outcome}`,
    details.httpStatus === undefined ? '' : `http_status=${details.httpStatus}`,
    details.telegramCode === undefined ? '' : `telegram_code=${details.telegramCode}`,
    details.retryAfterSeconds === undefined ? '' : `retry_after_s=${details.retryAfterSeconds}`,
    details.networkCode === undefined ? '' : `network_code=${details.networkCode}`,
  ].filter(Boolean).join(' ');
}

const ALERT_CATEGORY_LABELS: Record<string, string> = {
  AMO_AUTH_ERROR: 'ошибка авторизации в amoCRM',
  AMO_RATE_LIMIT: 'amoCRM временно ограничила количество запросов',
  AMO_UNAVAILABLE: 'amoCRM временно недоступна',
  AMO_TIMEOUT: 'amoCRM не ответила вовремя',
  AMO_INVALID_RESPONSE: 'amoCRM вернула некорректный ответ',
  AMO_SYNC_ERROR: 'ошибка передачи данных в amoCRM',
  DATABASE_ERROR: 'ошибка базы данных кабинета',
  TIMEOUT: 'операция не завершилась вовремя',
  DEPENDENCY_UNAVAILABLE: 'внешний сервис временно недоступен',
  FIXATION_GUARD_BLOCKED: 'защита от двойной отправки остановила заявку',
  UNEXPECTED_ERROR: 'непредвиденная техническая ошибка',
};

const FIXATION_SCENARIO_LABELS: Record<string, string> = {
  NEW_CLIENT: 'новая фиксация',
  REFIX_AFTER_CLOSED: 'повторная фиксация после закрытой заявки',
  REFIX_AMO_DOWN: 'повторная фиксация после сбоя amoCRM',
};

export function opsAlertCategoryLabel(value: unknown): string {
  return ALERT_CATEGORY_LABELS[String(value || '')] || 'неизвестная техническая ошибка';
}

export function opsAlertScenarioLabel(value: unknown): string {
  return FIXATION_SCENARIO_LABELS[String(value || '')] || 'операция фиксации';
}

export function opsAlertTime(date = new Date()): string {
  return `${new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(date)} МСК`;
}

export interface OpsAlertOptions {
  /** Repeated alerts with the same key are suppressed during the cooldown. */
  dedupKey?: string;
  /** Set to 0 to disable cooldown for this call. */
  cooldownMs?: number;
}

@Injectable()
export class OpsAlertService {
  private readonly logger = new Logger(OpsAlertService.name);
  private readonly dedupExpirations = new Map<string, number>();
  private readonly chatRateLimitedUntil = new Map<string, number>();

  constructor(private readonly config: ConfigService) {}

  /**
   * Sends a plain-text operations alert to every configured chat.
   * Returns false when delivery is skipped because configuration is missing or
   * an equivalent alert is still in its cooldown window.
   */
  async send(message: string, options: OpsAlertOptions = {}): Promise<boolean> {
    const token = this.getBotToken();
    const chatIds = this.getChatIds();

    if (!token || chatIds.length === 0) {
      this.logger.warn(
        '[OpsAlert] Telegram is not configured; set OPS_TELEGRAM_BOT_TOKEN (or TELEGRAM_BOT_TOKEN) and OPS_ALERT_CHAT_ID(S)',
      );
      return false;
    }

    const text = String(message ?? '').trim();
    if (!text) {
      this.logger.warn('[OpsAlert] Empty alert was not sent');
      return false;
    }

    const dedupKey = options.dedupKey?.trim();
    const cooldownMs = this.resolveCooldownMs(options.cooldownMs);
    const now = Date.now();
    let reservedUntil: number | undefined;

    if (dedupKey && cooldownMs > 0) {
      const currentExpiration = this.dedupExpirations.get(dedupKey);
      if (currentExpiration && currentExpiration > now) return false;

      reservedUntil = now + cooldownMs;
      this.dedupExpirations.set(dedupKey, reservedUntil);
      this.removeExpiredDedupEntries(now);
    }

    const results = await Promise.allSettled(chatIds.map((chatId) => this.sendToChat(token, chatId, text)));
    const failedCount = results.filter((result) => result.status === 'rejected').length;

    if (failedCount > 0) {
      const successCount = results.length - failedCount;

      const failures = results.flatMap((result, index) => result.status === 'rejected'
        ? [{ ordinal: index + 1, details: result.reason instanceof TelegramChatFailure
          ? result.reason.details : { category: 'INVALID_RESPONSE_UNKNOWN', outcome: 'unknown' } as TelegramFailure }]
        : []);

      // A timeout/relay 502/body failure does not prove the POST was rejected:
      // Telegram might already have accepted it. Never free that reservation
      // for an immediate repeat fan-out. Partial success is likewise retained.
      if (
        successCount === 0 &&
        failures.every(({ details }) => details.outcome === 'rejected' && details.category !== 'RATE_LIMITED') &&
        dedupKey &&
        reservedUntil !== undefined &&
        this.dedupExpirations.get(dedupKey) === reservedUntil
      ) {
        this.dedupExpirations.delete(dedupKey);
      }

      throw new TelegramDeliveryFailure(
        `Telegram delivery failed for ${failedCount} of ${chatIds.length} configured ops chats; ` +
        failures.map(({ ordinal, details }) => safeFailureSummary(details, ordinal)).join('; '),
      );
    }

    return true;
  }

  async sendAlert(message: string, options: OpsAlertOptions = {}): Promise<boolean> {
    return this.send(message, options);
  }

  /** Best-effort variant for error paths where alerting must not mask the original failure. */
  async sendSafely(message: string, options: OpsAlertOptions = {}): Promise<boolean> {
    try {
      return await this.send(message, options);
    } catch (error) {
      this.logger.error(`[OpsAlert] Failed to deliver alert: ${this.safeErrorMessage(error)}`);
      return false;
    }
  }

  private async sendToChat(token: string, chatId: string, text: string): Promise<void> {
    const rateLimitKey = `${token}:${chatId}`; // Private memory only; never projected into errors/logs.
    const rateLimitedUntil = this.chatRateLimitedUntil.get(rateLimitKey) || 0;
    if (rateLimitedUntil > Date.now()) {
      throw new TelegramChatFailure({ category: 'RATE_LIMITED', outcome: 'rejected', telegramCode: 429,
        retryAfterSeconds: Math.min(86_400, Math.ceil((rateLimitedUntil - Date.now()) / 1000)) });
    }
    this.chatRateLimitedUntil.delete(rateLimitKey);
    const controller = new AbortController();
    const timeoutMs = this.resolveTimeoutMs();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      let response: Response;
      try {
        response = await fetch(`${telegramApiBase()}/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text }),
          signal: controller.signal,
          redirect: 'error',
        });
      } catch (error) {
        const code = (error as { cause?: { code?: unknown }; code?: unknown })?.cause?.code ||
          (error as { code?: unknown })?.code;
        throw new TelegramChatFailure({
          category: controller.signal.aborted ? 'TIMEOUT_UNKNOWN' : 'NETWORK_UNKNOWN',
          outcome: 'unknown',
          networkCode: typeof code === 'string' && SAFE_NETWORK_CODES.has(code) ? code : undefined,
        });
      }

      const httpStatus = boundedInteger(response.status, 100, 599);
      let payload: Record<string, unknown>;
      try {
        payload = await this.readResponse(response, controller);
      } catch (error) {
        if (error instanceof TelegramChatFailure) throw error;
        throw new TelegramChatFailure({
          category: controller.signal.aborted ? 'TIMEOUT_UNKNOWN' : 'INVALID_RESPONSE_UNKNOWN',
          outcome: 'unknown', httpStatus,
        });
      }

      if (response.ok && httpStatus !== undefined && httpStatus >= 200 && httpStatus <= 299 && payload.ok === true) return;
      const telegramCode = boundedInteger(payload.error_code, 400, 499);
      // The relay itself emits {ok:false} on upstream transport failure. Only
      // a coherent Telegram 4xx response proves rejection; 5xx is ambiguous.
      if (payload.ok !== false || telegramCode === undefined || httpStatus === undefined ||
        !(httpStatus === 200 || httpStatus === telegramCode)) {
        throw new TelegramChatFailure({ category: 'HTTP_UNKNOWN', outcome: 'unknown', httpStatus });
      }
      const parameters = payload.parameters && typeof payload.parameters === 'object' && !Array.isArray(payload.parameters)
        ? payload.parameters as Record<string, unknown> : {};
      const description = typeof payload.description === 'string' ? payload.description : '';
      let category: TelegramFailureClass = 'API_REJECTED';
      if (telegramCode === 401) category = 'AUTH_REJECTED';
      else if (telegramCode === 403) category = 'CHAT_FORBIDDEN';
      else if (telegramCode === 429) category = 'RATE_LIMITED';
      else if (telegramCode === 400) {
        category = Number.isSafeInteger(parameters.migrate_to_chat_id) ? 'CHAT_MIGRATED'
          : /\bchat not found\b/i.test(description) ? 'CHAT_NOT_FOUND'
          : /\bmessage is too long\b/i.test(description) ? 'MESSAGE_TOO_LONG' : 'BAD_REQUEST';
      }
      const retryAfterSeconds = telegramCode === 429 ? boundedInteger(parameters.retry_after, 1, 86_400) : undefined;
      if (category === 'RATE_LIMITED') this.chatRateLimitedUntil.set(rateLimitKey, Date.now() + (retryAfterSeconds ?? 60) * 1000);
      throw new TelegramChatFailure({
        category, outcome: 'rejected', httpStatus, telegramCode,
        retryAfterSeconds,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async readResponse(response: Response, controller: AbortController): Promise<Record<string, unknown>> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Telegram response body unavailable');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const entry = await reader.read();
        if (entry.done) break;
        size += entry.value.byteLength;
        if (size > MAX_RESPONSE_BYTES) {
          controller.abort();
          throw new TelegramChatFailure({ category: 'INVALID_RESPONSE_UNKNOWN', outcome: 'unknown',
            httpStatus: boundedInteger(response.status, 100, 599) });
        }
        chunks.push(entry.value);
      }
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Telegram response shape invalid');
      return parsed as Record<string, unknown>;
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  private getBotToken(): string | undefined {
    return (
      this.config.get<string>('OPS_TELEGRAM_BOT_TOKEN')?.trim() ||
      this.config.get<string>('TELEGRAM_BOT_TOKEN')?.trim() ||
      undefined
    );
  }

  private getChatIds(): string[] {
    const configured = [this.config.get<string>('OPS_ALERT_CHAT_IDS'), this.config.get<string>('OPS_ALERT_CHAT_ID')];

    return [
      ...new Set(
        configured
          .flatMap((value) => String(value || '').split(/[\s,;]+/))
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    ];
  }

  private resolveTimeoutMs(): number {
    return Math.min(this.positiveNumber(this.config.get<string>('OPS_TELEGRAM_TIMEOUT_MS'), DEFAULT_TIMEOUT_MS), 60_000);
  }

  private resolveCooldownMs(override?: number): number {
    if (override !== undefined) {
      return Number.isFinite(override) && override > 0 ? override : 0;
    }

    const configured =
      this.config.get<string>('OPS_ALERT_DEDUP_COOLDOWN_MS') || this.config.get<string>('OPS_ALERT_COOLDOWN_MS');
    return this.positiveNumber(configured, DEFAULT_DEDUP_COOLDOWN_MS);
  }

  private positiveNumber(value: string | undefined, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  private removeExpiredDedupEntries(now: number): void {
    if (this.dedupExpirations.size < 1_000) return;
    for (const [key, expiresAt] of this.dedupExpirations) {
      if (expiresAt <= now) this.dedupExpirations.delete(key);
    }
  }

  private safeErrorMessage(error: unknown): string {
    // Only our fixed projection may reach logs; native errors can contain the
    // bot URL/token, chat ID, outgoing message or an untrusted response body.
    return error instanceof TelegramDeliveryFailure ? error.message : 'Unclassified Telegram delivery failure';
  }
}
