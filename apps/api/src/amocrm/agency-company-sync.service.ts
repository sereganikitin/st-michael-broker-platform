import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { createHash } from "node:crypto";
import { Prisma, PrismaClient } from "@st-michael/database";
import { AmoCrmAdapter } from "@st-michael/integrations";
import { OpsAlertService } from "../ops-alert/ops-alert.service";
import {
  AgencyCompanyProfileResolution,
  resolveAgencyCompanyProfile,
} from "./agency-company-profile";

export const AMO_AGENCY_COMPANY_SYNC_RULE_VERSION = "amo-agency-company-v1";
export const AMO_AGENCY_COMPANY_SYNC_STATE_KEY =
  "AMO_AGENCY_COMPANY_SYNC_STATE";
const FAILURE_ALERT_KEY = "amo-agency-company-sync:failure";
const MAX_AGENCIES = 2000;
const MAX_PAGES = 4;
const DEADLINE_MS = 20 * 60 * 1000;
const STALE_RUN_MS = 4 * 60 * 60 * 1000;

export interface AgencyCompanyReader {
  findCompaniesByInnStrict(
    inn: string,
    options?: { maxPages?: number; deadlineAt?: number },
  ): Promise<{
    items: any[];
    pagesRead: number;
    complete: true;
    readAt: string;
  }>;
}

export interface AgencyCompanySyncOptions {
  mode: "apply" | "dry-run";
  agencyIds?: string[];
  maxAgencies?: number;
  deadlineMs?: number;
}

export interface AgencyCompanySyncStats {
  total: number;
  remainingAtStart: number;
  attempted: number;
  processed: number;
  linked: number;
  conflicts: number;
  notFound: number;
  invalidInn: number;
  cycleInvalidInn: number;
  errors: number;
  lookups: number;
  deduplicatedLookups: number;
  pagesRead: number;
  changed: number;
  unchanged: number;
  written: number;
  deferred: number;
  resumed: boolean;
  scopeComplete: boolean;
  cycleComplete: boolean;
  durationMs: number;
}

export interface AgencyCompanySyncResult {
  status: "SUCCEEDED" | "FAILED" | "SKIPPED";
  runId: string | null;
  stats: AgencyCompanySyncStats;
  errorCode: string | null;
  reason: string | null;
}

interface SyncState {
  version: 1;
  cursor: string | null;
  cycleStartedAt: string | null;
  lastCompleteAt: string | null;
  lastErrorCode: string | null;
  cycleInvalidInn: number;
}

type Db = Prisma.TransactionClient;
type AgencyRow = { id: string; inn: string };
class SyncFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function hash(value: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify(value, (key, field) =>
        key === "checkedAt" || key === "sourceUpdatedAt" ? undefined : field,
      ),
    )
    .digest("hex");
}

/** Classify locally; raw exception text never reaches persisted state or alerts. */
export function agencyCompanySyncErrorCode(error: unknown): string {
  if (error instanceof SyncFailure) return error.code;
  const e = error as any;
  const message = String(e?.message || "");
  const code = String(e?.code || "");
  const status = Number(e?.status || e?.statusCode || e?.response?.status);
  if (/^P\d{4}$/.test(code)) return "DATABASE_ERROR";
  if (/AMO_COMPANY_DEADLINE|DEADLINE_EXCEEDED/.test(message))
    return "DEADLINE_EXCEEDED";
  if (
    [401, 403].includes(status) ||
    /amoCRM 40[13]\b|AMO_ACCESS_TOKEN|AMO_AUTH/i.test(message)
  )
    return "AMO_AUTH_ERROR";
  if (status === 429 || /amoCRM 429\b|RATE_LIMIT/i.test(message))
    return "AMO_RATE_LIMIT";
  if (
    /Timeout|AbortError/i.test(String(e?.name || "")) ||
    /TIMEOUT|ETIMEDOUT/i.test(code + message)
  )
    return "AMO_TIMEOUT";
  if (/PAGE_BOUND_EXCEEDED|PAGE_LIMIT/.test(message))
    return "AMO_PAGINATION_LIMIT";
  if (/AMO_(COMPANY|READONLY)_|INCOMPLETE/.test(message))
    return "AMO_INVALID_RESPONSE";
  if (
    status >= 500 ||
    /network|ECONN|ENOTFOUND|EAI_AGAIN/i.test(code + message)
  )
    return "AMO_UNAVAILABLE";
  return "UNEXPECTED_ERROR";
}

