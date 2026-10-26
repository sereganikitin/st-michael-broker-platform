import "reflect-metadata";
import { createHash } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from "@nestjs/common";
import {
  agencyMetrics,
  agencySourceCards,
  AgencyWorkspaceService,
} from "./agency-workspace.service";
import { LoyaltyWorkflowService } from "./loyalty-workflow.service";

const user: any = { id: "operator", role: "MANAGER" };
const admin: any = { id: "admin", role: "ADMIN" };
const now = new Date("2026-10-26T09:00:00Z");
const period = { tab: "Активные", row: 6, fields: [] };
const source = {
  sourceHash: "a".repeat(64),
  loadedAt: now.toISOString(),
  items: [
    {
      status: "MATCHED",
      name: "Synthetic agency",
      type: "АН",
      matchedAgency: { id: "agency", name: "Synthetic agency" },
      periods: [period],
    },
    {
      status: "REVIEW",
      name: "Unresolved",
      type: "АН",
      periods: [{ ...period, row: 8 }],
    },
  ],
};

function fixture() {
  const db: any = {
    agency: {
      findMany: jest.fn().mockResolvedValue([{ id: "agency", phone: null }]),
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: "agency", doNotCall: false }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    loyaltyCallAssignment: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: "follow-up" }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    loyaltyTask: {
      findUnique: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    loyaltyCallCampaign: {
      update: jest.fn(),
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        id: "campaign",
        version: 1,
        status: "DRAFT",
        filterSnapshot: { version: 2 },
      }),
    },
    loyaltyWorkflowAudit: { create: jest.fn() },
    systemSetting: {
      findUnique: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      create: jest.fn(),
      update: jest.fn(),
    },
    $queryRawUnsafe: jest.fn().mockResolvedValue([]),
  };
  db.$transaction = (fn: any) => fn(db);
  const permissions: any = {
    requireAny: jest.fn(),
    requireStaff: jest.fn(),
    require: jest.fn(),
    requireAll: jest.fn(),
    effective: jest
      .fn()
      .mockResolvedValue({ permissions: ["READ_OWN_QUEUE", "CALL_EXECUTE"] }),
  };
  const workflow: any = {
    createCampaign: jest.fn().mockResolvedValue({ id: "campaign", version: 1 }),
    createAssignments: jest.fn().mockResolvedValue({ createdCount: 1 }),
    forTransaction: jest.fn(),
  };
  workflow.forTransaction.mockReturnValue(workflow);
  const base: any = {
    resolveSelection: jest
      .fn()
      .mockResolvedValue({ filterHash: "hash", snapshotId: null }),
  };
  const service = new AgencyWorkspaceService(db, permissions, workflow, base);
  jest.spyOn(service as any, "snapshot").mockResolvedValue(source);
  return { db, permissions, workflow, service };
}

