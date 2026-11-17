import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { PrismaClient } from "@st-michael/database";
import { randomUUID } from "node:crypto";
import { ClientFixationService } from "./client-fixation.service";
import {
  ClientFixationSafetyService,
  clientFixationFingerprint,
  clientFixationSemanticFingerprint,
  isFixationGuardConflict,
} from "./client-fixation-safety.service";
import {
  fixationFailureCode,
  isFixationPreflightFailure,
  RETRYABLE_FIXATION_CODES,
} from "./fixation-preflight";

const ACTIVE = [
  "PENDING",
  "PROCESSING",
  "RETRY",
  "DELIVERY_PENDING",
  "NEEDS_REVIEW",
];
const LEASE_MS = 10 * 60_000;
const MAX_ATTEMPTS = 6;
const json = (value: unknown) =>
  JSON.parse(
    JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? String(v) : v)),
  );

@Injectable()
export class FixationRequestService {
  private readonly logger = new Logger(FixationRequestService.name);
  private draining = false;

  constructor(
    @Inject("PrismaClient") private readonly prisma: PrismaClient,
    private readonly safety: ClientFixationSafetyService,
    private readonly fixation: ClientFixationService,
  ) {}

  async submit(
    actorId: string,
    payload: Record<string, unknown>,
    idempotencyKey?: string,
  ) {
    const key = idempotencyKey || randomUUID();
    const fingerprint = clientFixationFingerprint(payload);
    const phoneKey = clientFixationSemanticFingerprint(payload);
    let request: any;
    try {
      request = await this.prisma.$transaction(async (tx) => {
        // Serialize intake only, never hold a database transaction across CRM I/O.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`fixation-intake:${actorId}:${phoneKey}`}, 0))`;
        const previous = await tx.fixationRequestKey.findUnique({
          where: { actorId_key: { actorId, key } },
          include: { request: true },
        });
        if (previous) {
          if (previous.request.fingerprint !== fingerprint)
            throw new BadRequestException(
              "Эта заявка уже отправлена с другими данными. Начните новую фиксацию.",
            );
          return previous.request;
        }
        // Different browser tabs can supply different UUIDs. Keep their aliases
        // permanently, so a late retry cannot turn into a new request after completion.
        let row = await tx.fixationRequest.findFirst({
          where: { actorId, fingerprint, state: { in: ACTIVE } },
          orderBy: { createdAt: "asc" },
        });
        if (!row)
          row = await tx.fixationRequest.create({
            data: { actorId, fingerprint, phoneKey, payload: json(payload) },
          });
        await tx.fixationRequestKey.create({
          data: { actorId, key, requestId: row.id },
        });
        return row;
      });
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      // A transaction acknowledgement can be lost. Read the durable key first.
      const saved = await this.prisma.fixationRequestKey
        .findUnique({
          where: { actorId_key: { actorId, key } },
          include: { request: true },
        })
        .catch(() => null);
      if (saved) {
        if (saved.request.fingerprint !== fingerprint)
          throw new BadRequestException(
            "Эта заявка уже отправлена с другими данными. Начните новую фиксацию.",
          );
        request = saved.request;
      } else {
        throw new ServiceUnavailableException(
          "Не удалось подтвердить сохранение заявки. Повторите отправку с этой страницы — номер заявки сохранится.",
        );
      }
    }
    return (await this.views([request]))[0];
  }

  async get(actorId: string, id: string) {
    const row = await this.prisma.fixationRequest.findFirst({
      where: { id, actorId },
    });
    if (!row) throw new NotFoundException("Заявка не найдена");
    return (await this.views([row]))[0];
  }

  async list(actorId: string) {
    const [active, recent] = await Promise.all([
      this.prisma.fixationRequest.findMany({
        where: { actorId, state: { in: ACTIVE } },
        orderBy: { createdAt: "asc" },
        take: 50,
      }),
      this.prisma.fixationRequest.findMany({
        where: { actorId, state: "COMPLETED" },
        orderBy: { createdAt: "desc" },
        take: 20,
      }),
    ]);
    return this.views([...active, ...recent]);
  }

  async reviewQueue() {
    const rows = await this.prisma.fixationRequest.findMany({
      where: { state: { in: ["NEEDS_REVIEW", "DELIVERY_PENDING"] } },
      orderBy: { updatedAt: "asc" },
      take: 50,
    });
    return rows.map((row) => ({
      ...this.view(row),
      actorId: row.actorId,
      errorCode: row.errorCode,
      canRetryCheck: row.state === "NEEDS_REVIEW" && row.phase === "CHECKING",
    }));
  }

