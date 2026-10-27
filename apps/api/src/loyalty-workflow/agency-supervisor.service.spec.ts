import "reflect-metadata";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { agencyMetrics } from "./agency-workspace.service";
import {
  AgencySupervisorService,
  agencySupervisorProjection,
} from "./agency-supervisor.service";

const now = new Date("2026-10-27T09:00:00Z");
const user: any = { id: "admin", role: "ADMIN" };
const a = { id: "a", fullName: "Operator A" },
  b = { id: "b", fullName: "Operator B" };
function dataFixture() {
  const cards = [
    {
      id: "agency",
      name: "Synthetic agency",
      type: "АН",
      assignments: [
        {
          ourAgencyId: "agency",
          assignedAt: "2026-10-25T00:00:00Z",
          status: "IN_PROGRESS",
          campaign: { status: "ACTIVE" },
          assignedToId: "b",
          assignedTo: b,
        },
      ],
      attempts: [
        {
          id: "call",
          operatorId: "a",
          operator: a,
          result: "NO_ANSWER",
          occurredAt: "2026-10-26T10:00:00Z",
        },
        {
          id: "correction",
          correctsAttemptId: "call",
          operatorId: "admin",
          operator: { id: "admin", fullName: "Admin" },
          result: "INFORMED",
          occurredAt: now,
        },
      ],
      tasks: [
        {
          id: "task",
          title: "Synthetic callback",
          kind: "CALL",
          version: 1,
          status: "OPEN",
          dueAt: "2026-10-25T10:00:00Z",
          assignedToId: "b",
          assignedTo: b,
        },
        {
          id: "ontime",
          status: "COMPLETED",
          dueAt: "2026-10-26T12:00:00Z",
          completedAt: "2026-10-26T11:00:00Z",
          assignedToId: "a",
          assignedTo: a,
        },
        { id: "undated", status: "OPEN", assignedToId: "a", assignedTo: a },
        {
          id: "cancelled",
          status: "CANCELLED",
          dueAt: "2026-10-26T13:00:00Z",
          assignedToId: "a",
          assignedTo: a,
        },
      ],
    },
  ];
  const from = new Date("2026-10-26T00:00:00Z"),
    to = new Date("2026-10-27T00:00:00Z");
  return {
    cards,
    period: { from, to },
    metrics: agencyMetrics(cards, from, to, now),
    quality: { noPhone: ["agency"] },
  };
}

describe("agency supervisor projection", () => {
  it("reconciles ratios and evidence, original operator/time, overdue ages and exclusions", () => {
    const report = agencySupervisorProjection(
      dataFixture(),
      undefined,
      now,
      [
        {
          id: "reason",
          entityId: "task",
          after: { version: 2, reason: "Waiting for callback" },
          actor: a,
          createdAt: now,
        },
      ],
      [],
    );
    for (const rate of report.rates) {
      expect(report.evidence[rate.numeratorKey]).toHaveLength(rate.numerator);
      expect(report.evidence[rate.denominatorKey]).toHaveLength(
        rate.denominator,
      );
    }
    expect(report.qaSample[0]).toMatchObject({
      attemptId: "correction",
      operator: a,
      occurredAt: "2026-10-26T10:00:00Z",
      review: null,
    });
    expect(report.overdue[0]).toMatchObject({
      id: "task",
      overdueMinutes: 2820,
      reasons: [{ reason: "Waiting for callback" }],
    });
    expect(report.exclusions).toEqual({
      tasksWithoutDueDate: 1,
      cancelledTasksInPeriod: 1,
    });
    expect(report.workload.find((w) => w.id === "a")).toMatchObject({
      attempts: 1,
      open: 0,
    });
    expect(report.workload.find((w) => w.id === "b")).toMatchObject({
      open: 1,
      overdue: 1,
      withoutPhone: 1,
      types: { АН: 1 },
    });
  });
  it("does not misattribute current assignments after reassignment to historical operator", () => {
    const report = agencySupervisorProjection(dataFixture(), "a", now, [], []);
    expect(report.workload.map((w) => w.id)).toEqual(["a"]);
    expect(report.workload[0].open).toBe(0);
    expect(report.overdue).toEqual([]);
  });
  it("keeps zero denominators unknown and never carries QA from superseded attempt", () => {
    const data = dataFixture();
    data.cards[0].attempts = [];
    data.metrics = agencyMetrics(
      data.cards,
      new Date(data.period.from),
      new Date(data.period.to),
      now,
    );
    const empty = agencySupervisorProjection(data, undefined, now, [], []);
    expect(empty.rates.find((r) => r.key === "contact")?.ratio).toBeNull();
    const active = agencySupervisorProjection(
      dataFixture(),
      undefined,
      now,
      [],
      [{ id: "old-review", callAttemptId: "call", version: 1 }],
    );
    expect(active.qaSample[0].review).toBeNull();
  });
});

