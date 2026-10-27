import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { PrismaClient } from "@st-michael/database";
import { createHash } from "node:crypto";
import { CurrentUserPayload } from "../auth/current-user.decorator";
import { LoyaltyPermissionService } from "./loyalty-permission.service";
import { AgencyCampaignOutcomeDto } from "./agency-campaign-outcome.dto";

const actorInclude = { actor: { select: { id: true, fullName: true } } };
const publicRow = (row: any) => {
  const { submissionId, requestHash, ...rest } = row;
  return rest;
};
export function validateCampaignOutcome(
  body: AgencyCampaignOutcomeDto,
  now: Date,
) {
  const allowed =
    body.kind === "REACTIVATION"
      ? ["REACTIVATED", "CANCELLED"]
      : ["PLANNED", "HELD", "CANCELLED"];
  if (!allowed.includes(body.status))
    throw new BadRequestException("Недопустимый статус результата");
  if (!body.basis.trim())
    throw new BadRequestException("Укажите основание результата");
  if (body.expectedVersion && !body.correctionReason?.trim())
    throw new BadRequestException("Укажите причину изменения");
  const at = new Date(body.occurredAt);
  if (!Number.isFinite(at.getTime()))
    throw new BadRequestException("Некорректная дата события");
  if (body.status !== "PLANNED" && at > now)
    throw new BadRequestException("Факт или отмена не могут быть в будущем");
}

// Select latest revision before applying period/operator filters: an older
// planned/held revision must never reappear when its correction falls outside them.
export function campaignOutcomeProjection(
  rows: any[],
  from: Date,
  to: Date,
  actorId?: string,
) {
  const latest = new Map<string, any>();
  for (const row of rows)
    if (
      !latest.has(row.eventId) ||
      latest.get(row.eventId).version < row.version
    )
      latest.set(row.eventId, row);
  const current = [...latest.values()].filter(
    (r) =>
      new Date(r.occurredAt) >= from &&
      new Date(r.occurredAt) < to &&
      (!actorId || r.actorId === actorId),
  );
  const plans = new Map<string, any>();
  for (const row of rows)
    if (
      row.status === "PLANNED" &&
      (!plans.has(row.eventId) || plans.get(row.eventId).version < row.version)
    )
      plans.set(row.eventId, row);
  const scheduled = [...plans.values()].filter(
    (r) =>
      new Date(r.occurredAt) >= from &&
      new Date(r.occurredAt) < to &&
      (!actorId || r.actorId === actorId),
  );
  return {
    events: current.map(publicRow),
    scheduled: scheduled.map(publicRow),
    counts: {
      meetingsScheduled: scheduled.filter((r) => r.kind === "MEETING").length,
      toursScheduled: scheduled.filter((r) => r.kind === "TOUR").length,
      meetingsPlanned: current.filter(
        (r) => r.kind === "MEETING" && r.status === "PLANNED",
      ).length,
      meetingsHeld: current.filter(
        (r) => r.kind === "MEETING" && r.status === "HELD",
      ).length,
      toursPlanned: current.filter(
        (r) => r.kind === "TOUR" && r.status === "PLANNED",
      ).length,
      toursHeld: current.filter((r) => r.kind === "TOUR" && r.status === "HELD")
        .length,
      reactivations: current.filter(
        (r) => r.kind === "REACTIVATION" && r.status === "REACTIVATED",
      ).length,
      cancelled: current.filter((r) => r.status === "CANCELLED").length,
    },
  };
}

