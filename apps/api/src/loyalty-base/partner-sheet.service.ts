import {
  Inject,
  Injectable,
  ServiceUnavailableException,
  Logger,
} from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { OpsAlertService } from "../ops-alert/ops-alert.service";
import type { PrismaClient } from "@st-michael/database";
import { join } from "node:path";

// Docker keeps the reviewed scripts at /app/scripts; the same relative
// root works in src and dist. No user input can influence these paths.
const { readSource } = require(
  join(__dirname, "../../../../scripts/partner-sheet/read-source.cjs"),
);
const { buildView } = require(
  join(__dirname, "../../../../scripts/partner-sheet/view.cjs"),
);
const { validateView, encodeSnapshot, decodeSnapshot } = require(
  join(__dirname, "../../../../scripts/partner-sheet/snapshot.cjs"),
);
const SNAPSHOT_KEY = "partner-sheet-v1-2:verified-snapshot";
const INCIDENT_KEY = "partner-sheet-v1-2:incident";
type PendingIncident = {
  version: 1;
  startedAt: string;
  stage: string;
  delivery: "pending" | "attempted";
};
export function partnerSheetQuietTime(now = new Date()) {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Moscow",
      hour: "2-digit",
      hourCycle: "h23",
    }).format(now),
  );
  return hour < 9 || hour >= 22;
}

@Injectable()
export class PartnerSheetService {
  private cached: { expires: number; value: any } | null = null;
  private pending: Promise<any> | null = null;
  private readonly logger = new Logger(PartnerSheetService.name);
  private failureStage = "чтение источника";
  private volatileIncident: PendingIncident | null = null;
  constructor(
    @Inject("PrismaClient") private readonly prisma: PrismaClient,
    private readonly alerts: OpsAlertService,
  ) {}

  async list() {
    if (this.cached && this.cached.expires > Date.now())
      return this.cached.value;
    try {
      return await this.refresh();
    } catch {
      const saved = await this.prisma.systemSetting.findUnique({
        where: { key: SNAPSHOT_KEY },
      });
      if (!saved)
        throw new ServiceUnavailableException(
          "Проверенный снимок таблицы пока недоступен.",
        );
      return {
        ...decodeSnapshot(saved.value),
        syncWarning:
          "Google-таблица сейчас не обновилась. Показан последний проверенный снимок.",
      };
    }
  }

  private async refresh() {
    if (this.pending) return this.pending;
    this.pending = this.load();
    try {
      return await this.pending;
    } finally {
      this.pending = null;
    }
  }

  @Cron("0 10,15,20 * * *", { timeZone: "Europe/Moscow" })
  async scheduledSync(): Promise<void> {
    try {
      // A scheduled check never treats a still-valid 60s memory cache as a sync.
      await this.refresh();
    } catch {
      await this.reportFailure();
    }
  }

  private async reportFailure() {
    const incident: PendingIncident = {
      version: 1,
      startedAt: new Date().toISOString(),
      stage: this.failureStage,
      delivery: "pending",
    };
    try {
      // Reserve before the send: an uncertain Telegram response must not
      // produce the same fan-out every subsequent run or after an API restart.
      await this.prisma.systemSetting.create({
        data: { key: INCIDENT_KEY, value: JSON.stringify(incident) },
      });
    } catch (error) {
      if ((error as { code?: string }).code !== "P2002") {
        this.logger.error("Partner sheet incident persistence unavailable");
        this.volatileIncident ??= incident;
      }
    }
    await this.flushPendingIncident();
  }