const emptyState = (): SyncState => ({
  version: 1,
  cursor: null,
  cycleStartedAt: null,
  lastCompleteAt: null,
  lastErrorCode: null,
  cycleInvalidInn: 0,
});
const emptyStats = (): AgencyCompanySyncStats => ({
  total: 0,
  remainingAtStart: 0,
  attempted: 0,
  processed: 0,
  linked: 0,
  conflicts: 0,
  notFound: 0,
  invalidInn: 0,
  cycleInvalidInn: 0,
  errors: 0,
  lookups: 0,
  deduplicatedLookups: 0,
  pagesRead: 0,
  changed: 0,
  unchanged: 0,
  written: 0,
  deferred: 0,
  resumed: false,
  scopeComplete: false,
  cycleComplete: false,
  durationMs: 0,
});

@Injectable()
export class AgencyCompanySyncService {
  private readonly logger = new Logger(AgencyCompanySyncService.name);
  private reader: AgencyCompanyReader = new AmoCrmAdapter();

  constructor(
    @Inject("PrismaClient") private readonly prisma: PrismaClient,
    @Optional() private readonly opsAlerts?: OpsAlertService,
  ) {}

  setAdapter(reader: AgencyCompanyReader): void {
    this.reader = reader;
  }

  async run(
    options: AgencyCompanySyncOptions,
  ): Promise<AgencyCompanySyncResult> {
    const startedAt = Date.now();
    const stats = emptyStats();
    let runId: string | null = null;
    let state: SyncState | null = null;
    let currentAgency: AgencyRow | null = null;
    let attemptAt = new Date(startedAt);
    let status: AgencyCompanySyncResult["status"] = "SUCCEEDED";
    let errorCode: string | null = null;
    let previousFailure: string | null = null;
    let global = true;
    let deadlineAt = startedAt;
    let maxAgencies = MAX_AGENCIES;

    try {
      maxAgencies = options?.maxAgencies ?? MAX_AGENCIES;
      const deadlineMs = options?.deadlineMs ?? DEADLINE_MS;
      if (
        !options ||
        !["apply", "dry-run"].includes(options.mode) ||
        !Number.isSafeInteger(maxAgencies) ||
        maxAgencies < 1 ||
        maxAgencies > MAX_AGENCIES ||
        !Number.isSafeInteger(deadlineMs) ||
        deadlineMs < 1 ||
        deadlineMs > DEADLINE_MS ||
        (options.agencyIds !== undefined &&
          (!Array.isArray(options.agencyIds) ||
            options.agencyIds.some(
              (id) => typeof id !== "string" || !id.trim(),
            ) ||
            options.agencyIds.length > 5000))
      ) {
        throw new SyncFailure("INVALID_OPTIONS");
      }
      deadlineAt = startedAt + deadlineMs;
      global = options.agencyIds === undefined;
      const ids = global
        ? undefined
        : [...new Set(options.agencyIds!.map((id) => id.trim()))].sort();
      const running = await this.prisma.loyaltySyncRun.findFirst({
        where: { source: "AMOCRM", status: "RUNNING" },
        select: { id: true, startedAt: true },
        orderBy: { startedAt: "asc" },
      });
      if (running) {
        const age = startedAt - new Date(running.startedAt).getTime();
        const stale = !Number.isFinite(age) || age >= STALE_RUN_MS;
        if (stale) await this.failureAlert("STALE_RUNNING_RUN", stats);
        return {
          status: "SKIPPED",
          runId: null,
          stats,
          errorCode: stale ? "STALE_RUNNING_RUN" : null,
          reason: stale
            ? "Existing AMOCRM run requires operator review"
            : "Another AMOCRM sync is running",
        };
      }
      const actor = await this.prisma.broker.findFirst({
        where: { role: "ADMIN", mergedIntoId: null },
        select: { id: true },
        orderBy: { createdAt: "asc" },
      });
      if (!actor) throw new SyncFailure("ADMIN_ACTOR_NOT_FOUND");
      try {
        const run = await this.prisma.loyaltySyncRun.create({
          data: {
            source: "AMOCRM",
            status: "RUNNING",
            ruleVersion: AMO_AGENCY_COMPANY_SYNC_RULE_VERSION,
            sourceRefHash: hash({ mode: options.mode, scope: ids || "ALL" }),
            requestedById: actor.id,
          },
          select: { id: true },
        });
        runId = run.id;
      } catch (error) {
        if ((error as any)?.code === "P2002")
          return {
            status: "SKIPPED",
            runId: null,
            stats,
            errorCode: null,
            reason: "Another AMOCRM sync acquired the source lock",
          };
        throw error;
      }
      state = await this.readState();
      previousFailure = state.lastErrorCode;
      if (global && (!state.cursor || options.mode === "dry-run"))
        state = {
          ...state,
          cursor: null,
          cycleStartedAt: new Date(startedAt).toISOString(),
          cycleInvalidInn: 0,
        };
      stats.cycleInvalidInn = global ? state.cycleInvalidInn : 0;
      const scope: Prisma.AgencyWhereInput = ids ? { id: { in: ids } } : {};
      const remaining: Prisma.AgencyWhereInput =
        global && state.cursor
          ? { AND: [scope, { id: { gt: state.cursor } }] }
          : scope;
      stats.resumed = global && state.cursor !== null;
      stats.total = await this.prisma.agency.count({ where: scope });
      stats.remainingAtStart = await this.prisma.agency.count({
        where: remaining,
      });
      if (ids && stats.total !== ids.length)
        throw new SyncFailure("AGENCY_NOT_FOUND");
      const rows = await this.prisma.agency.findMany({
        where: remaining,
        select: { id: true, inn: true },
        orderBy: { id: "asc" },
        take: maxAgencies + 1,
      });
      const readByInn = new Map<
        string,
        { resolution: AgencyCompanyProfileResolution; readAt: Date }
      >();
      for (const agency of rows.slice(0, maxAgencies)) {
        this.assertDeadline(deadlineAt);
        currentAgency = agency;
        attemptAt = new Date();
        stats.attempted++;
        const inn = String(agency.inn || "").replace(/\D/g, "");
        if (!/^\d{10}$|^\d{12}$/.test(inn)) {
          const invalidState = global
            ? { ...state, cycleInvalidInn: state.cycleInvalidInn + 1 }
            : state;
          await this.checkpoint(
            runId,
            agency,
            attemptAt,
            null,
            "INVALID_INN",
            options.mode,
            global,
            invalidState,
            deadlineAt,
            stats,
          );
          if (global)
            state = {
              ...invalidState,
              ...(options.mode === "apply" ? { cursor: agency.id } : {}),
            };
          stats.invalidInn++;
          stats.cycleInvalidInn = global
            ? invalidState.cycleInvalidInn
            : stats.invalidInn;
          stats.errors++;
          stats.processed++;
          currentAgency = null;
          continue;
        }
        let read = readByInn.get(inn);
        if (read) stats.deduplicatedLookups++;
        else {
          stats.lookups++;
          const response = await this.reader.findCompaniesByInnStrict(inn, {
            maxPages: MAX_PAGES,
            deadlineAt,
          });
          this.assertDeadline(deadlineAt);
          if (
            !response ||
            response.complete !== true ||
            !Array.isArray(response.items) ||
            response.items.length > MAX_PAGES * 250 ||
            !Number.isSafeInteger(response.pagesRead) ||
            response.pagesRead < 1 ||
            response.pagesRead > MAX_PAGES
          )
            throw new SyncFailure("AMO_INVALID_RESPONSE");
          stats.pagesRead += response.pagesRead;
          const readAt = new Date(response.readAt);
          if (
            !Number.isFinite(readAt.getTime()) ||
            readAt < attemptAt ||
            readAt.getTime() > Date.now() + 1000
          ) {
            throw new SyncFailure("AMO_INVALID_RESPONSE");
          }
          read = {
            resolution: resolveAgencyCompanyProfile(
              inn,
              response.items,
              readAt,
            ),
            readAt,
          };
          readByInn.set(inn, read);
        }
        const { resolution, readAt } = read;
        const failure =
          resolution.status === "NOT_FOUND" ? "COMPANY_NOT_FOUND" : null;
        await this.checkpoint(
          runId,
          agency,
          attemptAt,
          resolution,
          failure,
          options.mode,
          global,
          state,
          deadlineAt,
          stats,
          readAt,
        );
        if (global && options.mode === "apply")
          state = { ...state, cursor: agency.id };
        if (resolution.status === "NOT_FOUND") stats.notFound++;
        else if (resolution.status === "CONFLICT") stats.conflicts++;
        else stats.linked++;
        stats.processed++;
        currentAgency = null;
      }
      this.assertDeadline(deadlineAt);
      if (rows.length > maxAgencies || stats.processed < stats.remainingAtStart)
        throw new SyncFailure("AGENCY_QUOTA_EXCEEDED");
      if (stats.invalidInn || (global && state.cycleInvalidInn))
        throw new SyncFailure("INVALID_INN");
    } catch (error) {
      status = "FAILED";
      errorCode = agencyCompanySyncErrorCode(error);
      if (!stats.errors || errorCode !== "INVALID_INN") stats.errors++;
      if (
        runId &&
        options?.mode === "apply" &&
        currentAgency &&
        errorCode !== "RUN_OWNERSHIP_LOST"
      ) {
        try {
          await this.prisma.$transaction(async (db) => {
            await this.assertOwnership(db, runId!);
            await this.assertAgencyIdentity(db, currentAgency!);
            await this.writeAttemptFailure(
              db,
              currentAgency!,
              attemptAt,
              errorCode!,
            );
          });
        } catch (writeError) {
          errorCode = agencyCompanySyncErrorCode(writeError);
        }
      }
      await this.failureAlert(errorCode, stats);
    }

    stats.deferred = Math.max(0, stats.remainingAtStart - stats.processed);
    stats.scopeComplete = status === "SUCCEEDED" && stats.deferred === 0;
    stats.cycleComplete = global && stats.scopeComplete;
    stats.durationMs = Date.now() - startedAt;
    if (runId) {
      try {
        await this.prisma.$transaction(async (db) => {
          await this.assertOwnership(db, runId!);
          if (
            options.mode === "apply" &&
            state &&
            (global || status === "FAILED")
          ) {
            const invalidCycleEnded =
              global && errorCode === "INVALID_INN" && stats.deferred === 0;
            const next =
              status === "SUCCEEDED" && global
                ? {
                    ...state,
                    cursor: null,
                    cycleStartedAt: null,
                    cycleInvalidInn: 0,
                    lastCompleteAt: new Date().toISOString(),
                    lastErrorCode: null,
                  }
                : {
                    ...state,
                    ...(invalidCycleEnded
                      ? {
                          cursor: null,
                          cycleStartedAt: null,
                          cycleInvalidInn: 0,
                        }
                      : {}),
                    lastErrorCode:
                      status === "FAILED" ? errorCode : state.lastErrorCode,
                  };
            await this.saveState(db, next);
          }
          await db.loyaltySyncRun.updateMany({
            where: {
              id: runId!,
              source: "AMOCRM",
              status: "RUNNING",
              ruleVersion: AMO_AGENCY_COMPANY_SYNC_RULE_VERSION,
            },
            data: {
              status: status as "SUCCEEDED" | "FAILED",
              completedAt: new Date(),
              errorCode,
              counts: { mode: options.mode, ...stats } as Prisma.InputJsonValue,
              contentHash: hash({
                mode: options.mode,
                status,
                errorCode,
                stats,
              }),
            },
          });
        });
      } catch (error) {
        status = "FAILED";
        errorCode = agencyCompanySyncErrorCode(error);
        stats.errors++;
        stats.scopeComplete = false;
        stats.cycleComplete = false;
        await this.failureAlert(errorCode, stats);
      }
    }
    if (
      status === "SUCCEEDED" &&
      options.mode === "apply" &&
      global &&
      previousFailure
    ) {
      await this.alert(
        "Синхронизация данных компаний amoCRM восстановлена. Полный цикл чтения завершён.",
        "amo-agency-company-sync:recovery",
        0,
      );
    }
    this.logger.log(
      `[agency-company-sync] ${status} code=${errorCode || "NONE"} processed=${stats.processed} deferred=${stats.deferred}`,
    );
    stats.durationMs = Date.now() - startedAt;
    return {
      status,
      runId,
      stats,
      errorCode,
      reason:
        status === "FAILED"
          ? "Agency company source scope was not completed successfully"
          : null,
    };
  }