export function campaignOutcomeCsv(
  result: ReturnType<typeof campaignOutcomeProjection>,
) {
  const rows: unknown[][] = [
    [
      "Срез",
      "Агентство ID",
      "Кампания",
      "Событие ID",
      "Версия",
      "Тип",
      "Статус",
      "Дата события UTC",
      "Автор",
      "Основание",
      "Комментарий",
    ],
  ];
  for (const [label, events] of [
    ["Текущий результат", result.events],
    ["Последняя версия плана", result.scheduled],
  ] as const)
    for (const r of events)
      rows.push([
        label,
        r.assignment?.ourAgencyId,
        r.assignment?.campaign?.name,
        r.eventId,
        r.version,
        r.kind,
        r.status,
        new Date(r.occurredAt).toISOString(),
        r.actor?.fullName,
        r.basis,
        r.comment,
      ]);
  const cell = (value: unknown) => {
    let text = String(value ?? "");
    if (/^[\s]*[=+@-]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  };
  return "\uFEFF" + rows.map((r) => r.map(cell).join(";")).join("\r\n");
}

@Injectable()
export class AgencyCampaignOutcomeService {
  private get db() {
    return this.prisma as any;
  }
  constructor(
    @Inject("PrismaClient") private readonly prisma: PrismaClient,
    private readonly permissions: LoyaltyPermissionService,
  ) {}

  private async assignment(
    db: any,
    agencyId: string,
    assignmentId: string,
    user: CurrentUserPayload,
    write: boolean,
  ) {
    this.permissions.requireStaff(user);
    const assignment = await db.loyaltyCallAssignment.findFirst({
      where: { id: assignmentId, ourAgencyId: agencyId },
    });
    if (!assignment)
      throw new NotFoundException("Назначение агентства не найдено");
    const access = await this.permissions.effective(user);
    const own = assignment.assignedToId === user.id;
    if (write) {
      if (
        !(
          own &&
          assignment.status !== "CANCELLED" &&
          access.permissions.includes("CALL_EXECUTE")
        ) &&
        !(
          access.permissions.includes("READ_ALL") &&
          access.permissions.includes("CALL_ASSIGN")
        )
      )
        throw new ForbiddenException(
          "Нет права фиксировать результат этого назначения",
        );
    } else if (
      !access.permissions.includes("READ_ALL") &&
      !(
        own &&
        (access.permissions.includes("CALL_EXECUTE") ||
          access.permissions.includes("READ_OWN_QUEUE"))
      )
    ) {
      throw new ForbiddenException("Нет доступа к результатам назначения");
    }
    return assignment;
  }

  async list(agencyId: string, assignmentId: string, user: CurrentUserPayload) {
    await this.assignment(this.db, agencyId, assignmentId, user, false);
    const rows = await this.db.agencyCampaignOutcome.findMany({
      where: { assignmentId },
      orderBy: [{ createdAt: "desc" }, { version: "desc" }],
      include: actorInclude,
      take: 2001,
    });
    if (rows.length > 2000)
      throw new BadRequestException(
        "Слишком большая история результатов: обратитесь к руководителю",
      );
    return { history: rows.map(publicRow) };
  }

  async save(
    agencyId: string,
    assignmentId: string,
    body: AgencyCampaignOutcomeDto,
    user: CurrentUserPayload,
  ) {
    validateCampaignOutcome(body, new Date());
    const normalized = {
      ...body,
      occurredAt: new Date(body.occurredAt).toISOString(),
      basis: body.basis.trim(),
      comment: body.comment.trim(),
      correctionReason: body.correctionReason?.trim() || null,
    };
    const hash = createHash("sha256")
      .update(
        JSON.stringify([
          agencyId,
          assignmentId,
          user.id,
          normalized.eventId,
          normalized.expectedVersion,
          normalized.kind,
          normalized.status,
          normalized.occurredAt,
          normalized.basis,
          normalized.comment,
          normalized.correctionReason,
        ]),
      )
      .digest("hex");
    return this.db.$transaction(async (tx: any) => {
      await tx.$queryRawUnsafe(
        "SELECT id FROM loyalty_call_assignments WHERE id=$1 FOR UPDATE",
        assignmentId,
      );
      // Ownership is read after the lock, including a concurrent reassignment.
      await this.assignment(tx, agencyId, assignmentId, user, true);
      const retry = await tx.agencyCampaignOutcome.findUnique({
        where: { submissionId: body.submissionId },
        include: actorInclude,
      });
      if (retry) {
        if (retry.requestHash !== hash)
          throw new ConflictException(
            "Идентификатор уже использован для другой записи",
          );
        return publicRow(retry);
      }
      const previous = await tx.agencyCampaignOutcome.findFirst({
        where: { eventId: body.eventId },
        orderBy: { version: "desc" },
      });
      if (previous && previous.assignmentId !== assignmentId)
        throw new ConflictException("Событие принадлежит другому назначению");
      if ((previous?.version ?? 0) !== body.expectedVersion)
        throw new ConflictException(
          "Результат изменён другим сотрудником. Обновите историю; черновик сохранён",
        );
      if (previous && previous.kind !== body.kind)
        throw new ConflictException(
          "Тип события нельзя менять: отмените запись и создайте новую",
        );
      const row = await tx.agencyCampaignOutcome.create({
        data: {
          assignmentId,
          eventId: body.eventId,
          version: body.expectedVersion + 1,
          kind: body.kind,
          status: body.status,
          occurredAt: new Date(normalized.occurredAt),
          basis: normalized.basis,
          comment: normalized.comment,
          correctionReason: normalized.correctionReason,
          actorId: user.id,
          submissionId: body.submissionId,
          requestHash: hash,
        },
        include: actorInclude,
      });
      await tx.loyaltyWorkflowAudit.create({
        data: {
          actorId: user.id,
          action: "AGENCY_CAMPAIGN_OUTCOME_RECORDED",
          entityType: "AGENCY",
          entityId: agencyId,
          before: { eventId: body.eventId, version: body.expectedVersion },
          after: {
            outcomeId: row.id,
            eventId: row.eventId,
            version: row.version,
            assignmentId,
          },
        },
      });
      return publicRow(row);
    });
  }
}
