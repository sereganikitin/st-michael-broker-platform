import { WebhooksService } from "./webhooks.service";
import { AmoReviewTaskService } from "./amo-review-task.service";
import {
  AmoUniquenessProcessor,
  AmoUniquenessRecoveryService,
} from "./amo-uniqueness-recovery.service";
import { AmoCrmAdapter, AMO_SYSTEM_USER_IDS } from "@st-michael/integrations";
import { salesMeetingConflictLeadId } from "../common/amo-uniqueness";

const client = (id: string, lead: number, overrides: any = {}) => ({
  id,
  amoLeadId: BigInt(lead),
  phone: "+79990000001",
  uniquenessStatus: "UNDER_REVIEW",
  uniquenessReason: "EXCEPTION_AFTER_SALES_MEETING:111 old sales",
  broker: { id: `broker-${id}`, amoContactId: 701n },
  responsibleBroker: null,
  deals: [],
  meetings: [],
  ...overrides,
});
const lead = (id: number, status = 62907118, pipeline = 7600542) => ({
  id,
  status_id: status,
  pipeline_id: pipeline,
  _embedded: { contacts: [{ id: 701 }] },
});

function webhookFixture(rows: any[], leads: any[], queue?: any) {
  const prisma = {
    client: {
      findMany: jest.fn(async ({ where }) => {
        if (typeof where.amoLeadId === "bigint")
          return rows.filter((r) => r.amoLeadId === where.amoLeadId);
        if (where.OR)
          return rows.filter(
            (r) =>
              r.uniquenessStatus === "UNDER_REVIEW" &&
              where.OR.some((w: any) =>
                typeof w.uniquenessReason === "string"
                  ? r.uniquenessReason === w.uniquenessReason
                  : r.uniquenessReason?.startsWith(
                      w.uniquenessReason.startsWith,
                    ),
              ),
          );
        return [];
      }),
      update: jest.fn(async ({ where, data }) =>
        Object.assign(
          rows.find((r) => r.id === where.id),
          data,
        ),
      ),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    meeting: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    deal: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const service = new WebhooksService(prisma as any, queue);
  const getLead = jest.fn(
    async (id: number) => leads.find((l) => l.id === id) || null,
  );
  (service as any).amo = { getLead };
  (service as any).logger = {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  return { service, prisma, getLead };
}

describe("exact lead uniqueness reconciliation", () => {
  it("rejects the closed new fixation without a broker mapping, preserving the old fixation", async () => {
    const old = client("old", 111, {
      uniquenessStatus: "CONDITIONALLY_UNIQUE",
    });
    const newer = client("new", 222, {
      broker: { id: "new-broker", amoContactId: null },
    });
    const f = webhookFixture([old, newer], [lead(222, 143)]);
    await f.service.reconcileLeadUniqueness(222);
    expect(newer.uniquenessStatus).toBe("REJECTED");
    expect(old.uniquenessStatus).toBe("CONDITIONALLY_UNIQUE");
    await f.service.reconcileLeadUniqueness(222);
    expect(f.prisma.client.update).toHaveBeenCalledTimes(1);
  });

  it("closing another new KC lead cannot lift the sales exception by phone", async () => {
    const a = client("a", 222),
      b = client("b", 333);
    const f = webhookFixture([a, b], [lead(222, 143)]);
    await f.service.reconcileLeadUniqueness(222);
    expect(a.uniquenessStatus).toBe("REJECTED");
    expect(b.uniquenessStatus).toBe("UNDER_REVIEW");
  });

  it("resolves only dependents of the exact closed sales lead, even without a local old Client", async () => {
    const related = client("related", 222);
    const similarId = client("other", 333, {
      uniquenessReason: "EXCEPTION_AFTER_SALES_MEETING:1112 different sales",
    });
    const f = webhookFixture(
      [related, similarId],
      [lead(111, 143, 7600546), lead(222)],
    );
    await f.service.reconcileLeadUniqueness(111);
    expect(related.uniquenessStatus).toBe("CONDITIONALLY_UNIQUE");
    expect(similarId.uniquenessStatus).toBe("UNDER_REVIEW");
  });

  it("does not lift a dependent that itself closed or detached", async () => {
    const closed = client("closed", 222),
      detached = client("detached", 333);
    const detachedLead = lead(333);
    detachedLead._embedded.contacts = [];
    const f = webhookFixture(
      [closed, detached],
      [lead(111, 143, 7600546), lead(222, 143), detachedLead],
    );
    await f.service.reconcileLeadUniqueness(111);
    expect(closed.uniquenessStatus).toBe("REJECTED");
    expect(detached.uniquenessStatus).toBe("REJECTED");
  });

  it("keeps review when the blocking sales lead remains active", async () => {
    const row = client("new", 222);
    const f = webhookFixture([row], [lead(222), lead(111, 62907338, 7600546)]);
    await f.service.reconcileLeadUniqueness(222);
    expect(row.uniquenessStatus).toBe("UNDER_REVIEW");
  });

  it("does not alter a paid client or infer broker removal from malformed CRM data", async () => {
    const paid = client("paid", 222, {
      deals: [{ status: "PAID" }],
      uniquenessStatus: "CONDITIONALLY_UNIQUE",
    });
    const f = webhookFixture([paid], [lead(222, 143)]);
    await f.service.reconcileLeadUniqueness(222);
    expect(f.prisma.client.update).not.toHaveBeenCalled();
    const pending = client("pending", 333);
    const invalid = lead(333);
    invalid._embedded.contacts = [{ id: NaN }];
    const broken = webhookFixture([pending], [invalid]);
    await expect(broken.service.reconcileLeadUniqueness(333)).rejects.toThrow(
      "CONTACTS_INVALID",
    );
    expect(pending.uniquenessStatus).toBe("UNDER_REVIEW");
  });

  it("propagates failed CRM reads to the worker and durably queues webhook failures", async () => {
    const queue = { add: jest.fn().mockResolvedValue({}) };
    const f = webhookFixture([client("new", 222)], [], queue);
    await expect(f.service.reconcileLeadUniqueness(222)).rejects.toThrow(
      "UNAVAILABLE",
    );
    await f.service.handleAmoLeadUpdate(
      { leads: { status: [{ id: "222", status_id: "143" }] } },
      {},
    );
    expect(queue.add).toHaveBeenCalledWith(
      "reconcile",
      { leadId: 222 },
      expect.objectContaining({ attempts: 8 }),
    );
    expect(f.prisma.client.update).not.toHaveBeenCalled();
  });

  it("parses a full ID and refuses ambiguous/truncated markers", () => {
    expect(
      salesMeetingConflictLeadId("EXCEPTION_AFTER_SALES_MEETING:111 text"),
    ).toBe(111);
    expect(
      salesMeetingConflictLeadId("EXCEPTION_AFTER_SALES_MEETING:111"),
    ).toBe(111);
    expect(
      salesMeetingConflictLeadId("EXCEPTION_AFTER_SALES_MEETING:111x"),
    ).toBeNull();
    expect(
      salesMeetingConflictLeadId(
        "EXCEPTION_AFTER_SALES_MEETING:999999999999999999",
      ),
    ).toBeNull();
  });
});

function taskFixture() {
  const receipts = new Map<string, string>();
  const prisma = {
    client: { findMany: jest.fn().mockResolvedValue([client("new", 222)]) },
    systemSetting: {
      findUnique: jest.fn(async ({ where }) =>
        receipts.has(where.key) ? { value: receipts.get(where.key) } : null,
      ),
      create: jest.fn(async ({ data }) => {
        if (receipts.has(data.key)) throw { code: "P2002" };
        receipts.set(data.key, data.value);
        return data;
      }),
      update: jest.fn(async ({ where, data }) => {
        receipts.set(where.key, data.value);
        return data;
      }),
      upsert: jest.fn(async ({ where, create, update }) => {
        receipts.set(
          where.key,
          receipts.has(where.key) ? update.value : create.value,
        );
        return {};
      }),
    },
  };
  const tasks: any[] = [];
  const amo = {
    getLead: jest
      .fn()
      .mockResolvedValue({ ...lead(222), responsible_user_id: 765 }),
    getTasksForEntities: jest.fn(async () => new Map([[222, tasks]])),
    createTask: jest.fn(async (data: any) => {
      tasks.push({ text: data.text, is_completed: false });
    }),
  };
  const service = new AmoReviewTaskService(prisma as any);
  (service as any).amo = amo;
  return { service, prisma, amo, receipts, tasks };
}

describe("sales meeting review task", () => {
  it("claims task creation once when two workers race", async () => {
    const f = taskFixture();
    await Promise.allSettled([
      f.service.ensureForLead(222),
      f.service.ensureForLead(222),
    ]);
    expect(f.amo.createTask).toHaveBeenCalledTimes(1);
    await f.service.ensureForLead(222);
    expect(f.amo.createTask).toHaveBeenCalledTimes(1);
  });

  it("uses the current human task assignee while the lead still belongs to a system user", async () => {
    const f = taskFixture();
    f.amo.getLead.mockResolvedValue({
      ...lead(222),
      responsible_user_id: AMO_SYSTEM_USER_IDS[0],
    });
    f.tasks.push({
      id: 1,
      text: "Call the client",
      responsible_user_id: 766,
      created_at: 100,
      is_completed: false,
    });
    await f.service.ensureForLead(222);
    expect(f.amo.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ responsibleUserId: 766 }),
      { retryTransient: false },
    );
  });

  it("creates one task with both lead links and the lead responsible user", async () => {
    const f = taskFixture();
    await f.service.ensureForLead(222);
    await f.service.ensureForLead(222);
    expect(f.amo.createTask).toHaveBeenCalledTimes(1);
    expect(f.amo.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: 222,
        responsibleUserId: 765,
        text: expect.stringContaining("/111"),
      }),
      { retryTransient: false },
    );
    expect(f.tasks[0].text).toContain("/222");
  });

  it("settles a lost response through GET without a second POST, including completed tasks", async () => {
    const f = taskFixture();
    f.amo.createTask.mockImplementationOnce(async (data) => {
      f.tasks.push({ text: data.text, is_completed: true });
      throw Error("response lost");
    });
    await expect(f.service.ensureForLead(222)).rejects.toThrow("response lost");
    await f.service.ensureForLead(222);
    expect(f.amo.createTask).toHaveBeenCalledTimes(1);
    expect([...f.receipts.values()]).toEqual(["confirmed"]);
  });

  it("does not resend an uncertain POST when the task is not yet visible", async () => {
    const f = taskFixture();
    f.amo.createTask.mockRejectedValueOnce(Error("timeout"));
    await expect(f.service.ensureForLead(222)).rejects.toThrow("timeout");
    await expect(f.service.ensureForLead(222)).rejects.toThrow(
      "RECONCILIATION_REQUIRED",
    );
    expect(f.amo.createTask).toHaveBeenCalledTimes(1);
  });

  it("does not create from failed reads, closed leads or unassigned leads", async () => {
    const f = taskFixture();
    f.amo.getTasksForEntities.mockRejectedValueOnce(Error("read failed"));
    await expect(f.service.ensureForLead(222)).rejects.toThrow("read failed");
    expect(f.receipts.size).toBe(0);
    f.amo.getLead.mockResolvedValueOnce({
      ...lead(222, 143),
      responsible_user_id: 765,
    });
    await f.service.ensureForLead(222);
    f.amo.getLead.mockResolvedValueOnce({
      ...lead(222),
      responsible_user_id: 0,
    });
    await expect(f.service.ensureForLead(222)).rejects.toThrow(
      "RESPONSIBLE_MISSING",
    );
    expect(f.amo.createTask).not.toHaveBeenCalled();
  });
});