  private assertDeadline(deadlineAt: number): void {
    if (Date.now() >= deadlineAt) throw new SyncFailure("DEADLINE_EXCEEDED");
  }

  private async assertOwnership(db: Db, runId: string): Promise<void> {
    // The conditional no-op update also locks our audit row for this short DB
    // transaction, so snapshot/checkpoint cannot commit after another owner ends it.
    const held = await db.loyaltySyncRun.updateMany({
      where: {
        id: runId,
        source: "AMOCRM",
        status: "RUNNING",
        ruleVersion: AMO_AGENCY_COMPANY_SYNC_RULE_VERSION,
      },
      data: { status: "RUNNING" },
    });
    if (held.count !== 1) throw new SyncFailure("RUN_OWNERSHIP_LOST");
  }

  private async assertAgencyIdentity(db: Db, agency: AgencyRow): Promise<void> {
    // Hold the agency row until snapshot and cursor commit, without touching its
    // updatedAt or manual fields. A concurrent INN edit must precede or follow us.
    const rows = await db.$queryRaw<
      AgencyRow[]
    >`SELECT "id", "inn" FROM "agencies" WHERE "id" = ${agency.id} FOR UPDATE`;
    const normalize = (inn: string) => String(inn || "").replace(/\D/g, "");
    if (rows.length !== 1 || normalize(rows[0].inn) !== normalize(agency.inn))
      throw new SyncFailure("AGENCY_IDENTITY_CHANGED");
  }