function fixture() {
  let saved: any;
  const db: any = {
    $queryRawUnsafe: jest.fn(),
    $transaction: (fn: any) => fn(db),
    loyaltyTask: {
      findUnique: jest.fn().mockResolvedValue({
        id: "task",
        ourAgencyId: "agency",
        version: 1,
        status: "OPEN",
        dueAt: "2020-01-01",
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    loyaltyWorkflowAudit: {
      findFirst: jest.fn(async () => saved),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(async ({ data }: any) => {
        saved = data;
        return data;
      }),
    },
    agencyCallReview: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const permissions: any = { require: jest.fn(), requireAll: jest.fn() };
  const workspace: any = { list: jest.fn().mockResolvedValue(dataFixture()) };
  const workflow: any = { operators: jest.fn().mockResolvedValue([]) };
  return {
    db,
    permissions,
    workspace,
    workflow,
    service: new AgencySupervisorService(db, permissions, workspace, workflow),
  };
}
describe("supervisor server access and delay reasons", () => {
  it("denies report before reading data without READ_ALL", async () => {
    const f = fixture();
    f.permissions.require.mockRejectedValue(new ForbiddenException());
    await expect(f.service.report({}, user)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(f.workspace.list).not.toHaveBeenCalled();
  });
  it("denies reason writes without independent assignment permission", async () => {
    const f = fixture();
    f.permissions.requireAll.mockRejectedValue(new ForbiddenException());
    await expect(
      f.service.delayReason(
        "task",
        { submissionId: "s", expectedVersion: 1, reason: "reason" },
        user,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.permissions.requireAll).toHaveBeenCalledWith(user, [
      "READ_ALL",
      "CALL_ASSIGN",
    ]);
    expect(f.db.loyaltyTask.findUnique).not.toHaveBeenCalled();
  });
  it("writes append-only reason with concurrency version and idempotent retry", async () => {
    const f = fixture(),
      body = {
        submissionId: "s",
        expectedVersion: 1,
        reason: " Waiting for client ",
      };
    await expect(f.service.delayReason("task", body, user)).resolves.toEqual({
      version: 2,
    });
    await expect(f.service.delayReason("task", body, user)).resolves.toEqual({
      version: 2,
    });
    expect(f.db.loyaltyTask.updateMany).toHaveBeenCalledTimes(1);
    expect(
      f.db.loyaltyWorkflowAudit.create.mock.calls[0][0].data.after.reason,
    ).toBe("Waiting for client");
    await expect(
      f.service.delayReason("task", { ...body, reason: "different" }, user),
    ).rejects.toBeInstanceOf(ConflictException);
  });
  it("rejects stale, completed, non-agency and empty reasons without writing history", async () => {
    for (const state of ["stale", "completed", "other", "blank"]) {
      const f = fixture();
      if (state === "stale")
        f.db.loyaltyTask.updateMany.mockResolvedValue({ count: 0 });
      if (state === "completed")
        f.db.loyaltyTask.findUnique.mockResolvedValue({
          ourAgencyId: "agency",
          status: "COMPLETED",
        });
      if (state === "other")
        f.db.loyaltyTask.findUnique.mockResolvedValue({
          ourBrokerId: "broker",
        });
      await expect(
        f.service.delayReason(
          "task",
          {
            submissionId: "s",
            expectedVersion: 1,
            reason: state === "blank" ? " " : "reason",
          },
          user,
        ),
      ).rejects.toBeInstanceOf(
        state === "other"
          ? NotFoundException
          : state === "blank"
            ? BadRequestException
            : ConflictException,
      );
      expect(f.db.loyaltyWorkflowAudit.create).not.toHaveBeenCalled();
    }
  });
});