describe("recovery queue and complete task evidence", () => {
  it("advances independent bounded cursors only after jobs are queued", async () => {
    const prisma: any = {
      systemSetting: {
        findUnique: jest.fn().mockResolvedValue({ value: "cursor" }),
        upsert: jest.fn().mockResolvedValue({}),
      },
      client: {
        findMany: jest.fn().mockResolvedValue([
          { id: "after-cursor", amoLeadId: 222n },
          { id: "same-lead", amoLeadId: 222n },
        ]),
      },
    };
    const queue = { add: jest.fn().mockResolvedValue({}) };
    const service = new AmoUniquenessRecoveryService(prisma, queue as any);
    await service.runBatch();
    expect(queue.add).toHaveBeenCalledTimes(2); // one distinct lead per status sweep
    expect(prisma.client.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 50,
        where: expect.objectContaining({ id: { gt: "cursor" } }),
      }),
    );
    expect(prisma.systemSetting.upsert).toHaveBeenCalledTimes(2);
    queue.add.mockRejectedValueOnce(Error("redis unavailable"));
    prisma.systemSetting.upsert.mockClear();
    await expect(service.runBatch()).rejects.toThrow("redis unavailable");
    expect(prisma.systemSetting.upsert).not.toHaveBeenCalled();
  });

  it("retries the whole worker if status reading fails, before attempting a task", async () => {
    const webhooks: any = {
      reconcileLeadUniqueness: jest.fn().mockRejectedValue(Error("temporary")),
    };
    const tasks: any = { ensureForLead: jest.fn() };
    const worker = new AmoUniquenessProcessor(webhooks, tasks);
    await expect(
      worker.process({ data: { leadId: 222 } } as any),
    ).rejects.toThrow("temporary");
    expect(tasks.ensureForLead).not.toHaveBeenCalled();
  });

  it("refuses a truncated task listing instead of treating it as proof of absence", async () => {
    const amo = new AmoCrmAdapter();
    (amo as any).request = jest
      .fn()
      .mockResolvedValue({
        _embedded: {
          tasks: [
            { id: 1, entity_id: 222, entity_type: "leads", text: "task" },
          ],
        },
        _links: { next: { href: "next" } },
      });
    await expect(
      amo.getTasksForEntities("leads", [222], {
        limit: 1,
        maxPages: 1,
        requireComplete: true,
      }),
    ).rejects.toThrow("EVIDENCE_INCOMPLETE");
  });

  it("accepts an explicit empty response but refuses missing or unrelated task evidence", async () => {
    const amo = new AmoCrmAdapter();
    const request = jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        _embedded: {
          tasks: [
            { id: 1, entity_id: 999, entity_type: "leads", text: "task" },
          ],
        },
      });
    (amo as any).request = request;
    expect(
      (
        await amo.getTasksForEntities("leads", [222], { requireComplete: true })
      ).size,
    ).toBe(0);
    await expect(
      amo.getTasksForEntities("leads", [222], { requireComplete: true }),
    ).rejects.toThrow("EVIDENCE_INVALID");
    await expect(
      amo.getTasksForEntities("leads", [222], { requireComplete: true }),
    ).rejects.toThrow("EVIDENCE_INVALID");
  });
});