  private async checkpoint(
    runId: string,
    agency: AgencyRow,
    attemptAt: Date,
    resolution: AgencyCompanyProfileResolution | null,
    errorCode: string | null,
    mode: "apply" | "dry-run",
    global: boolean,
    state: SyncState,
    deadlineAt: number,
    stats: AgencyCompanySyncStats,
    checkedAt: Date = attemptAt,
  ): Promise<void> {
    const contentHash =
      resolution && resolution.status !== "NOT_FOUND" ? hash(resolution) : null;
    const write = async (db: Db) => {
      if (mode === "apply") {
        this.assertDeadline(deadlineAt);
        await this.assertOwnership(db, runId);
        await this.assertAgencyIdentity(db, agency);
      }
      const existing = await db.agencyAmoCompanySync.findUnique({
        where: { agencyId: agency.id },
        select: { contentHash: true },
      });
      const changed =
        contentHash !== null && existing?.contentHash !== contentHash;
      if (mode === "apply") {
        this.assertDeadline(deadlineAt);
        if (errorCode)
          await this.writeAttemptFailure(db, agency, attemptAt, errorCode);
        else {
          const fresh = resolution!;
          const common = {
            lastAttemptAt: attemptAt,
            lastSuccessAt: checkedAt,
            sourceUpdatedAt: fresh.sourceUpdatedAt
              ? new Date(fresh.sourceUpdatedAt)
              : null,
            fieldSources:
              fresh.fieldSources as unknown as Prisma.InputJsonValue,
            conflicts: fresh.conflicts as unknown as Prisma.InputJsonValue,
            contracts: fresh.contracts as unknown as Prisma.InputJsonValue,
            errorCode: null,
          };
          const content = {
            linkStatus: fresh.status,
            companyIds: fresh.companyIds as Prisma.InputJsonValue,
            profile: fresh.profile as Prisma.InputJsonValue,
            contentHash,
          };
          await db.agencyAmoCompanySync.upsert({
            where: { agencyId: agency.id },
            create: { agencyId: agency.id, ...common, ...content },
            update: { ...common, ...(changed ? content : {}) },
          });
        }
        if (global) await this.saveState(db, { ...state, cursor: agency.id });
        this.assertDeadline(deadlineAt);
      }
      return changed;
    };
    const changed =
      mode === "apply"
        ? await this.prisma.$transaction(write)
        : await write(this.prisma as unknown as Db);
    if (contentHash !== null) {
      if (changed) stats.changed++;
      else stats.unchanged++;
    }
    if (mode === "apply") stats.written++;
  }

