import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { PrismaClient } from "@st-michael/database";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { CurrentUserPayload } from "../auth/current-user.decorator";
import { LoyaltyBaseService } from "../loyalty-base/loyalty-base.service";
import { LoyaltyPermissionService } from "./loyalty-permission.service";
import { LoyaltyWorkflowService } from "./loyalty-workflow.service";
import {
  AgencyCallControlDto,
  AgencyClaimDto,
  AgencyContactsDto,
  AgencyPilotDto,
  AgencyReassignDto,
  AgencyScriptDto,
  AgencyWorkspaceQuery,
} from "./agency-workspace.dto";

const { decodeSnapshot } = require(
  join(__dirname, "../../../../scripts/partner-sheet/snapshot.cjs"),
);
const SCRIPT_KEY = "agency-v1-2:approved-script";
const OPEN = ["PENDING", "IN_PROGRESS"];
const CONVERSATION = new Set([
  "INFORMED",
  "SEND_INFORMATION",
  "BROKER_TOUR_SCHEDULED",
  "CALLBACK",
  "AGREEMENTS_EXIST",
  "COOPERATION_AGREED",
  "COOPERATION_DECLINED",
  "DO_NOT_CALL",
]);

function attemptsForOperator(attempts: any[], operatorId?: string) {
  if (!operatorId) return attempts;
  const byId = new Map(attempts.map((a) => [a.id, a]));
  return attempts.filter((attempt) => {
    const seen = new Set();
    let root = attempt;
    while (
      root.correctsAttemptId &&
      byId.has(root.correctsAttemptId) &&
      !seen.has(root.id)
    ) {
      seen.add(root.id);
      root = byId.get(root.correctsAttemptId);
    }
    return (root.operatorId ?? root.operator?.id) === operatorId;
  });
}

// Only verified canonical matches are usable targets. Sheet coordinates and
// names remain presentation data, never foreign keys for operational history.
export function agencySourceCards(items: any[]) {
  const cards = new Map<string, any>();
  for (const item of items) {
    if (item.status !== "MATCHED" || !item.matchedAgency?.id) continue;
    const id = item.matchedAgency.id;
    const card = cards.get(id) ?? {
      id,
      name: item.matchedAgency.name,
      type: item.type,
      periods: [],
      sourceNames: [],
    };
    card.sourceNames = [...new Set([...card.sourceNames, item.name])];
    for (const period of item.periods ?? []) {
      if (
        !card.periods.some(
          (p: any) => p.tab === period.tab && p.row === period.row,
        )
      )
        card.periods.push(period);
    }
    cards.set(id, card);
  }
  return cards;
}