describe("Agency v1/2 workspace", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(now);
  });
  afterEach(() => jest.useRealTimers());

  it("uses canonical IDs and groups periods, rejecting unresolved matches", () => {
    const second = {
      ...source.items[0],
      key: "different-row",
      periods: [{ ...period, row: 9 }],
    };
    const result = agencySourceCards([...source.items, second, second]);
    expect([...result.keys()]).toEqual(["agency"]);
    expect(result.get("agency").periods).toHaveLength(2);
    expect(
      agencySourceCards([{ ...second, periods: [{ ...period, row: 99 }] }]).has(
        "agency",
      ),
    ).toBe(true);
  });

  it("does not expose unassigned source cards or team quality counts to operators", async () => {
    const f = fixture();
    const result = await f.service.list({}, user);
    expect(result.cards).toEqual([]);
    expect(result.source.reviewCount).toBeNull();
    expect(
      f.db.loyaltyCallAssignment.findMany.mock.calls[0][0].where.assignedToId,
    ).toBe(user.id);
    expect(f.db.agency.updateMany).not.toHaveBeenCalled();
  });

  it("requires READ_ALL for another operator even when caller can execute", async () => {
    const f = fixture();
    f.permissions.require.mockRejectedValue(new ForbiddenException());
    await expect(
      f.service.list({ assigneeId: "other" }, user),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("shows only own history and own tasks", async () => {
    const f = fixture();
    f.db.loyaltyCallAssignment.findMany.mockResolvedValue([
      {
        id: "assignment",
        ourAgencyId: "agency",
        assignedToId: user.id,
        assignedAt: now,
        attempts: [{ id: "attempt" }],
        tasks: [
          { assignedToId: "other" },
          { id: "own-task", assignedToId: user.id },
        ],
      },
    ]);
    const result = await f.service.list({}, user);
    expect(result.cards[0].tasks).toEqual([
      { id: "own-task", assignedToId: user.id },
    ]);
    expect(result.cards[0].attempts).toEqual([{ id: "attempt" }]);
  });

  it("defaults report period to Moscow midnight", async () => {
    const f = fixture();
    const result = await f.service.list({}, admin);
    expect(result.period.from.toISOString()).toBe("2026-10-25T21:00:00.000Z");
    expect(result.period.to.toISOString()).toBe("2026-10-26T21:00:00.000Z");
  });

  it("rejects ambiguous dates and reversed periods", async () => {
    const f = fixture();
    await expect(
      f.service.list(
        { from: "2026-10-26T12:00:00", to: "2026-10-27T00:00:00Z" },
        admin,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      f.service.list(
        { from: "2026-10-28T00:00:00Z", to: "2026-10-27T00:00:00Z" },
        admin,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("fails closed on oversized assignment history", async () => {
    const f = fixture();
    f.db.loyaltyCallAssignment.findMany.mockResolvedValue(
      Array(10001).fill({}),
    );
    await expect(f.service.list({}, admin)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("counts attempts separately from unique agencies and excludes correction rows as attempts", () => {
    const cards = [
      {
        id: "agency",
        assignments: [{ ourAgencyId: "agency", assignedAt: now }],
        attempts: [
          { id: "a", result: "NO_ANSWER", occurredAt: now },
          { id: "b", result: "NO_ANSWER", occurredAt: now },
          {
            id: "c",
            correctsAttemptId: "b",
            result: "AGREEMENTS_EXIST",
            nextStep: "Call",
            nextActionAt: now,
            occurredAt: now,
          },
        ],
        tasks: [
          { status: "COMPLETED", dueAt: now, completedAt: now },
          { status: "OPEN", dueAt: "2026-10-26T08:00:00Z" },
        ],
      },
    ];
    expect(
      agencyMetrics(cards, new Date("2026-10-25"), new Date("2026-10-27"), now),
    ).toMatchObject({
      attempts: 2,
      attemptedAgencies: 1,
      conversationAgencies: 1,
      agreements: 1,
      tasksDue: 2,
      tasksOnTime: 1,
      overdue: 1,
    });
  });

  it("refuses stale selection before creating any campaign", async () => {
    const f = fixture();
    await expect(
      f.service.pilot(
        {
          submissionId: "request",
          name: "Pilot",
          sourceHash: "old",
          agencyIds: ["agency"],
          assigneeId: user.id,
        },
        admin,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(f.workflow.createCampaign).not.toHaveBeenCalled();
  });

  it("refuses unresolved selection and missing script", async () => {
    const f = fixture();
    await expect(
      f.service.pilot(
        {
          submissionId: "request",
          name: "Pilot",
          sourceHash: source.sourceHash,
          agencyIds: ["unknown"],
          assigneeId: user.id,
        },
        admin,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      f.service.pilot(
        {
          submissionId: "request",
          name: "Pilot",
          sourceHash: source.sourceHash,
          agencyIds: ["agency"],
          assigneeId: user.id,
        },
        admin,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(f.workflow.createCampaign).not.toHaveBeenCalled();
  });

  it("requires script privileges and optimistic version", async () => {
    const f = fixture();
    f.permissions.requireAll.mockRejectedValueOnce(new ForbiddenException());
    const body = {
      text: "Approved",
      owner: "Owner",
      validUntil: "2026-11-01T00:00:00Z",
      expectedVersion: 0,
    };
    await expect(f.service.approveScript(body, user)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    f.db.systemSetting.findUnique.mockResolvedValue({
      value: JSON.stringify({ version: 2 }),
    });
    await expect(f.service.approveScript(body, admin)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(f.db.systemSetting.create).not.toHaveBeenCalled();
  });

  it("stores approved script with owner, expiry and audit", async () => {
    const f = fixture();
    await f.service.approveScript(
      {
        text: "Approved",
        owner: "Owner",
        validUntil: "2026-11-01T00:00:00Z",
        expectedVersion: 0,
      },
      admin,
    );
    expect(f.db.systemSetting.create).toHaveBeenCalled();
    expect(
      f.db.loyaltyWorkflowAudit.create.mock.calls[0][0].data.after,
    ).toMatchObject({ approvedBy: admin.id, version: 1, text: "Approved" });
  });

  it("cancels outbound assignments on stop; restoration requires reason and version", async () => {
    const f = fixture();
    await f.service.control(
      "agency",
      { doNotCall: true, reason: "Requested", expectedVersion: 1 },
      admin,
    );
    expect(
      f.db.loyaltyCallAssignment.updateMany.mock.calls[0][0].data.status,
    ).toBe("CANCELLED");
    await expect(
      f.service.control(
        "agency",
        { doNotCall: false, reason: " ", expectedVersion: 2 },
        admin,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    f.db.agency.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      f.service.control(
        "agency",
        { doNotCall: false, reason: "Reviewed", expectedVersion: 1 },
        admin,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("refuses edits to another operator's contacts", async () => {
    const f = fixture();
    await expect(
      f.service.contacts("agency", { expectedVersion: 1, contacts: [] }, user),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.db.agency.updateMany).not.toHaveBeenCalled();
  });

  it("does not resume another operator's task or a stopped agency", async () => {
    const f = fixture();
    jest.spyOn(f.service as any, "script").mockResolvedValue({ current: true });
    f.db.loyaltyTask.findUnique.mockResolvedValue({ assignedToId: "other" });
    await expect(f.service.resumeTask("task", 1, user)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    f.db.loyaltyTask.findUnique.mockResolvedValue({
      assignedToId: user.id,
      ourAgencyId: "agency",
      status: "OPEN",
      version: 1,
      assignment: { campaign: { status: "COMPLETED" } },
    });
    f.db.agency.findUnique.mockResolvedValue({ doNotCall: true });
    await expect(f.service.resumeTask("task", 1, user)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(f.db.loyaltyCallAssignment.create).not.toHaveBeenCalled();
  });

  it("resumes a promised follow-up with an explicit new assignment", async () => {
    const f = fixture();
    jest.spyOn(f.service as any, "script").mockResolvedValue({ current: true });
    f.db.loyaltyTask.findUnique.mockResolvedValue({
      id: "task",
      assignedToId: user.id,
      ourAgencyId: "agency",
      status: "OPEN",
      version: 1,
      assignmentId: "old",
      assignment: { campaign: { id: "campaign", status: "COMPLETED" } },
    });
    await f.service.resumeTask("task", 1, user);
    expect(
      f.db.loyaltyCallAssignment.create.mock.calls[0][0].data,
    ).toMatchObject({ ourAgencyId: "agency", assignedToId: user.id });
    expect(f.db.loyaltyTask.updateMany.mock.calls[0][0].data.assignmentId).toBe(
      "follow-up",
    );
    expect(f.db.$queryRawUnsafe).toHaveBeenCalled();
  });

  it("requires complete obligations and a time zone on the server", () => {
    const service: any = new LoyaltyWorkflowService(
      {} as any,
      {} as any,
      {} as any,
    );
    for (const result of [
      "CALLBACK",
      "SEND_INFORMATION",
      "BROKER_TOUR_SCHEDULED",
      "AGREEMENTS_EXIST",
      "COOPERATION_AGREED",
    ]) {
      expect(() =>
        service.validateAttemptComment("AGENCY", {
          result,
          comment: "Synthetic",
        }),
      ).toThrow(BadRequestException);
      expect(() =>
        service.validateAttemptComment("AGENCY", {
          result,
          comment: "Synthetic",
          nextStep: "Call",
          nextActionAt: "2026-10-27T12:00:00",
        }),
      ).toThrow(BadRequestException);
      expect(() =>
        service.validateAttemptComment("AGENCY", {
          result,
          comment: "Synthetic",
          nextStep: "Call",
          nextActionAt: "2026-10-27T12:00:00+03:00",
        }),
      ).not.toThrow();
    }
    expect(() =>
      service.validateAttemptComment("AGENCY", {
        result: "DO_NOT_CALL",
        comment: "Stop",
        nextStep: "Call",
        nextActionAt: "2026-10-27T12:00:00Z",
      }),
    ).toThrow(BadRequestException);
  });

  it("creates the pilot and all assignments in the outer transaction", async () => {
    const f = fixture();
    jest
      .spyOn(f.service as any, "script")
      .mockResolvedValue({ current: true, text: "Approved", version: 1 });
    await f.service.pilot(
      {
        submissionId: "request",
        name: "Pilot",
        sourceHash: source.sourceHash,
        agencyIds: ["agency"],
        assigneeId: user.id,
      },
      admin,
    );
    expect(f.workflow.forTransaction).toHaveBeenCalledWith(f.db);
    expect(f.db.systemSetting.update.mock.calls[0][0].data.value).toContain(
      '"campaignId":"campaign"',
    );
    f.workflow.createAssignments.mockResolvedValue({ createdCount: 0 });
    await expect(
      f.service.pilot(
        {
          submissionId: "request2",
          name: "Pilot",
          sourceHash: source.sourceHash,
          agencyIds: ["agency"],
          assigneeId: user.id,
        },
        admin,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("refuses export before reading operational data without EXPORT", async () => {
    const f = fixture();
    f.permissions.requireAll.mockRejectedValue(new ForbiddenException());
    await expect(f.service.export({}, user)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(f.db.loyaltyCallAssignment.findMany).not.toHaveBeenCalled();
  });

  it("uses the original call time when a correction is made outside the report period", () => {
    const cards = [
      {
        id: "agency",
        assignments: [],
        tasks: [],
        attempts: [
          { id: "original", result: "NO_ANSWER", occurredAt: now },
          {
            id: "correction",
            correctsAttemptId: "original",
            result: "COOPERATION_AGREED",
            nextStep: "Call",
            nextActionAt: now,
            occurredAt: "2026-11-10T00:00:00Z",
          },
        ],
      },
    ];
    const report = agencyMetrics(
      cards,
      new Date("2026-10-26T00:00:00Z"),
      new Date("2026-10-27T00:00:00Z"),
      now,
    );
    expect(report).toMatchObject({
      attempts: 1,
      attemptedAgencies: 1,
      agreements: 1,
    });
    expect(report.evidence.agreements[0].eventId).toBe("correction");
  });

  function attemptFixture() {
    const f = fixture();
    Object.assign(f.db.loyaltyCallAssignment, {
      findUnique: jest.fn().mockResolvedValue({
        id: "assignment",
        ourAgencyId: "agency",
        campaignId: "campaign",
        assignedToId: user.id,
        status: "PENDING",
        campaign: {
          id: "campaign",
          base: "OUR",
          entityType: "AGENCY",
          status: "ACTIVE",
        },
      }),
      count: jest.fn().mockResolvedValue(1),
    });
    f.db.agency.update = jest.fn();
    f.db.loyaltyCallAttempt = {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: "attempt" }),
    };
    const service = new LoyaltyWorkflowService(f.db, {} as any, f.permissions);
    return { ...f, service };
  }

  it("refuses a new attempt on an agency that became blocked", async () => {
    const f = attemptFixture();
    f.db.agency.findMany.mockResolvedValue([]);
    await expect(
      f.service.createAttempt(
        "assignment",
        {
          expectedVersion: 1,
          submissionId: "request-1",
          result: "NO_ANSWER",
          comment: "Synthetic",
        },
        user,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(f.db.loyaltyCallAttempt.create).not.toHaveBeenCalled();
  });

  it("persists the stop flag and cancels other active assignments with the attempt", async () => {
    const f = attemptFixture();
    await f.service.createAttempt(
      "assignment",
      {
        expectedVersion: 1,
        submissionId: "request-1",
        result: "DO_NOT_CALL",
        comment: "Requested stop",
      },
      user,
    );
    expect(f.db.agency.update.mock.calls[0][0].data.doNotCall).toBe(true);
    expect(
      f.db.loyaltyCallAssignment.updateMany.mock.calls.some(
        (args: any) => args[0].data.status === "CANCELLED",
      ),
    ).toBe(true);
    expect(f.db.loyaltyCallAttempt.create).toHaveBeenCalledTimes(1);
  });

  it("replays the exact attempt even after a stop without adding another event", async () => {
    const f = attemptFixture();
    f.db.loyaltyCallAttempt.findUnique.mockResolvedValue({
      id: "attempt",
      assignmentId: "assignment",
      operatorId: user.id,
      correctsAttemptId: null,
      result: "DO_NOT_CALL",
      comment: "Requested stop",
      nextStep: null,
      nextActionAt: null,
    });
    const result = await f.service.createAttempt(
      "assignment",
      {
        expectedVersion: 1,
        submissionId: "request-1",
        result: "DO_NOT_CALL",
        comment: "Requested stop",
      },
      user,
    );
    expect(result.idempotent).toBe(true);
    expect(f.db.loyaltyCallAttempt.create).not.toHaveBeenCalled();
  });

  it("refuses conversation results with an expired workspace script", async () => {
    const f = attemptFixture();
    const assignment = await f.db.loyaltyCallAssignment.findUnique();
    assignment.campaign.filterSnapshot = { agencyWorkspace: {} };
    assignment.workSessionHash = createHash("sha256")
      .update("session")
      .digest("hex");
    await expect(
      f.service.createAttempt(
        "assignment",
        {
          expectedVersion: 1,
          submissionId: "request-1",
          workSessionId: "session",
          result: "NO_ANSWER",
          comment: "Synthetic",
        },
        user,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(f.db.loyaltyCallAttempt.create).not.toHaveBeenCalled();
  });

  it("retains assigned history when a later snapshot loses the match", async () => {
    const f = fixture();
    jest
      .spyOn(f.service as any, "snapshot")
      .mockResolvedValue({ ...source, items: [] });
    f.db.loyaltyCallAssignment.findMany.mockResolvedValue([
      {
        id: "assignment",
        ourAgencyId: "agency",
        assignedToId: user.id,
        assignedAt: now,
        attempts: [{ id: "event" }],
        tasks: [],
      },
    ]);
    const result = await f.service.list({}, user);
    expect(result.cards[0]).toMatchObject({
      id: "agency",
      sourceMatched: false,
      periods: [],
      attempts: [{ id: "event" }],
    });
    expect(
      f.db.loyaltyCallAssignment.findMany.mock.calls[0][0].where.OR[1].campaign
        .filterSnapshot,
    ).toMatchObject({
      path: ["agencyWorkspace", "source"],
      equals: "AGENCIES_V1_2",
    });
  });

  it("shows a sync incident even while the prior snapshot is recent", async () => {
    const f = fixture();
    f.db.systemSetting.findUnique.mockImplementation(({ where }: any) =>
      where.key.endsWith(":incident") ? { key: where.key } : null,
    );
    const result = await f.service.list({}, admin);
    expect(result.source.stale).toBe(true);
  });

  it("exports correction evidence in the original call period and escapes CSV formulas", async () => {
    const f = fixture();
    jest.spyOn(f.service, "list").mockResolvedValue({
      cards: [
        {
          id: "agency",
          name: "=SUM(1)",
          attempts: [
            {
              id: "root",
              occurredAt: now,
              operator: { fullName: "Operator" },
              result: "NO_ANSWER",
            },
            {
              id: "correction",
              correctsAttemptId: "root",
              occurredAt: new Date("2026-11-01"),
              operator: { fullName: "Operator" },
              result: "CALLBACK",
            },
          ],
        },
      ],
      period: { from: new Date("2026-10-26"), to: new Date("2026-10-27") },
    } as any);
    const csv = await f.service.export({}, admin);
    expect(csv).toContain('"\'=SUM(1)"');
    expect(csv).toContain('"correction"');
    expect(csv.split("\r\n")).toHaveLength(3);
  });

  it("claims an assignment once and rejects a different browser session", async () => {
    const f = fixture();
    const assignment: any = {
      id: "assignment",
      ourAgencyId: "agency",
      assignedToId: user.id,
      version: 1,
      status: "PENDING",
      campaign: { status: "ACTIVE" },
    };
    f.db.loyaltyCallAssignment.findUnique = jest
      .fn()
      .mockResolvedValue(assignment);
    const body = { expectedVersion: 1, workSessionId: "session-a" };
    await f.service.claim("assignment", body, user);
    expect(
      f.db.loyaltyCallAssignment.updateMany.mock.calls[0][0].data,
    ).toMatchObject({
      status: "IN_PROGRESS",
      workSessionHash: createHash("sha256").update("session-a").digest("hex"),
    });
    assignment.workSessionHash = createHash("sha256")
      .update("session-a")
      .digest("hex");
    assignment.version = 2;
    expect((await f.service.claim("assignment", body, user)).version).toBe(2);
    await expect(
      f.service.claim(
        "assignment",
        { expectedVersion: 2, workSessionId: "session-b" },
        user,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("rejects a workspace attempt without the owning browser session", async () => {
    const f = attemptFixture();
    const assignment = await f.db.loyaltyCallAssignment.findUnique();
    assignment.campaign.filterSnapshot = { agencyWorkspace: {} };
    assignment.workSessionHash = createHash("sha256")
      .update("session-a")
      .digest("hex");
    await expect(
      f.service.createAttempt(
        "assignment",
        {
          expectedVersion: 1,
          submissionId: "request-1",
          result: "NO_ANSWER",
          comment: "Synthetic",
          workSessionId: "session-b",
        },
        user,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(f.db.loyaltyCallAttempt.create).not.toHaveBeenCalled();
  });
});