  async retryCheck(actorId: string, requestId: string) {
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.fixationRequest.updateMany({
        where: { id: requestId, state: "NEEDS_REVIEW", phase: "CHECKING" },
        data: {
          state: "RETRY",
          attempts: 0,
          nextAttemptAt: new Date(),
          errorCode: null,
        },
      });
      if (updated.count !== 1)
        throw new BadRequestException(
          "Повтор проверки недоступен: результат передачи сделки требует сверки либо заявка уже обрабатывается.",
        );
      await tx.auditLog.create({
        data: {
          userId: actorId,
          action: "FIXATION_CHECK_REQUEUED",
          entity: "FixationRequest",
          entityId: requestId,
        },
      });
    });
    return { message: "Повторная проверка назначена." };
  }

  private async views(rows: any[]) {
    const completed = rows.filter((row) => row.state === "COMPLETED");
    const ids = completed
      .map((row) => row.result?.client?.id)
      .filter((id): id is string => typeof id === "string");
    const clients = completed.length
      ? await this.prisma.client.findMany({
          // IDs come only from the authenticated actor's durable receipts, including
          // a fixation submitted by an authorized agency coordinator for a colleague.
          where: {
            OR: [
              { id: { in: ids } },
              { fixationRequestId: { in: completed.map((row) => row.id) } },
            ],
          },
          select: { id: true, fixationRequestId: true, uniquenessStatus: true },
        })
      : [];
    const byId = new Map(clients.map((client) => [client.id, client]));
    const byRequest = new Map(
      clients.map((client) => [client.fixationRequestId, client]),
    );
    return rows.map((row) =>
      this.view(row, byRequest.get(row.id) || byId.get(row.result?.client?.id)),
    );
  }

  private view(
    row: any,
    currentClient?: { id: string; uniquenessStatus: string },
  ) {
    const messages: Record<string, string> = {
      PENDING: "Заявка принята. Проверка начнётся автоматически.",
      PROCESSING: "Проверяем заявку. Повторная отправка не требуется.",
      RETRY: "Проверка временно задерживается. Повторим автоматически.",
      DELIVERY_PENDING:
        "Заявка сохранена. Передача в amoCRM ещё не подтверждена.",
      NEEDS_REVIEW:
        "Заявка сохранена и требует проверки сотрудником. Повторно подавать её не нужно.",
      COMPLETED: "Заявка обработана.",
    };
    const result =
      row.state === "COMPLETED"
        ? {
            ...row.result,
            ...(currentClient
              ? {
                  client: { id: currentClient.id },
                  status: currentClient.uniquenessStatus,
                }
              : {}),
          }
        : undefined;
    const labels: Record<string, string> = {
      CONDITIONALLY_UNIQUE: "Уникален",
      UNDER_REVIEW: "На проверке",
      REJECTED: "Не уникален",
      EXPIRED: "Срок фиксации истёк",
    };
    return {
      requestId: row.id,
      requestState: row.state,
      status: result?.status || "ACCEPTED",
      ...(result?.client?.id ? { client: { id: result.client.id } } : {}),
      ...(result?.agencyWarning ? { agencyWarning: result.agencyWarning } : {}),
      message: labels[result?.status]
        ? `Заявка обработана. Результат проверки: «${labels[result.status]}».`
        : messages[row.state] || messages.NEEDS_REVIEW,
      fullName: row.payload?.fullName,
      project: row.payload?.project,
      createdAt: row.createdAt,
    };
  }

  /** Database outbox: acceptance survives Redis outages and API restarts. */
  @Cron("*/30 * * * * *")
  async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      const now = new Date();
      await this.prisma.fixationRequest.updateMany({
        where: {
          state: "PROCESSING",
          phase: "CHECKING",
          leaseUntil: { lte: now },
        },
        data: {
          state: "RETRY",
          leaseToken: null,
          leaseUntil: null,
          nextAttemptAt: now,
          errorCode: "WORKER_INTERRUPTED_BEFORE_MUTATION",
        },
      });
      await this.prisma.fixationRequest.updateMany({
        where: {
          state: "PROCESSING",
          phase: "MUTATING",
          leaseUntil: { lte: now },
        },
        data: {
          state: "NEEDS_REVIEW",
          leaseToken: null,
          leaseUntil: null,
          errorCode: "WORKER_INTERRUPTED_AFTER_MUTATION",
        },
      });
      const pending = await this.prisma.fixationRequest.findMany({
        where: {
          state: { in: ["PENDING", "RETRY"] },
          nextAttemptAt: { lte: now },
        },
        orderBy: { nextAttemptAt: "asc" },
        take: 5,
      });
      for (const row of pending) await this.process(row.id);
      const deliveries = await this.prisma.fixationRequest.findMany({
        where: {
          state: { in: ["DELIVERY_PENDING", "NEEDS_REVIEW"] },
          phase: "MUTATING",
          nextAttemptAt: { lte: now },
        },
        orderBy: { nextAttemptAt: "asc" },
        take: 20,
      });
      for (const row of deliveries) await this.reconcileDelivery(row);
    } catch {
      // Dependency exceptions may contain credentials or submitted contact data.
      this.logger.error("FIXATION_OUTBOX_DRAIN_FAILED");
    } finally {
      this.draining = false;
    }
  }

  async process(id: string) {
    const token = randomUUID();
    const now = new Date();
    const claim = await this.prisma.fixationRequest.updateMany({
      where: {
        id,
        state: { in: ["PENDING", "RETRY"] },
        nextAttemptAt: { lte: now },
        phase: "CHECKING",
      },
      data: {
        state: "PROCESSING",
        leaseToken: token,
        leaseUntil: new Date(now.getTime() + LEASE_MS),
        attempts: { increment: 1 },
      },
    });
    if (claim.count !== 1) return;
    const row = await this.prisma.fixationRequest.findUniqueOrThrow({
      where: { id },
    });
    const owned = { id, state: "PROCESSING", leaseToken: token };
    let enteredAction = false;
    const renewal = setInterval(() => {
      void this.prisma.fixationRequest
        .updateMany({
          where: { ...owned, leaseUntil: { gt: new Date() } },
          data: { leaseUntil: new Date(Date.now() + LEASE_MS) },
        })
        .catch(() => undefined);
    }, 30_000);
    try {
      const result: any = await this.safety.execute(
        { actorId: row.actorId, payload: row.payload, idempotencyKey: row.id },
        async ({ assertOwned }) => {
          enteredAction = true;
          return this.fixation.fixClient(
            row.actorId,
            row.payload as any,
            async () => {
              await assertOwned();
              const current = await this.prisma.fixationRequest.findFirst({
                where: { ...owned, leaseUntil: { gt: new Date() } },
                select: { id: true },
              });
              if (!current) throw new Error("FIXATION_REQUEST_LEASE_LOST");
            },
            {
              requestId: row.id,
              beforeMutation: async () => {
                await assertOwned();
                const marked = await this.prisma.fixationRequest.updateMany({
                  where: {
                    ...owned,
                    phase: "CHECKING",
                    leaseUntil: { gt: new Date() },
                  },
                  data: { phase: "MUTATING" },
                });
                if (marked.count !== 1)
                  throw new Error("FIXATION_REQUEST_LEASE_LOST");
              },
            },
          );
        },
      );
      await this.prisma.fixationRequest.updateMany({
        where: owned,
        data: {
          state: ["FAILED", "PENDING"].includes(result?.amoSyncStatus)
            ? "DELIVERY_PENDING"
            : "COMPLETED",
          result: json(result),
          errorCode: ["FAILED", "PENDING"].includes(result?.amoSyncStatus)
            ? "AMO_DELIVERY_UNCONFIRMED"
            : null,
          leaseToken: null,
          leaseUntil: null,
          nextAttemptAt: new Date(Date.now() + 60_000),
        },
      });
    } catch (error: any) {
      const safeToRepeat = !enteredAction || isFixationPreflightFailure(error);
      const code = isFixationGuardConflict(error)
        ? "FIXATION_GUARD_BUSY"
        : fixationFailureCode(error);
      const transient = !enteredAction || RETRYABLE_FIXATION_CODES.has(code);
      const retry = safeToRepeat && transient && row.attempts < MAX_ATTEMPTS;
      await this.prisma.fixationRequest.updateMany({
        where: owned,
        data: {
          state: retry ? "RETRY" : "NEEDS_REVIEW",
          ...(safeToRepeat ? { phase: "CHECKING" } : {}),
          errorCode: code,
          leaseToken: null,
          leaseUntil: null,
          nextAttemptAt: new Date(
            Date.now() + Math.min(30_000 * 2 ** (row.attempts - 1), 600_000),
          ),
        },
      });
      this.logger.warn(
        `Fixation request ${id}: ${retry ? "RETRY" : "NEEDS_REVIEW"} code=${code}`,
      );
    } finally {
      clearInterval(renewal);
    }
  }

  private async reconcileDelivery(row: any) {
    // Never rerun fixClient after it may have created a lead. Existing reviewed
    // delivery recovery (or an exact manual link) owns the CRM reconciliation.
    const client = await this.prisma.client.findUnique({
      where: { fixationRequestId: row.id },
    });
    const linked = client?.amoLeadId && client.amoSyncStatus === "SYNCED";
    await this.prisma.fixationRequest.updateMany({
      where: { id: row.id, state: row.state, updatedAt: row.updatedAt },
      data: {
        nextAttemptAt: new Date(Date.now() + 10 * 60_000),
        ...(linked
          ? {
              state: "COMPLETED",
              errorCode: null,
              result: json({
                client,
                status: client.uniquenessStatus,
                amoSyncStatus: "SYNCED",
                message: "Заявка передана в amoCRM. Статус обновлён.",
              }),
            }
          : {}),
      },
    });
  }
}
