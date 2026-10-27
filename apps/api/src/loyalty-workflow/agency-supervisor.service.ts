import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { PrismaClient } from "@st-michael/database";
import { createHash } from "node:crypto";
import { CurrentUserPayload } from "../auth/current-user.decorator";
import { AgencyWorkspaceQuery } from "./agency-workspace.dto";
import {
  AgencyWorkspaceService,
  agencyEffectiveAttempts,
  AGENCY_CONVERSATION_RESULTS,
} from "./agency-workspace.service";
import { LoyaltyPermissionService } from "./loyalty-permission.service";
import { LoyaltyWorkflowService } from "./loyalty-workflow.service";
import { AgencyDelayReasonDto } from "./agency-supervisor.dto";

const OPEN = ["PENDING", "IN_PROGRESS"];
const REASON_ACTION = "AGENCY_TASK_DELAY_REASON_RECORDED";

export function agencySupervisorProjection(
  data: any,
  assigneeId: string | undefined,
  now: Date,
  audits: any[],
  reviews: any[],
) {
  const from = new Date(data.period.from),
    to = new Date(data.period.to);
  const within = (date: any) =>
    date && new Date(date) >= from && new Date(date) < to;
  const cards = new Map<string, any>(data.cards.map((c: any) => [c.id, c]));
  const effective = agencyEffectiveAttempts(data.cards, from, to);
  const conversations = effective.filter((a) =>
    AGENCY_CONVERSATION_RESULTS.has(a.result),
  );
  const taskRows = data.cards.flatMap((c: any) =>
    c.tasks
      .filter((t: any) => !assigneeId || t.assignedToId === assigneeId)
      .map((t: any) => ({ ...t, agencyId: c.id, agencyName: c.name })),
  );
  const reasons = (taskId: string) =>
    audits
      .filter((a) => a.entityId === taskId)
      .sort(
        (a, b) => Number(b.after?.version ?? 0) - Number(a.after?.version ?? 0),
      )
      .map((a) => ({
        id: a.id,
        reason: a.after?.reason,
        version: a.after?.version,
        actor: a.actor,
        createdAt: a.createdAt,
      }));
  const overdue = taskRows
    .filter(
      (t: any) => t.status === "OPEN" && t.dueAt && new Date(t.dueAt) < now,
    )
    .map((t: any) => ({
      id: t.id,
      version: t.version,
      agencyId: t.agencyId,
      agencyName: t.agencyName,
      title: t.title,
      kind: t.kind,
      dueAt: t.dueAt,
      assignedTo: t.assignedTo,
      overdueMinutes: Math.floor(
        (now.getTime() - new Date(t.dueAt).getTime()) / 60000,
      ),
      reasons: reasons(t.id),
    }))
    .sort((a: any, b: any) => b.overdueMinutes - a.overdueMinutes);
  const evidence = {
    ...data.metrics.evidence,
    agreementConversations: conversations.map((a) => ({
      agencyId: a.agencyId,
      eventId: a.id,
      kind: "ATTEMPT",
    })),
  };
  const rate = (
    key: string,
    title: string,
    numerator: number,
    denominator: number,
    numeratorKey: string,
    denominatorKey: string,
    explanation: string,
  ) => ({
    key,
    title,
    numerator,
    denominator,
    ratio: denominator ? numerator / denominator : null,
    numeratorKey,
    denominatorKey,
    explanation,
  });
  const rates = [
    rate(
      "coverage",
      "Охват агентств",
      data.metrics.attemptedAgencies,
      data.metrics.assignedAgencies,
      "attemptedAgencies",
      "assignedAgencies",
      "Уникальные агентства с попыткой за период / уникальные агентства с назначением до конца периода в этой выборке. Повторы звонков не увеличивают число агентств.",
    ),
    rate(
      "contact",
      "Разговоры по отметке оператора",
      data.metrics.conversationAgencies,
      data.metrics.attemptedAgencies,
      "conversationAgencies",
      "attemptedAgencies",
      "Уникальные агентства с результатом разговора / агентства с попыткой. Это не подтверждённые соединения Mango.",
    ),
    rate(
      "agreements",
      "Договорённости",
      data.metrics.agreements,
      conversations.length,
      "agreements",
      "agreementConversations",
      "Результаты с договорённостью и заполненным следующим шагом/сроком / результаты разговоров. Считаются события, а не уникальные агентства; исправление заменяет исходный результат.",
    ),
    rate(
      "onTime",
      "Задачи выполнены в срок",
      data.metrics.tasksOnTime,
      data.metrics.tasksDue,
      "tasksOnTime",
      "tasksDue",
      "Выполненные не позже срока / неотменённые задачи со сроком в выбранном периоде. Задачи без срока исключены; просрочки ниже показываются на текущий момент.",
    ),
  ];
  const workload = new Map<string, any>();
  const worker = (id: string, name: string) => {
    if (!workload.has(id))
      workload.set(id, {
        id,
        name,
        open: 0,
        overdue: 0,
        attempts: 0,
        types: {},
        withoutPhone: 0,
      });
    return workload.get(id);
  };
  for (const c of data.cards) {
    for (const a of c.assignments)
      if (
        OPEN.includes(a.status) &&
        a.campaign.status === "ACTIVE" &&
        (!assigneeId || a.assignedToId === assigneeId)
      ) {
        const w = worker(
          a.assignedToId,
          a.assignedTo?.fullName || "Сотрудник не найден",
        );
        w.open++;
        w.types[c.type] = (w.types[c.type] || 0) + 1;
        if (data.quality.noPhone.includes(c.id)) w.withoutPhone++;
      }
    for (const a of c.attempts)
      if (
        !a.correctsAttemptId &&
        within(a.occurredAt) &&
        (!assigneeId || (a.operatorId ?? a.operator?.id) === assigneeId)
      )
        worker(
          a.operatorId ?? a.operator?.id,
          a.operator?.fullName || "Сотрудник не найден",
        ).attempts++;
  }
  for (const t of overdue)
    worker(t.assignedTo.id, t.assignedTo.fullName).overdue++;
  const qaSample = effective.map((a) => ({
    agencyId: a.agencyId,
    agencyName: cards.get(a.agencyId)?.name,
    attemptId: a.id,
    result: a.result,
    comment: a.comment,
    occurredAt: a.callOccurredAt,
    operator: a.callOperator,
    review:
      reviews
        .filter((r) => r.callAttemptId === a.id)
        .sort((x, y) => y.version - x.version)[0] ?? null,
  }));
  return {
    rates,
    evidence,
    overdue,
    workload: [...workload.values()],
    qaSample,
    attemptDates: Object.fromEntries(
      effective.map((a) => [
        a.id,
        { callOccurredAt: a.callOccurredAt, recordedAt: a.occurredAt },
      ]),
    ),
    exclusions: {
      tasksWithoutDueDate: taskRows.filter(
        (t: any) => !t.dueAt && t.status !== "CANCELLED",
      ).length,
      cancelledTasksInPeriod: taskRows.filter(
        (t: any) => t.status === "CANCELLED" && within(t.dueAt),
      ).length,
    },
    generatedAt: now.toISOString(),
  };
}