  private async writeAttemptFailure(
    db: Db,
    agency: AgencyRow,
    at: Date,
    errorCode: string,
  ): Promise<void> {
    await db.agencyAmoCompanySync.upsert({
      where: { agencyId: agency.id },
      create: {
        agencyId: agency.id,
        linkStatus: "NOT_FOUND",
        lastAttemptAt: at,
        errorCode,
      },
      update: { lastAttemptAt: at, errorCode },
    });
  }

  private async readState(): Promise<SyncState> {
    const setting = await this.prisma.systemSetting.findUnique({
      where: { key: AMO_AGENCY_COMPANY_SYNC_STATE_KEY },
      select: { value: true },
    });
    if (!setting) return emptyState();
    let raw: any;
    try {
      raw = JSON.parse(setting.value);
    } catch {
      throw new SyncFailure("SYNC_STATE_INVALID");
    }
    const validDate = (value: unknown) =>
      value === null ||
      (typeof value === "string" && Number.isFinite(new Date(value).getTime()));
    if (
      !raw ||
      raw.version !== 1 ||
      (raw.cursor !== null &&
        (typeof raw.cursor !== "string" ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(raw.cursor))) ||
      !validDate(raw.cycleStartedAt) ||
      !validDate(raw.lastCompleteAt) ||
      (raw.lastErrorCode !== null &&
        (typeof raw.lastErrorCode !== "string" ||
          !/^[A-Z0-9_]{1,100}$/.test(raw.lastErrorCode))) ||
      (raw.cycleInvalidInn !== undefined &&
        (!Number.isSafeInteger(raw.cycleInvalidInn) || raw.cycleInvalidInn < 0))
    )
      throw new SyncFailure("SYNC_STATE_INVALID");
    return {
      version: 1,
      cursor: raw.cursor,
      cycleStartedAt: raw.cycleStartedAt,
      lastCompleteAt: raw.lastCompleteAt,
      lastErrorCode: raw.lastErrorCode,
      cycleInvalidInn: raw.cycleInvalidInn || 0,
    };
  }

  private async saveState(db: Db, state: SyncState): Promise<void> {
    const data = {
      value: JSON.stringify(state),
      updatedBy: "amo-agency-company-sync",
    };
    await db.systemSetting.upsert({
      where: { key: AMO_AGENCY_COMPANY_SYNC_STATE_KEY },
      create: { key: AMO_AGENCY_COMPANY_SYNC_STATE_KEY, ...data },
      update: data,
    });
  }

  private async failureAlert(
    code: string,
    stats: AgencyCompanySyncStats,
  ): Promise<void> {
    await this.alert(
      `Синхронизация данных компаний amoCRM требует внимания. Код ${code}. Обработано ${stats.processed}, ошибок ${stats.errors}.`,
      FAILURE_ALERT_KEY,
      60 * 60 * 1000,
    );
  }

  private async alert(
    message: string,
    dedupKey: string,
    cooldownMs: number,
  ): Promise<void> {
    try {
      await this.opsAlerts?.sendSafely(message, { dedupKey, cooldownMs });
    } catch {
      this.logger.warn(
        "[agency-company-sync] Alert delivery was not confirmed",
      );
    }
  }
}
