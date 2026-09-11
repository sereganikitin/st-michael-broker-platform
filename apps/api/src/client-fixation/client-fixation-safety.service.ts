import {
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { amoFixationPhoneLockFingerprint } from "@st-michael/integrations";
import {
  AMO_FIXATION_PHONE_LOCK_TTL_MS,
  AmoFixationPhoneLockService,
} from "../common/amo-fixation-phone-lock.service";

const PROCESSING_TTL_MS = AMO_FIXATION_PHONE_LOCK_TTL_MS;
const COMPLETED_TTL_MS = 5 * 60_000;
const LEASE_RENEW_INTERVAL_MS = 30_000;

// 2026-09-11 (аудит обращения владельца): тексты видит брокер — внешний
// человек, поэтому без технических формулировок. См. правило «ошибки базы
// не должны доходить до брокера».
const REPLAY_KEY_REUSED_MESSAGE =
  "Эта заявка уже отправлялась с другими данными. Обновите страницу и заполните форму заново.";
const SAME_REQUEST_IN_FLIGHT_MESSAGE =
  "Заявка уже отправляется. Подождите несколько секунд и не отправляйте её повторно.";
const SAME_REQUEST_UNCERTAIN_MESSAGE =
  "Предыдущая отправка этой заявки завершилась неоднозначно. Подождите минуту и повторите — если повторится, напишите в поддержку.";
const OTHER_REQUEST_IN_FLIGHT_MESSAGE =
  "По этому номеру сейчас обрабатывается другая заявка. Повторите через минуту.";
const OTHER_REQUEST_UNCERTAIN_MESSAGE =
  "По этому номеру предыдущая заявка завершилась неоднозначно. Подождите минуту и повторите — если повторится, напишите в поддержку.";
const STORED_STATE_BROKEN_MESSAGE =
  "Не удалось проверить предыдущую отправку заявки. Обновите страницу и попробуйте снова.";

/**
 * Перехват завершённого замка по номеру: меняем значение только если оно в
 * точности то, которое мы прочитали. Гонка двух заявок на один номер
 * заканчивается тем, что перехват удаётся ровно одной.
 */
const TAKE_OVER_COMPLETED_SCRIPT = `
-- client-fixation:take-over-completed
if redis.call("GET", KEYS[1]) == ARGV[1] then
  redis.call("SET", KEYS[1], ARGV[2], "PX", tonumber(ARGV[3]))
  return 1
end
return 0
`;

type StoredFixation<T = unknown> = {
  fingerprint: string;
  status: "processing" | "completed" | "uncertain";
  owner?: string;
  result?: T;
};

export interface GuardedClientFixation {
  actorId: string;
  payload: unknown;
  idempotencyKey?: string;
}

export interface ClientFixationLeaseContext {
  /** Proves Redis ownership immediately before the one-shot amo write. */
  assertOwned(): Promise<void>;
}

function stableJson(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? JSON.stringify(value) : "null";
  }
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (typeof value === "object") {
    const objectValue = value as Record<string, unknown>;
    return `{${Object.keys(objectValue)
      .filter((key) => objectValue[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(objectValue[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(String(value));
}

/** Exact, PII-free identity used for UUID replay/conflict detection. */
export function clientFixationFingerprint(payload: unknown): string {
  return createHash("sha256").update(stableJson(payload)).digest("hex");
}

/**
 * Global business identity used for the distributed single-writer lock.
 * amoCRM uniqueness is phone-based, so every simultaneous submission for one
 * canonical phone must share a writer regardless of actor, project, agency,
 * presentation fields, or the obsolete confirmDuplicate flag. The stored
 * exact request fingerprint includes actorId, preventing a completed response
 * from ever being replayed into another cabinet.
 */
export function clientFixationSemanticFingerprint(payload: unknown): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return clientFixationFingerprint(payload);
  }

  const parsed = payload as Record<string, unknown>;
  return amoFixationPhoneLockFingerprint(parsed.phone);
}

/**
 * Redis-backed single-writer guard for POST /clients/fix.
 *
 * The semantic key is always acquired, including for legacy callers without
 * an idempotency UUID. This is important because two browser requests can
 * carry different UUIDs and still represent the same double click. The
 * optional UUID key adds bounded response replay and rejects reuse with a
 * different payload. Redis is a readiness dependency, so the guard fails
 * closed instead of creating an amoCRM lead without distributed protection.
 */
/**
 * Признак «заявку остановила защита от двойной отправки». Ошибка выглядит для
 * брокера как отказ сайта, поэтому о ней нужно узнавать сразу: перехватчик
 * FixationFailureInterceptor шлёт по этой метке алерт в Telegram и пишет
 * строку в лог (409-е ответы сами в лог не попадают).
 */
export const FIXATION_GUARD_CONFLICT = "fixationGuardConflict";

export function isFixationGuardConflict(error: unknown): boolean {
  return Boolean((error as Record<string, unknown> | null)?.[FIXATION_GUARD_CONFLICT]);
}

function guardConflict(message: string): ConflictException {
  const conflict = new ConflictException(message);
  Object.assign(conflict, { [FIXATION_GUARD_CONFLICT]: true });
  return conflict;
}

@Injectable()
export class ClientFixationSafetyService {
  private readonly logger = new Logger(ClientFixationSafetyService.name);

  constructor(private readonly phoneLock: AmoFixationPhoneLockService) {}

  async execute<T>(
    request: GuardedClientFixation,
    action: (lease: ClientFixationLeaseContext) => Promise<T>,
  ): Promise<T> {
    const redis = this.phoneLock.redisClient;
    const fingerprint = clientFixationFingerprint({
      actorId: request.actorId,
      payload: request.payload,
    });
    const semanticKey = this.phoneLock.key(
      (request.payload as Record<string, unknown>)?.phone,
    );
    const idempotencyKey = request.idempotencyKey?.trim();
    const replayKey = idempotencyKey
      ? `client-fixation:idempotency:${request.actorId}:${idempotencyKey}`
      : null;
    const owner = randomUUID();
    const processing = this.serialize({
      fingerprint,
      status: "processing",
      owner,
    } satisfies StoredFixation);
    let ownsReplay = false;
    let ownsSemantic = false;

    try {
      if (replayKey) {
        const existingReplay = await redis.get(replayKey);
        if (existingReplay) {
          return this.readStoredResult<T>(existingReplay, fingerprint);
        }

        const acquiredReplay = await redis.set(
          replayKey,
          processing,
          "PX",
          PROCESSING_TTL_MS,
          "NX",
        );
        if (acquiredReplay !== "OK") {
          const racedReplay = await redis.get(replayKey);
          if (racedReplay) {
            return this.readStoredResult<T>(racedReplay, fingerprint);
          }
          throw guardConflict(
            "Повторный запрос фиксации уже обрабатывается",
          );
        }
        ownsReplay = true;
      }

      const applySemantic = async (
        raw: string,
      ): Promise<{ replay: true; result: T } | { replay: false }> => {
        const resolved = await this.resolveSemantic<T>(
          redis,
          raw,
          fingerprint,
          semanticKey,
          processing,
        );
        if (resolved.kind === "replay") {
          if (replayKey && ownsReplay) {
            await this.cacheCompleted(
              redis,
              replayKey,
              owner,
              fingerprint,
              resolved.result,
            );
          }
          return { replay: true, result: resolved.result as T };
        }
        if (resolved.kind === "takeover") {
          ownsSemantic = true;
          return { replay: false };
        }
        if (replayKey && ownsReplay) {
          await this.releaseOwned(redis, replayKey, owner);
          ownsReplay = false;
        }
        throw resolved.conflict;
      };

      const existingSemantic = await this.phoneLock.readKey(semanticKey);
      if (existingSemantic) {
        const outcome = await applySemantic(existingSemantic);
        if (outcome.replay) return outcome.result;
      }

      if (!ownsSemantic) {
        const acquiredSemantic = await this.phoneLock.tryAcquireKey(
          semanticKey,
          processing,
          PROCESSING_TTL_MS,
        );
        if (acquiredSemantic) {
          ownsSemantic = true;
        } else {
          const racedSemantic = await this.phoneLock.readKey(semanticKey);
          if (!racedSemantic) {
            throw guardConflict(SAME_REQUEST_IN_FLIGHT_MESSAGE);
          }
          const outcome = await applySemantic(racedSemantic);
          if (outcome.replay) return outcome.result;
        }
      }
    } catch (error) {
      if (ownsSemantic) await this.releaseOwned(redis, semanticKey, owner);
      if (ownsReplay) await this.releaseOwned(redis, replayKey!, owner);
      if (error instanceof ConflictException) throw error;
      throw new ServiceUnavailableException(
        "Защита от повторной фиксации временно недоступна",
      );
    }

    const lease = this.startLeaseRenewal(
      redis,
      replayKey ? [semanticKey, replayKey] : [semanticKey],
      owner,
    );
    try {
      const result = await action({ assertOwned: lease.assertOwned });
      await lease.stop();
      if (lease.hasLostOwnership()) {
        throw guardConflict(
          "Защита фиксации потеряла владение запросом; результат требует сверки, повтор заблокирован",
        );
      }
      const semanticCached = await this.cacheCompleted(
        redis,
        semanticKey,
        owner,
        fingerprint,
        result,
      );
      let replayCached = true;
      if (replayKey) {
        replayCached = await this.cacheCompleted(
          redis,
          replayKey,
          owner,
          fingerprint,
          result,
        );
      }
      if (!semanticCached || !replayCached) {
        throw guardConflict(
          "Результат фиксации не удалось безопасно закэшировать; повтор заблокирован до сверки",
        );
      }
      return result;
    } catch (error) {
      await lease.stop();
      // The failure can happen after amoCRM accepted POST /leads. Keep a
      // bounded fail-closed marker instead of releasing the lock and turning
      // an ambiguous response into a second lead on retry.
      await this.markUncertain(redis, semanticKey, owner, fingerprint);
      if (replayKey) {
        await this.markUncertain(redis, replayKey, owner, fingerprint);
      }
      throw error;
    } finally {
      await lease.stop();
    }
  }

  private parseStored<T>(raw: string, fingerprint?: string): StoredFixation<T> {
    let stored: StoredFixation<T>;
    try {
      stored = JSON.parse(raw) as StoredFixation<T>;
    } catch {
      throw guardConflict(STORED_STATE_BROKEN_MESSAGE);
    }
    // Отпечаток сверяем только для браузерного ключа: там несовпадение
    // действительно означает «тот же ключ, другие данные». Для замка по
    // номеру клиента чужой отпечаток — норма (одного клиента фиксируют
    // разные брокеры), решение принимает resolveSemantic.
    if (fingerprint !== undefined && stored.fingerprint !== fingerprint) {
      throw guardConflict(REPLAY_KEY_REUSED_MESSAGE);
    }
    if (!["processing", "completed", "uncertain"].includes(stored.status)) {
      throw guardConflict(STORED_STATE_BROKEN_MESSAGE);
    }
    return stored;
  }

  /**
   * 2026-09-11: что делать с уже существующим замком по номеру клиента.
   * Раньше здесь падало «Ключ повторного запроса уже использован для другой
   * фиксации»: сравнивался отпечаток чужой заявки, и пять минут после каждой
   * успешной фиксации номер был заблокирован для всех остальных брокеров.
   */
  private async resolveSemantic<T>(
    redis: any,
    raw: string,
    fingerprint: string,
    semanticKey: string,
    processing: string,
  ): Promise<
    | { kind: "replay"; result: T }
    | { kind: "takeover" }
    | { kind: "conflict"; conflict: ConflictException }
  > {
    const stored = this.parseStored<T>(raw);
    if (stored.fingerprint === fingerprint) {
      // Та же самая заявка: повтор отдаём из кэша, обработку не дублируем.
      if (stored.status === "completed") {
        return { kind: "replay", result: stored.result as T };
      }
      return {
        kind: "conflict",
        conflict: this.processingConflict(stored.status),
      };
    }
    if (stored.status === "completed") {
      // Другая заявка на тот же номер, предыдущая уже завершена — замок
      // держит только кэш её ответа. Перехватываем и идём дальше, в обычные
      // правила уникальности.
      const takenOver = await this.takeOverCompleted(
        redis,
        semanticKey,
        raw,
        processing,
      );
      return takenOver
        ? { kind: "takeover" }
        : {
            kind: "conflict",
            conflict: guardConflict(OTHER_REQUEST_IN_FLIGHT_MESSAGE),
          };
    }
    // Чужая заявка ещё обрабатывается (или завершилась неоднозначно) —
    // ждём: две одновременные записи по одному номеру создадут дубль в amoCRM.
    return {
      kind: "conflict",
      conflict: guardConflict(
        stored.status === "uncertain"
          ? OTHER_REQUEST_UNCERTAIN_MESSAGE
          : OTHER_REQUEST_IN_FLIGHT_MESSAGE,
      ),
    };
  }

  private async takeOverCompleted(
    redis: any,
    key: string,
    expectedRaw: string,
    value: string,
  ): Promise<boolean> {
    try {
      return (
        Number(
          await redis.eval(
            TAKE_OVER_COMPLETED_SCRIPT,
            1,
            key,
            expectedRaw,
            value,
            String(PROCESSING_TTL_MS),
          ),
        ) === 1
      );
    } catch (error: any) {
      this.logger.error(
        `Не удалось перехватить замок по номеру клиента: ${error?.message || error}`,
      );
      return false;
    }
  }

  private readStoredResult<T>(raw: string, fingerprint: string): T {
    const stored = this.parseStored<T>(raw, fingerprint);
    if (stored.status !== "completed") {
      throw this.processingConflict(stored.status);
    }
    return stored.result as T;
  }

  private processingConflict(
    status: StoredFixation["status"],
  ): ConflictException {
    return guardConflict(
      status === "uncertain"
        ? SAME_REQUEST_UNCERTAIN_MESSAGE
        : SAME_REQUEST_IN_FLIGHT_MESSAGE,
    );
  }

  private async cacheCompleted<T>(
    redis: any,
    key: string,
    owner: string,
    fingerprint: string,
    result: T,
  ): Promise<boolean> {
    try {
      const cached = await this.compareOwnerSet(
        redis,
        key,
        owner,
        this.serialize({
          fingerprint,
          status: "completed",
          result,
        } satisfies StoredFixation<T>),
        COMPLETED_TTL_MS,
      );
      if (!cached) {
        this.logger.error(
          "Client fixation lease was lost before the result could be cached",
        );
      }
      return cached;
    } catch (error: any) {
      this.logger.error(
        `Failed to cache client fixation result: ${error?.message || error}`,
      );
      return false;
    }
  }

  private async markUncertain(
    redis: any,
    key: string,
    owner: string,
    fingerprint: string,
  ): Promise<void> {
    try {
      const preserved = await this.compareOwnerSet(
        redis,
        key,
        owner,
        this.serialize({
          fingerprint,
          status: "uncertain",
        } satisfies StoredFixation),
        PROCESSING_TTL_MS,
      );
      if (!preserved) {
        this.logger.error(
          "Client fixation lease was lost before ambiguity could be recorded",
        );
      }
    } catch (error: any) {
      this.logger.error(
        `Failed to preserve ambiguous client fixation guard: ${error?.message || error}`,
      );
    }
  }

  private serialize(value: unknown): string {
    return JSON.stringify(value, (_key, item) =>
      typeof item === "bigint" ? item.toString() : item,
    );
  }

  private startLeaseRenewal(
    redis: any,
    keys: string[],
    owner: string,
  ): {
    hasLostOwnership: () => boolean;
    assertOwned: () => Promise<void>;
    stop: () => Promise<void>;
  } {
    let stopped = false;
    let lostOwnership = false;
    let inFlight = Promise.resolve();
    const renew = async () => {
      if (stopped) return;
      try {
        const renewed = await Promise.all(
          keys.map((key) => this.renewOwned(redis, key, owner)),
        );
        if (renewed.some((owned) => !owned)) {
          lostOwnership = true;
          this.logger.error(
            "Client fixation lease ownership was lost during renewal",
          );
        }
      } catch (error: any) {
        lostOwnership = true;
        this.logger.error(
          `Failed to renew client fixation lease: ${error?.message || error}`,
        );
      }
    };
    const timer = setInterval(() => {
      inFlight = inFlight.then(renew, renew);
    }, LEASE_RENEW_INTERVAL_MS);
    timer.unref?.();
    return {
      hasLostOwnership: () => lostOwnership,
      assertOwned: async () => {
        inFlight = inFlight.then(renew, renew);
        await inFlight;
        if (stopped || lostOwnership) {
          lostOwnership = true;
          throw guardConflict(
            "CLIENT_FIXATION_PHONE_LOCK_LOST",
          );
        }
      },
      stop: async () => {
        stopped = true;
        clearInterval(timer);
        await inFlight;
      },
    };
  }

  private async compareOwnerSet(
    _redis: any,
    key: string,
    owner: string,
    value: string,
    ttlMs: number,
  ): Promise<boolean> {
    return this.phoneLock.replaceOwnedKey(key, owner, value, ttlMs);
  }

  private async renewOwned(
    _redis: any,
    key: string,
    owner: string,
  ): Promise<boolean> {
    return this.phoneLock.renewOwnedKey(key, owner, PROCESSING_TTL_MS);
  }

  private async releaseOwned(
    _redis: any,
    key: string,
    owner: string,
  ): Promise<void> {
    try {
      await this.phoneLock.releaseOwnedKey(key, owner);
    } catch (error: any) {
      this.logger.error(
        `Failed to release client fixation guard: ${error?.message || error}`,
      );
    }
  }
}