  @Cron("0 9 * * *", { timeZone: "Europe/Moscow" })
  async flushPendingIncident() {
    if (partnerSheetQuietTime()) return;
    let stored: { value: string } | null = null;
    try {
      stored = await this.prisma.systemSetting.findUnique({
        where: { key: INCIDENT_KEY },
      });
    } catch {
      this.logger.error("Partner sheet pending incident read unavailable");
    }
    let incident = this.volatileIncident;
    if (stored) {
      try {
        incident = JSON.parse(stored.value);
      } catch {
        return;
      } // Legacy ISO reservation means a delivery was already attempted.
    }
    if (incident?.version !== 1 || incident.delivery !== "pending") return;
    const attempted = { ...incident, delivery: "attempted" as const };
    if (stored) {
      try {
        const reserved = await this.prisma.systemSetting.updateMany({
          where: { key: INCIDENT_KEY, value: stored.value },
          data: { value: JSON.stringify(attempted) },
        });
        if (reserved.count !== 1) return;
      } catch {
        this.logger.error("Partner sheet alert reservation unavailable");
        return;
      }
    } else this.volatileIncident = attempted;
    // Reserve before sending, including an uncertain response. A restart must
    // not repeat a fan-out. A recovered incident is removed by verified sync.
    const safeStages = [
      "чтение источника",
      "чтение и двойная сверка Google-таблицы",
      "сопоставление с кабинетом",
      "проверка полноты и сохранение снимка",
    ];
    const stage = safeStages.includes(incident.stage)
      ? incident.stage
      : "проверка источника";
    const sent = await this.alerts.sendSafely(
      `🔴 Агентства v1/2: синхронизация с Google-таблицей не прошла проверку. Этап: ${stage}. Непроверенные данные не применены; прежние данные не перезаписывались. Проверьте доступ к источнику, структуру листов, полноту агентств и суммы. Основная база и amoCRM не изменялись.`,
      {
        dedupKey: stored
          ? `${INCIDENT_KEY}:${incident.startedAt}`
          : INCIDENT_KEY,
        cooldownMs: 24 * 60 * 60 * 1000,
      },
    );
    if (!sent) this.logger.warn("Partner sheet alert delivery unconfirmed");
  }

  private async load() {
    try {
      this.failureStage = "чтение и двойная сверка Google-таблицы";
      const source = await this.loadSource();
      this.failureStage = "сопоставление с кабинетом";
      const organizations = await this.prisma.agency.findMany({
        select: {
          id: true,
          name: true,
          legalName: true,
          inn: true,
          phone: true,
          email: true,
          address: true,
          legalAddress: true,
          bankName: true,
          bankBik: true,
          bankAccount: true,
          correspondentAccount: true,
          updatedAt: true,
        },
        take: 10001,
        orderBy: { id: "asc" },
      });
      if (organizations.length > 10000) throw new Error("TARGET_LIMIT");
      const value = buildView(source, organizations, new Date().toISOString());
      this.failureStage = "проверка полноты и сохранение снимка";
      // Validate the complete projection, prevent silent loss of existing
      // agencies, and verify storage inside one rollback-capable transaction.
      await this.prisma.$transaction(
        async (tx) => {
          const previous = await tx.systemSetting.findUnique({
            where: { key: SNAPSHOT_KEY },
          });
          validateView(
            value,
            previous ? decodeSnapshot(previous.value) : undefined,
          );
          const encoded = encodeSnapshot(value);
          await tx.systemSetting.upsert({
            where: { key: SNAPSHOT_KEY },
            create: { key: SNAPSHOT_KEY, value: encoded },
            update: { value: encoded },
          });
          const readback = await tx.systemSetting.findUnique({
            where: { key: SNAPSHOT_KEY },
          });
          if (!readback || readback.value !== encoded)
            throw new Error("SNAPSHOT_READBACK_FAILED");
          decodeSnapshot(readback.value);
          await tx.systemSetting.deleteMany({ where: { key: INCIDENT_KEY } });
        },
        { isolationLevel: "Serializable" },
      );
      this.cached = { expires: Date.now() + 60000, value };
      this.volatileIncident = null;
      return value;
    } catch {
      if (this.cached) this.cached.expires = 0;
      // Do not leak source payloads, service-account errors or DB details.
      throw new ServiceUnavailableException(
        "Не удалось обновить таблицу агентств. Повторите позже; текущая база не изменена.",
      );
    }
  }

  private loadSource() {
    return readSource(
      JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "{}"),
    );
  }
}
