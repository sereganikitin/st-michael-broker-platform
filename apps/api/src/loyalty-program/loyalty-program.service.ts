import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaClient } from "@st-michael/database";
import type { CurrentUserPayload } from "../auth/current-user.decorator";
import { LoyaltyPermissionService } from "../loyalty-workflow/loyalty-permission.service";
import {
  PROGRAM_2026_PARTNERS,
  PROGRAM_2026_SOURCE,
} from "./program-2026-partners";
import {
  matchAllPartners,
  type AnnaCatalogEntry,
} from "./match-word-to-anna";
import { LoyaltyProgramDecideDto } from "./loyalty-program.dto";

type StoredMatch = {
  partnerKey: string;
  organizationId: string | null;
  personId: string | null;
  status: string;
  decidedById: string | null;
  decidedAt: Date | null;
};

@Injectable()
export class LoyaltyProgramService {
  constructor(
    @Inject("PrismaClient") private readonly prisma: PrismaClient,
    private readonly permissions: LoyaltyPermissionService,
  ) {}

  async overlay(user: CurrentUserPayload, list?: "SOLD_2026" | "SLEEPING") {
    await this.permissions.require(user, "READ_ALL");
    const partners = PROGRAM_2026_PARTNERS.filter((row) =>
      list ? row.list === list : true,
    );
    const catalog = await this.loadAnnaCatalog();
    const auto = matchAllPartners(partners, catalog);
    const stored = await this.loadStored();
    const storedByKey = new Map(stored.map((row) => [row.partnerKey, row]));
    const catalogById = new Map(catalog.map((row) => [row.id, row]));

    const rows = partners.map((partner) => {
      const suggestion = auto.find((row) => row.partnerKey === partner.key);
      const saved = storedByKey.get(partner.key);
      if (saved?.status === "SKIPPED") {
        return {
          partner,
          match: {
            status: "SKIPPED" as const,
            entityType: null,
            entityId: null,
            entityName: null,
            candidates: suggestion?.candidates || [],
            source: "SAVED" as const,
          },
        };
      }
      if (saved?.organizationId || saved?.personId) {
        const id = saved.organizationId || saved.personId || "";
        const entry = catalogById.get(id);
        return {
          partner,
          match: {
            status: saved.status === "AUTO" ? ("AUTO" as const) : ("MANUAL" as const),
            entityType: saved.organizationId
              ? ("AGENCY" as const)
              : ("BROKER" as const),
            entityId: id,
            entityName: entry?.names[0] || null,
            candidates: suggestion?.candidates || [],
            source: "SAVED" as const,
          },
        };
      }
      const status = suggestion?.status || "UNMATCHED";
      const top = suggestion?.candidates[0];
      return {
        partner,
        match: {
          status,
          entityType: status === "AUTO" ? top?.entityType || null : null,
          entityId: status === "AUTO" ? top?.id || null : null,
          entityName: status === "AUTO" ? top?.name || null : null,
          candidates: suggestion?.candidates || [],
          source: "SUGGESTED" as const,
        },
      };
    });

    const working = PROGRAM_2026_PARTNERS.filter((row) => row.list === "SOLD_2026");
    const workingRows = rows.filter((row) => row.partner.list === "SOLD_2026");
    const extracted = {
      soldPartners: working.length,
      dduCount: working.reduce((sum, row) => sum + row.dduCount, 0),
      soldMln: Math.round(
        working.reduce((sum, row) => sum + row.soldMln, 0) * 10,
      ) / 10,
    };
    return {
      source: {
        ...PROGRAM_2026_SOURCE,
        extracted,
        discrepancy: {
          soldPartners:
            PROGRAM_2026_SOURCE.declared.soldPartners - extracted.soldPartners,
          dduCount: PROGRAM_2026_SOURCE.declared.dduCount - extracted.dduCount,
          soldMln: Math.round(
            (PROGRAM_2026_SOURCE.declared.soldMln - extracted.soldMln) * 10,
          ) / 10,
        },
      },
      program: {
        from: "2026-01-01",
        until: "2027-01-31",
        note: "Справочник звонков по программе лояльности. Это не колонка «Сделки» в базе Анны.",
      },
      counts: {
        sold: working.length,
        sleeping: PROGRAM_2026_PARTNERS.filter((row) => row.list === "SLEEPING")
          .length,
        auto: workingRows.filter((row) => row.match.status === "AUTO").length,
        manual: workingRows.filter((row) => row.match.status === "MANUAL").length,
        ambiguous: workingRows.filter((row) => row.match.status === "AMBIGUOUS")
          .length,
        unmatched: workingRows.filter((row) => row.match.status === "UNMATCHED")
          .length,
      },
      rows,
    };
  }