export function agencyMetrics(cards: any[], from: Date, to: Date, now: Date) {
  const within = (value: any) =>
    value && new Date(value) >= from && new Date(value) < to;
  const assignments = cards.flatMap((c) => c.assignments);
  const attempts = cards.flatMap((c) =>
    c.attempts.map((a: any) => ({ ...a, agencyId: c.id })),
  );
  const superseded = new Set(
    attempts.map((a) => a.correctsAttemptId).filter(Boolean),
  );
  const byId = new Map(attempts.map((a) => [a.id, a]));
  const callTime = (attempt: any) => {
    const seen = new Set();
    while (
      attempt.correctsAttemptId &&
      byId.has(attempt.correctsAttemptId) &&
      !seen.has(attempt.id)
    ) {
      seen.add(attempt.id);
      attempt = byId.get(attempt.correctsAttemptId);
    }
    return attempt.occurredAt;
  };
  const effective = attempts.filter(
    (a) => !superseded.has(a.id) && within(callTime(a)),
  );
  const attempted = new Set(effective.map((a) => a.agencyId));
  const spoken = new Set(
    effective.filter((a) => CONVERSATION.has(a.result)).map((a) => a.agencyId),
  );
  const tasks = cards.flatMap((c) =>
    c.tasks.map((t: any) => ({ ...t, agencyId: c.id })),
  );
  const due = tasks.filter(
    (t: any) => t.status !== "CANCELLED" && within(t.dueAt),
  );
  const onTime = due.filter(
    (t: any) =>
      t.status === "COMPLETED" &&
      t.completedAt &&
      new Date(t.completedAt) <= new Date(t.dueAt),
  );
  const overdue = tasks.filter(
    (t: any) => t.status === "OPEN" && t.dueAt && new Date(t.dueAt) < now,
  );
  const agreements = effective.filter(
    (a) =>
      [
        "BROKER_TOUR_SCHEDULED",
        "AGREEMENTS_EXIST",
        "COOPERATION_AGREED",
      ].includes(a.result) &&
      a.nextStep &&
      a.nextActionAt,
  );
  const assignedIds = [
    ...new Set<string>(
      assignments
        .filter((a) => new Date(a.assignedAt) < to)
        .map((a) => a.ourAgencyId),
    ),
  ];
  const event = (item: any, kind: string) => ({
    agencyId: item.agencyId,
    eventId: item.id,
    kind,
  });
  return {
    assignedAgencies: assignedIds.length,
    attemptedAgencies: attempted.size,
    attempts: attempts.filter(
      (a) => !a.correctsAttemptId && within(a.occurredAt),
    ).length,
    conversationAgencies: spoken.size,
    agreements: agreements.length,
    tasksDue: due.length,
    tasksOnTime: onTime.length,
    overdue: overdue.length,
    coverage: {
      numerator: attempted.size,
      denominator: assignedIds.length,
      ratio: assignedIds.length ? attempted.size / assignedIds.length : null,
    },
    contact: {
      numerator: spoken.size,
      denominator: attempted.size,
      ratio: attempted.size ? spoken.size / attempted.size : null,
      source: "OPERATOR",
    },
    agreementRate: {
      numerator: agreements.length,
      denominator: effective.filter((a) => CONVERSATION.has(a.result)).length,
    },
    onTime: {
      numerator: onTime.length,
      denominator: due.length,
      ratio: due.length ? onTime.length / due.length : null,
    },
    evidence: {
      assignedAgencies: assignedIds.map((agencyId) => ({
        agencyId,
        eventId: agencyId,
        kind: "AGENCY",
      })),
      attemptedAgencies: [...attempted].map((agencyId) => ({
        agencyId,
        eventId: agencyId,
        kind: "AGENCY",
      })),
      attempts: attempts
        .filter((a) => !a.correctsAttemptId && within(a.occurredAt))
        .map((a) => event(a, "ATTEMPT")),
      conversationAgencies: [...spoken].map((agencyId) => ({
        agencyId,
        eventId: agencyId,
        kind: "AGENCY",
      })),
      agreements: agreements.map((a) => event(a, "ATTEMPT")),
      tasksDue: due.map((t: any) => event(t, "TASK")),
      tasksOnTime: onTime.map((t: any) => event(t, "TASK")),
      overdue: overdue.map((t: any) => event(t, "TASK")),
    },
    // These are operator-reported conversations, not verified Mango connections.
    conversationSource: "OPERATOR",
  };
}

@Injectable()
export class AgencyWorkspaceService {
  constructor(
    @Inject("PrismaClient") private readonly db: PrismaClient,
    private readonly permissions: LoyaltyPermissionService,
    private readonly workflow: LoyaltyWorkflowService,
    private readonly base: LoyaltyBaseService,
  ) {}

  private async snapshot() {
    const saved = await this.db.systemSetting.findUnique({
      where: { key: "partner-sheet-v1-2:verified-snapshot" },
    });
    if (!saved)
      throw new ServiceUnavailableException(
        "Проверенный снимок ещё не загружен",
      );
    // Read-only: opening this workspace never triggers Google IO or a sync.
    return decodeSnapshot(saved.value);
  }

  private async script() {
    const saved = await this.db.systemSetting.findUnique({
      where: { key: SCRIPT_KEY },
    });
    if (!saved)
      return {
        version: 0,
        text: "",
        owner: "",
        validUntil: null,
        approvedAt: null,
        current: false,
      };
    const value = JSON.parse(saved.value);
    return {
      ...value,
      current: new Date(value.validUntil).getTime() > Date.now(),
    };
  }

