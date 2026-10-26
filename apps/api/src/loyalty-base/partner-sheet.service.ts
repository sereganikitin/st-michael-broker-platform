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

@Injectable()
export class PartnerSheetService {
  private cached: { expires: number; value: any } | null = null;
  private pending: Promise<any> | null = null;
  private readonly logger = new Logger(PartnerSheetService.name);
  private failureStage = "чтение источника";
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
    const incident = new Date().toISOString();
    let durable = true;
    try {
      // Reserve before the send: an uncertain Telegram response must not
      // produce the same fan-out every subsequent run or after an API restart.
      await this.prisma.systemSetting.create({
        data: { key: INCIDENT_KEY, value: incident },
      });
    } catch (error) {
      if ((error as { code?: string }).code === "P2002") return;
      durable = false;
      this.logger.error("Partner sheet incident persistence unavailable");
      // DB failure cannot create a durable reservation; the alert service
      // still suppresses repeats in this process.
    }
    const sent = await this.alerts.sendSafely(
      `🔴 Агентства v1/2: синхронизация с Google-таблицей не прошла проверку. Этап: ${this.failureStage}. Непроверенные данные не применены; прежние данные не перезаписывались. Проверьте доступ к источнику, структуру листов, полноту агентств и суммы. Основная база и amoCRM не изменялись.`,
      {
        dedupKey: durable ? `${INCIDENT_KEY}:${incident}` : INCIDENT_KEY,
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