@Injectable()
export class AgencySupervisorService {
  private get db() {
    return this.prisma as any;
  }
  constructor(
    @Inject("PrismaClient") private readonly prisma: PrismaClient,
    private readonly permissions: LoyaltyPermissionService,
    private readonly workspace: AgencyWorkspaceService,
    private readonly workflow: LoyaltyWorkflowService,
  ) {}

  async report(query: AgencyWorkspaceQuery, user: CurrentUserPayload) {
    await this.permissions.require(user, "READ_ALL");
    const data = await this.workspace.list(query, user);
    const attempts = data.cards.flatMap((c) => c.attempts);
    if (attempts.length > 2000)
      throw new BadRequestException(
        "Для отчёта руководителя уточните выборку: больше 2000 записей звонков",
      );
    const taskIds = data.cards.flatMap((c) => c.tasks.map((t) => t.id));
    const [audits, reviews, operators] = await Promise.all([
      taskIds.length
        ? this.db.loyaltyWorkflowAudit.findMany({
            where: {
              action: REASON_ACTION,
              entityType: "AGENCY_TASK",
              entityId: { in: taskIds },
            },
            include: { actor: { select: { id: true, fullName: true } } },
            orderBy: { createdAt: "desc" },
            take: 5001,
          })
        : [],
      attempts.length
        ? this.db.agencyCallReview.findMany({
            where: { callAttemptId: { in: attempts.map((a) => a.id) } },
            select: {
              id: true,
              callAttemptId: true,
              version: true,
              createdAt: true,
              reviewer: { select: { id: true, fullName: true } },
            },
          })
        : [],
      this.workflow.operators(user),
    ]);
    if (audits.length > 5000)
      throw new BadRequestException(
        "Уточните выборку: история причин просрочки превышает 5000 записей",
      );
    return {
      ...data,
      ...agencySupervisorProjection(
        data,
        query.assigneeId,
        new Date(data.calculatedAt),
        audits,
        reviews,
      ),
      operators,
    };
  }

  async delayReason(
    id: string,
    body: AgencyDelayReasonDto,
    user: CurrentUserPayload,
  ) {
    await this.permissions.requireAll(user, ["READ_ALL", "CALL_ASSIGN"]);
    const reason = body.reason.trim();
    if (!reason) throw new BadRequestException("Укажите причину задержки");
    const hash = createHash("sha256")
      .update(JSON.stringify([id, user.id, body.expectedVersion, reason]))
      .digest("hex");
    return this.db.$transaction(async (tx: any) => {
      await tx.$queryRawUnsafe(
        "SELECT id FROM loyalty_tasks WHERE id=$1 FOR UPDATE",
        id,
      );
      const task = await tx.loyaltyTask.findUnique({
        where: { id },
        include: { assignment: { select: { ourAgencyId: true } } },
      });
      if (!task || !(task.ourAgencyId || task.assignment?.ourAgencyId))
        throw new NotFoundException("Задача агентства не найдена");
      const previous = await tx.loyaltyWorkflowAudit.findFirst({
        where: {
          entityType: "AGENCY_TASK",
          entityId: id,
          action: REASON_ACTION,
          after: { path: ["submissionId"], equals: body.submissionId },
        },
      });
      if (previous) {
        if (previous.after.requestHash !== hash)
          throw new ConflictException(
            "Идентификатор уже использован для другой причины",
          );
        return { version: previous.after.version };
      }
      if (
        task.status !== "OPEN" ||
        !task.dueAt ||
        new Date(task.dueAt) >= new Date()
      )
        throw new ConflictException(
          "Задача больше не является открытой просрочкой",
        );
      const updated = await tx.loyaltyTask.updateMany({
        where: { id, version: body.expectedVersion },
        data: { version: { increment: 1 } },
      });
      if (!updated.count)
        throw new ConflictException(
          "Задача изменена другим сотрудником. Обновите данные; черновик сохранён",
        );
      await tx.loyaltyWorkflowAudit.create({
        data: {
          actorId: user.id,
          action: REASON_ACTION,
          entityType: "AGENCY_TASK",
          entityId: id,
          before: { version: task.version },
          after: {
            version: body.expectedVersion + 1,
            reason,
            submissionId: body.submissionId,
            requestHash: hash,
          },
        },
      });
      return { version: body.expectedVersion + 1 };
    });
  }
}