  async decide(user: CurrentUserPayload, body: LoyaltyProgramDecideDto) {
    await this.permissions.requireAll(user, ["READ_ALL", "REFERENCE_MANAGE"]);
    const partner = PROGRAM_2026_PARTNERS.find((row) => row.key === body.partnerKey);
    if (!partner) throw new NotFoundException("Партнёр программы не найден");

    const status = body.status || "MANUAL";
    if (status === "SKIPPED") {
      await this.upsertMatch({
        partnerKey: partner.key,
        organizationId: null,
        personId: null,
        status: "SKIPPED",
        decidedById: user.id,
        decidedAt: new Date(),
      });
      return { ok: true, partnerKey: partner.key, status: "SKIPPED" };
    }

    if (!body.organizationId && !body.personId) {
      throw new BadRequestException("Нужно выбрать карточку Анны или пропустить");
    }
    if (body.organizationId && body.personId) {
      throw new BadRequestException("Можно привязать либо агентство, либо брокера");
    }

    const catalog = await this.loadAnnaCatalog();
    const targetId = body.organizationId || body.personId || "";
    const entry = catalog.find((row) => row.id === targetId);
    if (!entry) throw new NotFoundException("Карточка Анны не найдена");
    if (body.organizationId && entry.entityType !== "AGENCY") {
      throw new BadRequestException("organizationId должен указывать на агентство");
    }
    if (body.personId && entry.entityType !== "BROKER") {
      throw new BadRequestException("personId должен указывать на брокера");
    }

    await this.upsertMatch({
      partnerKey: partner.key,
      organizationId: body.organizationId || null,
      personId: body.personId || null,
      status: "MANUAL",
      decidedById: user.id,
      decidedAt: new Date(),
    });
    return {
      ok: true,
      partnerKey: partner.key,
      status: "MANUAL",
      entityType: entry.entityType,
      entityId: entry.id,
      entityName: entry.names[0] || null,
    };
  }

  private matches() {
    return (this.prisma as any).loyaltyProgramMatch as {
      findMany: (args: unknown) => Promise<StoredMatch[]>;
      upsert: (args: unknown) => Promise<StoredMatch>;
    };
  }

  private async loadStored(): Promise<StoredMatch[]> {
    return this.matches().findMany({
      select: {
        partnerKey: true,
        organizationId: true,
        personId: true,
        status: true,
        decidedById: true,
        decidedAt: true,
      },
    });
  }

  private async upsertMatch(row: StoredMatch) {
    await this.matches().upsert({
      where: { partnerKey: row.partnerKey },
      create: {
        partnerKey: row.partnerKey,
        organizationId: row.organizationId,
        personId: row.personId,
        status: row.status,
        decidedById: row.decidedById,
        decidedAt: row.decidedAt,
      },
      update: {
        organizationId: row.organizationId,
        personId: row.personId,
        status: row.status,
        decidedById: row.decidedById,
        decidedAt: row.decidedAt,
      },
    });
  }

  private async loadAnnaCatalog(): Promise<AnnaCatalogEntry[]> {
    const dataset = await (this.prisma as any).loyaltyDataset.findFirst({
      where: {
        code: "ANNA",
        base: "ANNA",
        archivedAt: null,
        activeSnapshot: { is: { status: "PUBLISHED" } },
      },
      select: { id: true, activeSnapshotId: true },
    });
    if (!dataset?.activeSnapshotId) return [];

    const records = await (this.prisma as any).loyaltySourceRecord.findMany({
      where: {
        snapshotId: dataset.activeSnapshotId,
        sourceArchivedAt: null,
        entityType: { in: ["AGENCY", "BROKER"] },
      },
      select: {
        entityType: true,
        displayName: true,
        attributes: true,
        organizationId: true,
        personId: true,
        organization: { select: { manualDisplayName: true } },
        person: { select: { manualDisplayName: true } },
      },
    });

    const byId = new Map<string, AnnaCatalogEntry>();
    for (const record of records) {
      const id =
        record.entityType === "AGENCY"
          ? record.organizationId
          : record.personId;
      if (!id) continue;
      const attributes = (record.attributes || {}) as Record<string, unknown>;
      const extra = [
        record.displayName,
        record.organization?.manualDisplayName,
        record.person?.manualDisplayName,
        typeof attributes.company === "string" ? attributes.company : null,
        ...(Array.isArray(attributes.aliases)
          ? attributes.aliases.filter((item): item is string => typeof item === "string")
          : []),
        ...(Array.isArray(attributes.companyAliases)
          ? attributes.companyAliases.filter(
              (item): item is string => typeof item === "string",
            )
          : []),
      ].filter((item): item is string => Boolean(item && item.trim()));
      const current = byId.get(id);
      if (current) {
        current.names = Array.from(new Set([...current.names, ...extra]));
      } else {
        byId.set(id, {
          id,
          entityType: record.entityType,
          names: Array.from(new Set(extra)),
        });
      }
    }
    return Array.from(byId.values());
  }
}