  async list(query: AgencyWorkspaceQuery, user: CurrentUserPayload) {
    await this.permissions.requireAny(user, [
      "READ_ALL",
      "READ_OWN_QUEUE",
      "CALL_EXECUTE",
    ]);
    const effective = await this.permissions.effective(user);
    const all =
      user.role === "ADMIN" || effective.permissions.includes("READ_ALL");
    if (query.assigneeId && query.assigneeId !== user.id)
      await this.permissions.require(user, "READ_ALL");
    const assigneeId = all ? query.assigneeId : user.id;
    const snapshot = await this.snapshot();
    const sources = agencySourceCards(snapshot.items);
    const ids = [...sources.keys()];
    const [assignments, script, incident] = await Promise.all([
      this.db.loyaltyCallAssignment.findMany({
        where: {
          ourAgencyId: { not: null },
          OR: [
            { ourAgencyId: { in: ids } },
            {
              campaign: {
                filterSnapshot: {
                  path: ["agencyWorkspace", "source"],
                  equals: "AGENCIES_V1_2",
                },
              },
            },
          ],
          ...(assigneeId
            ? {
                AND: [
                  {
                    OR: [
                      { assignedToId: assigneeId },
                      { attempts: { some: { operatorId: assigneeId } } },
                    ],
                  },
                ],
              }
            : {}),
          ...(query.campaignId ? { campaignId: query.campaignId } : {}),
        },
        include: {
          campaign: { select: { id: true, name: true, status: true } },
          assignedTo: { select: { id: true, fullName: true } },
          attempts: {
            orderBy: { occurredAt: "desc" },
            include: { operator: { select: { id: true, fullName: true } } },
          },
          tasks: {
            include: { assignedTo: { select: { id: true, fullName: true } } },
          },
        },
        orderBy: { assignedAt: "desc" },
        take: 10001,
      }),
      this.script(),
      this.db.systemSetting.findUnique({
        where: { key: "partner-sheet-v1-2:incident" },
        select: { key: true },
      }),
    ]);
    if (assignments.length > 10000)
      throw new BadRequestException(
        "Уточните кампанию или сотрудника: больше 10000 назначений",
      );
    const agencies = await this.db.agency.findMany({
      where: {
        id: {
          in: [
            ...new Set([
              ...ids,
              ...assignments.map((a) => a.ourAgencyId!).filter(Boolean),
            ]),
          ],
        },
      },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        updatedAt: true,
        doNotCall: true,
        callControlVersion: true,
        callControlReason: true,
        callContacts: true,
        callContactsVersion: true,
      },
    } as any);
    const visibleIds = new Set(assignments.map((a) => a.ourAgencyId));
    const allCards = agencies
      .filter(
        (a) =>
          (all && !assigneeId && !query.campaignId) || visibleIds.has(a.id),
      )
      .map((a) => {
        const own = assignments.filter((x) => x.ourAgencyId === a.id);
        return {
          ...(sources.get(a.id) ?? {
            periods: [],
            sourceNames: [],
            type: "Связь с источником требует проверки",
          }),
          ...a,
          sourceMatched: sources.has(a.id),
          assignments: own.map(({ attempts, tasks, ...assignment }) => {
            const { workSessionHash, ...publicAssignment } = assignment as any;
            return { ...publicAssignment, claimed: Boolean(workSessionHash) };
          }),
          attempts: attemptsForOperator(
            own.flatMap((x) => x.attempts),
            assigneeId,
          ),
          tasks: own
            .flatMap((x) => x.tasks)
            .filter((t) => !assigneeId || t.assignedToId === assigneeId),
        };
      });
    const filterOptions = {
      agencies: allCards.map((card) => ({ id: card.id, name: card.name })),
      campaigns: [
        ...new Map(
          allCards.flatMap((card) =>
            card.assignments.map(
              (a) =>
                [
                  a.campaign.id,
                  { id: a.campaign.id, name: a.campaign.name },
                ] as const,
            ),
          ),
        ).values(),
      ],
    };
    const cards = allCards.filter(
      (card) =>
        (!query.agencyId || card.id === query.agencyId) &&
        (!query.agencyType || card.type === query.agencyType),
    );
    // Contact context and employee performance are different projections.
    // The current assignee needs prior conversations; those calls still belong
    // to their original operators in metrics/export.
    const contextIds =
      assigneeId || query.campaignId
        ? cards
            .filter(
              (card) =>
                all ||
                card.assignments.some(
                  (a) =>
                    a.assignedToId === user.id &&
                    OPEN.includes(a.status) &&
                    a.campaign.status === "ACTIVE",
                ),
            )
            .map((card) => card.id)
        : [];
    if (contextIds.length) {
      const history = await this.db.loyaltyCallAttempt.findMany({
        where: { assignment: { ourAgencyId: { in: contextIds } } },
        include: {
          assignment: { select: { ourAgencyId: true } },
          operator: { select: { id: true, fullName: true } },
        },
        orderBy: { occurredAt: "desc" },
        take: 2001,
      });
      if (history.length > 2000)
        throw new BadRequestException(
          "История превышает 2000 событий. Уточните агентство или кампанию",
        );
      for (const card of cards)
        if (contextIds.includes(card.id))
          (card as any).contextAttempts = history
            .filter((row) => row.assignment.ourAgencyId === card.id)
            .map(({ assignment, ...attempt }) => attempt);
    }
    const now = new Date();
    const from = query.from
      ? new Date(query.from)
      : new Date(
          `${new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).format(now)}T00:00:00+03:00`,
        );
    const to = query.to
      ? new Date(query.to)
      : new Date(from.getTime() + 86400000);
    if (
      !(to > from) ||
      (query.from && !/(Z|[+-]\d{2}:\d{2})$/.test(query.from)) ||
      (query.to && !/(Z|[+-]\d{2}:\d{2})$/.test(query.to))
    )
      throw new BadRequestException(
        "Нужен период с часовым поясом, конец позже начала",
      );
    const metrics = agencyMetrics(cards, from, to, now);
    const quality: Record<string, string[]> = {
      noPhone: cards
        .filter(
          (c) =>
            !c.phone &&
            !(c.callContacts || []).some(
              (p: any) => !p.archived && (p.phone || p.alternatePhone),
            ),
        )
        .map((c) => c.id),
      noOwner: cards
        .filter((c) => !c.assignments.some((a) => OPEN.includes(a.status)))
        .map((c) => c.id),
      invalidPhone: cards
        .filter((c) =>
          c.attempts.some(
            (a) =>
              a.result === "INVALID_PHONE" &&
              !c.attempts.some((b) => b.correctsAttemptId === a.id),
          ),
        )
        .map((c) => c.id),
      missingNextAction: cards
        .filter((c) =>
          c.attempts.some(
            (a) =>
              [
                "CALLBACK",
                "SEND_INFORMATION",
                "BROKER_TOUR_SCHEDULED",
                "AGREEMENTS_EXIST",
                "COOPERATION_AGREED",
              ].includes(a.result) &&
              !c.attempts.some((b) => b.correctsAttemptId === a.id) &&
              (!a.nextStep || !a.nextActionAt),
          ),
        )
        .map((c) => c.id),
      scriptNotCurrent: script.current ? [] : cards.map((c) => c.id),
    };
    for (const [key, ids] of Object.entries(quality))
      (metrics.evidence as any)[key] = ids.map((agencyId) => ({
        agencyId,
        eventId: agencyId,
        kind: "AGENCY",
      }));
    const workload = new Map<
      string,
      { id: string; name: string; open: number; overdue: number }
    >();
    for (const card of cards) {
      for (const assignment of card.assignments)
        if (
          OPEN.includes(assignment.status) &&
          assignment.campaign.status === "ACTIVE"
        ) {
          const entry = workload.get(assignment.assignedToId) || {
            id: assignment.assignedToId,
            name: assignment.assignedTo.fullName,
            open: 0,
            overdue: 0,
          };
          entry.open++;
          workload.set(entry.id, entry);
        }
      for (const task of card.tasks)
        if (
          task.status === "OPEN" &&
          task.dueAt &&
          new Date(task.dueAt) < now
        ) {
          const entry = workload.get(task.assignedToId) || {
            id: task.assignedToId,
            name: task.assignedTo.fullName,
            open: 0,
            overdue: 0,
          };
          entry.overdue++;
          workload.set(entry.id, entry);
        }
    }
    return {
      cards,
      filterOptions,
      script,
      metrics,
      quality,
      workload: [...workload.values()],
      period: { from, to, timeZone: "Europe/Moscow" },
      source: {
        loadedAt: snapshot.loadedAt,
        sourceHash: snapshot.sourceHash,
        stale:
          Boolean(incident) ||
          now.getTime() - new Date(snapshot.loadedAt).getTime() > 16 * 3600000,
        reviewCount: all
          ? snapshot.items.filter((i: any) => i.status !== "MATCHED").length
          : null,
      },
      permissions: effective.permissions,
      currentUserId: user.id,
      role: user.role,
    };
  }

  async approveScript(body: AgencyScriptDto, user: CurrentUserPayload) {
    await this.permissions.requireAll(user, ["READ_ALL", "REFERENCE_MANAGE"]);
    if (
      !body.text.trim() ||
      !body.owner.trim() ||
      !/(Z|[+-]\d{2}:\d{2})$/.test(body.validUntil) ||
      new Date(body.validUntil).getTime() <= Date.now()
    )
      throw new BadRequestException(
        "Укажите текст, владельца и будущий срок с часовым поясом",
      );
    return this.db.$transaction(async (tx) => {
      const old = await tx.systemSetting.findUnique({
        where: { key: SCRIPT_KEY },
      });
      if ((old ? JSON.parse(old.value).version : 0) !== body.expectedVersion)
        throw new ConflictException("Скрипт изменился. Обновите страницу");
      const value = {
        version: body.expectedVersion + 1,
        text: body.text.trim(),
        owner: body.owner.trim(),
        validUntil: body.validUntil,
        approvedAt: new Date().toISOString(),
        approvedBy: user.id,
      };
      if (old) {
        const changed = await tx.systemSetting.updateMany({
          where: { key: SCRIPT_KEY, value: old.value },
          data: { value: JSON.stringify(value) },
        });
        if (changed.count !== 1)
          throw new ConflictException("Скрипт изменился");
      } else
        await tx.systemSetting.create({
          data: { key: SCRIPT_KEY, value: JSON.stringify(value) },
        });
      await tx.loyaltyWorkflowAudit.create({
        data: {
          actorId: user.id,
          action: "AGENCY_SCRIPT_APPROVED",
          entityType: "AGENCY_SCRIPT",
          entityId: SCRIPT_KEY,
          after: value,
        },
      } as any);
      return value;
    });
  }

  async pilot(body: AgencyPilotDto, user: CurrentUserPayload) {
    await this.permissions.requireAll(user, ["READ_ALL", "CALL_ASSIGN"]);
    const key = `agency-v1-2:pilot:${body.submissionId}`;
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          user.id,
          body.name.trim(),
          [...body.agencyIds].sort(),
          body.assigneeId,
          body.sourceHash,
        ]),
      )
      .digest("hex");
    const replay = async () => {
      const saved = await this.db.systemSetting.findUnique({ where: { key } });
      if (!saved) return null;
      const previous = JSON.parse(saved.value);
      if (previous.fingerprint !== fingerprint || !previous.campaignId)
        throw new ConflictException(
          "Повторный запрос отличается от сохранённого",
        );
      const campaign = await this.db.loyaltyCallCampaign.findUniqueOrThrow({
        where: { id: previous.campaignId },
      });
      return {
        id: campaign.id,
        version: campaign.version,
        status: campaign.status,
        idempotent: true,
      };
    };
    const previous = await replay();
    if (previous) return previous;
    const snapshot = await this.snapshot();
    if (snapshot.sourceHash !== body.sourceHash)
      throw new ConflictException("Снимок обновился. Проверьте выборку");
    const sources = agencySourceCards(snapshot.items);
    if (body.agencyIds.some((id) => !sources.has(id)))
      throw new BadRequestException("Выбраны несопоставленные агентства");
    const script = await this.script();
    if (!script.current)
      throw new BadRequestException("Сначала утвердите актуальный скрипт");
    const resolved = await this.workflow.prepareCampaign("OUR", "AGENCY", {
      includeLowSignal: true,
    });
    const filter = resolved.filterSnapshot;
    try {
      return await this.db.$transaction(
        async (tx) => {
          await tx.systemSetting.create({
            data: { key, value: JSON.stringify({ fingerprint }) },
          });
          const workflow = this.workflow.forTransaction(tx);
          // One commit: the draft, all assignments and retry receipt either
          // persist together or roll back. No partially assigned pilot.
          const campaign = await workflow.createCampaign(
            {
              base: "OUR",
              entityType: "AGENCY",
              name: body.name.trim(),
              message: script.text,
              filterSnapshot: filter,
              filterHash: resolved.filterHash,
              snapshotId: resolved.snapshotId,
              selection: { mode: "IDS", ids: body.agencyIds },
            },
            user,
          );
          const stored = await tx.loyaltyCallCampaign.findUniqueOrThrow({
            where: { id: campaign.id },
          });
          await tx.loyaltyCallCampaign.update({
            where: { id: campaign.id },
            data: {
              filterSnapshot: {
                ...(stored.filterSnapshot as object),
                agencyWorkspace: {
                  source: "AGENCIES_V1_2",
                  sourceHash: snapshot.sourceHash,
                  scriptVersion: script.version,
                },
              },
            },
          });
          const assigned = await workflow.createAssignments(
            campaign.id,
            {
              assigneeId: body.assigneeId,
              selection: { mode: "IDS", ids: body.agencyIds },
              expectedVersion: campaign.version,
            },
            user,
          );
          if (assigned.createdCount !== body.agencyIds.length)
            throw new ConflictException(
              "Агентство уже назначено. Обновите выборку",
            );
          await tx.systemSetting.update({
            where: { key },
            data: {
              value: JSON.stringify({ fingerprint, campaignId: campaign.id }),
            },
          });
          return campaign;
        },
        { timeout: 30000 },
      );
    } catch (error) {
      if ((error as { code?: string }).code === "P2002") {
        const result = await replay();
        if (result) return result;
      }
      throw error;
    }
  }

  async control(
    id: string,
    body: AgencyCallControlDto,
    user: CurrentUserPayload,
  ) {
    await this.permissions.requireAll(user, ["READ_ALL", "CALL_ASSIGN"]);
    if (!body.reason.trim()) throw new BadRequestException("Укажите причину");
    return this.db.$transaction(async (tx) => {
      const changed = await tx.agency.updateMany({
        where: { id, callControlVersion: body.expectedVersion },
        data: {
          doNotCall: body.doNotCall,
          callControlReason: body.reason.trim(),
          callControlUpdatedAt: new Date(),
          callControlVersion: { increment: 1 },
        },
      } as any);
      if (changed.count !== 1)
        throw new ConflictException("Карточка изменена. Обновите страницу");
      if (body.doNotCall)
        await tx.loyaltyCallAssignment.updateMany({
          where: { ourAgencyId: id, status: { in: OPEN as any } },
          data: {
            status: "CANCELLED",
            cancelledAt: new Date(),
            version: { increment: 1 },
          },
        });
      await tx.loyaltyWorkflowAudit.create({
        data: {
          actorId: user.id,
          action: body.doNotCall
            ? "AGENCY_DO_NOT_CALL"
            : "AGENCY_CALL_PERMISSION_RESTORED",
          entityType: "AGENCY",
          entityId: id,
          after: { doNotCall: body.doNotCall, reason: body.reason.trim() },
        },
      } as any);
      return { version: body.expectedVersion + 1 };
    });
  }

  async resumeTask(
    id: string,
    expectedVersion: number,
    user: CurrentUserPayload,
  ) {
    await this.permissions.require(user, "CALL_EXECUTE");
    if (!(await this.script()).current)
      throw new BadRequestException("Сначала утвердите актуальный скрипт");
    return this.db.$transaction(async (tx) => {
      const task = await tx.loyaltyTask.findUnique({
        where: { id },
        include: { assignment: { include: { campaign: true } } },
      });
      if (!task || task.assignedToId !== user.id)
        throw new ForbiddenException(
          "Доступно только ответственному оператору",
        );
      if (!task.ourAgencyId || !task.assignment || task.status !== "OPEN")
        throw new ConflictException("Задача недоступна для повторного звонка");
      if ((task as any).kind !== "CALL")
        throw new BadRequestException(
          "Эта задача не является повторным звонком; выполните указанное действие отдельно",
        );
      if (task.version !== expectedVersion)
        throw new ConflictException("Задача изменена, обновите карточку");
      await tx.$queryRawUnsafe(
        "SELECT id FROM agencies WHERE id = $1 FOR UPDATE",
        task.ourAgencyId,
      );
      const agency = (await tx.agency.findUnique({
        where: { id: task.ourAgencyId },
      })) as any;
      if (!agency || agency.doNotCall)
        throw new ConflictException("Для агентства действует запрет звонков");
      const existing = await tx.loyaltyCallAssignment.findFirst({
        where: { ourAgencyId: task.ourAgencyId, status: { in: OPEN as any } },
      });
      if (existing) {
        if (
          existing.id === task.assignmentId &&
          existing.assignedToId === user.id
        )
          return existing;
        throw new ConflictException(
          "Агентство уже находится в активной очереди",
        );
      }
      const campaign = task.assignment.campaign;
      if (campaign.status === "ARCHIVED" || campaign.status === "DRAFT")
        throw new ConflictException("Кампания не активна");
      const assignment = await tx.loyaltyCallAssignment.create({
        data: {
          campaignId: campaign.id,
          ourAgencyId: task.ourAgencyId,
          assignedToId: user.id,
          assignedById: user.id,
        },
      });
      await tx.loyaltyCallCampaign.update({
        where: { id: campaign.id },
        data: {
          status: "ACTIVE",
          completedAt: null,
          version: { increment: 1 },
        },
      });
      const changed = await tx.loyaltyTask.updateMany({
        where: { id, version: expectedVersion, status: "OPEN" },
        data: { assignmentId: assignment.id, version: { increment: 1 } },
      });
      if (changed.count !== 1) throw new ConflictException("Задача изменена");
      await tx.loyaltyWorkflowAudit.create({
        data: {
          actorId: user.id,
          action: "AGENCY_FOLLOW_UP_STARTED",
          entityType: "TASK",
          entityId: id,
          before: { assignmentId: task.assignmentId },
          after: { assignmentId: assignment.id },
        },
      });
      return assignment;
    });
  }

  async contacts(
    id: string,
    body: AgencyContactsDto,
    user: CurrentUserPayload,
  ) {
    await this.permissions.require(user, "ENTITY_EDIT");
    const permissions = await this.permissions.effective(user);
    if (!permissions.permissions.includes("READ_ALL")) {
      const own = await this.db.loyaltyCallAssignment.findFirst({
        where: {
          ourAgencyId: id,
          assignedToId: user.id,
          status: { in: OPEN as any },
        },
      });
      if (!own)
        throw new ForbiddenException(
          "Нет собственного назначения для агентства",
        );
    }
    if (
      new Set(body.contacts.map((c) => c.id)).size !== body.contacts.length ||
      body.contacts.some(
        (c) =>
          !c.name.trim() ||
          !c.source.trim() ||
          [c.phone, c.alternatePhone].some(
            (phone) => phone.trim() && phone.replace(/\D/g, "").length < 5,
          ) ||
          !/(Z|[+-]\d{2}:\d{2})$/.test(c.verifiedAt) ||
          new Date(c.verifiedAt).getTime() > Date.now(),
      )
    )
      throw new BadRequestException(
        "Проверьте контакты, источник и дату проверки",
      );
    return this.db.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(
        "SELECT id FROM agencies WHERE id=$1 FOR UPDATE",
        id,
      );
      if (!permissions.permissions.includes("READ_ALL")) {
        const own = await tx.loyaltyCallAssignment.findFirst({
          where: {
            ourAgencyId: id,
            assignedToId: user.id,
            status: { in: OPEN as any },
          },
        });
        if (!own)
          throw new ForbiddenException(
            "Назначение изменилось; обновите карточку",
          );
      }
      const before = (await tx.agency.findUnique({
        where: { id },
        select: { callContacts: true },
      } as any)) as any;
      const changed = await tx.agency.updateMany({
        where: { id, callContactsVersion: body.expectedVersion },
        data: {
          callContacts: body.contacts,
          callContactsVersion: { increment: 1 },
        },
      } as any);
      if (changed.count !== 1)
        throw new ConflictException("Контакты уже изменены, обновите карточку");
      await tx.loyaltyWorkflowAudit.create({
        data: {
          actorId: user.id,
          action: "AGENCY_CALL_CONTACTS_UPDATED",
          entityType: "AGENCY",
          entityId: id,
          before: { contacts: before?.callContacts ?? [] },
          after: { version: body.expectedVersion + 1, contacts: body.contacts },
        },
      } as any);
      return { version: body.expectedVersion + 1 };
    });
  }

  async reassign(
    id: string,
    body: AgencyReassignDto,
    user: CurrentUserPayload,
  ) {
    await this.permissions.requireAll(user, ["READ_ALL", "CALL_ASSIGN"]);
    const assignee = await this.db.broker.findFirst({
      where: {
        id: body.assigneeId,
        status: "ACTIVE",
        mergedIntoId: null,
        OR: [
          { role: "ADMIN" },
          {
            role: "MANAGER",
            loyaltyGrants: {
              some: { permission: "CALL_EXECUTE", revokedAt: null },
            },
          },
        ],
      },
      select: { id: true },
    });
    if (!assignee)
      throw new BadRequestException("Выберите активного сотрудника");
    return this.db.$transaction(async (tx) => {
      const assignment = await tx.loyaltyCallAssignment.findUnique({
        where: { id },
      });
      if (!assignment?.ourAgencyId)
        throw new BadRequestException("Нет назначения агентства");
      await tx.$queryRawUnsafe(
        "SELECT id FROM agencies WHERE id = $1 FOR UPDATE",
        assignment.ourAgencyId,
      );
      const current = await tx.loyaltyCallAssignment.findUnique({
        where: { id },
      });
      if (
        !current ||
        current.version !== body.expectedVersion ||
        !OPEN.includes(current.status)
      )
        throw new ConflictException("Назначение уже изменено");
      const changed = await tx.loyaltyCallAssignment.updateMany({
        where: {
          id,
          version: body.expectedVersion,
          status: { in: OPEN as any },
        },
        data: {
          status: "CANCELLED",
          cancelledAt: new Date(),
          workSessionHash: null,
          version: { increment: 1 },
        },
      } as any);
      if (changed.count !== 1)
        throw new ConflictException("Назначение уже изменено");
      const successor = await tx.loyaltyCallAssignment.create({
        data: {
          campaignId: current.campaignId,
          ourAgencyId: current.ourAgencyId,
          assignedToId: body.assigneeId,
          assignedById: user.id,
        },
      });
      await tx.loyaltyTask.updateMany({
        where: {
          assignmentId: id,
          status: "OPEN",
          assignedToId: assignment.assignedToId,
        },
        data: {
          assignmentId: successor.id,
          assignedToId: body.assigneeId,
          version: { increment: 1 },
        },
      });
      await tx.loyaltyWorkflowAudit.create({
        data: {
          actorId: user.id,
          action: "AGENCY_ASSIGNMENT_REASSIGNED",
          entityType: "ASSIGNMENT",
          entityId: id,
          before: { assignedToId: assignment.assignedToId },
          after: { assignedToId: body.assigneeId, successorId: successor.id },
        },
      });
      return { id: successor.id, version: successor.version };
    });
  }

  async export(query: AgencyWorkspaceQuery, user: CurrentUserPayload) {
    await this.permissions.requireAll(user, ["READ_ALL", "EXPORT"]);
    const data = await this.list(query, user);
    const rows: unknown[][] = [
      [
        "Агентство ID",
        "Агентство",
        "Событие ID",
        "Оператор",
        "Дата UTC",
        "Результат",
        "Следующий шаг",
        "Срок UTC",
        "Исправляет событие ID",
        "Дата исходной попытки UTC",
        "Актуальная версия результата",
      ],
    ];
    for (const card of data.cards) {
      const byId = new Map(card.attempts.map((a: any) => [a.id, a]));
      const superseded = new Set(
        card.attempts.map((a: any) => a.correctsAttemptId),
      );
      for (const attempt of card.attempts) {
        let root: any = attempt;
        const seen = new Set();
        while (
          root.correctsAttemptId &&
          byId.has(root.correctsAttemptId) &&
          !seen.has(root.id)
        ) {
          seen.add(root.id);
          root = byId.get(root.correctsAttemptId);
        }
        if (
          new Date(root.occurredAt) < data.period.from ||
          new Date(root.occurredAt) >= data.period.to
        )
          continue;
        rows.push([
          card.id,
          card.name,
          attempt.id,
          attempt.operator.fullName,
          attempt.occurredAt.toISOString(),
          attempt.result,
          attempt.nextStep,
          attempt.nextActionAt?.toISOString(),
          attempt.correctsAttemptId,
          new Date(root.occurredAt).toISOString(),
          !superseded.has(attempt.id),
        ]);
      }
    }
    const cell = (value: unknown) => {
      let text = String(value ?? "");
      if (/^\s*[=+@-]/.test(text)) text = "'" + text;
      return '"' + text.replace(/"/g, '""') + '"';
    };
    return "\uFEFF" + rows.map((row) => row.map(cell).join(",")).join("\r\n");
  }

  async claim(id: string, body: AgencyClaimDto, user: CurrentUserPayload) {
    await this.permissions.require(user, "CALL_EXECUTE");
    const hash = createHash("sha256").update(body.workSessionId).digest("hex");
    return this.db.$transaction(async (tx) => {
      let assignment = (await tx.loyaltyCallAssignment.findUnique({
        where: { id },
        include: { campaign: true },
      })) as any;
      if (!assignment?.ourAgencyId || assignment.assignedToId !== user.id)
        throw new ForbiddenException("Карточка назначена другому сотруднику");
      await tx.$queryRawUnsafe(
        "SELECT id FROM agencies WHERE id = $1 FOR UPDATE",
        assignment.ourAgencyId,
      );
      assignment = (await tx.loyaltyCallAssignment.findUnique({
        where: { id },
        include: { campaign: true },
      })) as any;
      if (!assignment || assignment.assignedToId !== user.id)
        throw new ForbiddenException(
          "Карточка переназначена другому сотруднику",
        );
      const agency = (await tx.agency.findUnique({
        where: { id: assignment.ourAgencyId },
      })) as any;
      if (
        !agency ||
        agency.doNotCall ||
        assignment.campaign.status !== "ACTIVE" ||
        !OPEN.includes(assignment.status)
      )
        throw new ConflictException("Карточка недоступна для обзвона");
      if (assignment.workSessionHash === hash)
        return { id, version: assignment.version, claimed: true };
      if (assignment.workSessionHash)
        throw new ConflictException(
          "Карточка уже открыта в другом сеансе. Руководитель может переназначить её после проверки",
        );
      const changed = await tx.loyaltyCallAssignment.updateMany({
        where: {
          id,
          version: body.expectedVersion,
          workSessionHash: null,
          status: { in: OPEN as any },
        },
        data: {
          workSessionHash: hash,
          status: "IN_PROGRESS",
          startedAt: new Date(),
          version: { increment: 1 },
        },
      } as any);
      if (changed.count !== 1)
        throw new ConflictException("Карточка уже изменена");
      await tx.loyaltyWorkflowAudit.create({
        data: {
          actorId: user.id,
          action: "AGENCY_WORK_CLAIMED",
          entityType: "ASSIGNMENT",
          entityId: id,
          after: { version: body.expectedVersion + 1 },
        },
      });
      return { id, version: body.expectedVersion + 1, claimed: true };
    });
  }
}
