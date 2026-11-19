import { ServiceUnavailableException } from "@nestjs/common";
import { FixationRequestService } from "./fixation-request.service";
import {
  markFixationPreflightFailure,
  withFixationFailureCode,
} from "./fixation-preflight";

const payload = {
  phone: "+79990000001",
  fullName: "Test client",
  project: "SILVER_BOR",
  agencyInn: "",
};
const matches = (row: any, where: any): boolean =>
  Object.entries(where).every(([key, value]: [string, any]) => {
    if (key === "OR")
      return value.some((condition: any) => matches(row, condition));
    if (value && typeof value === "object" && !(value instanceof Date)) {
      if ("not" in value) return row[key] != null && row[key] !== value.not;
      if ("in" in value) return value.in.includes(row[key]);
      if ("lte" in value) return row[key] != null && row[key] <= value.lte;
      if ("gt" in value) return row[key] != null && row[key] > value.gt;
    }
    return row[key] instanceof Date
      ? row[key].getTime() === value?.getTime()
      : row[key] === value;
  });

function fixture() {
  const rows: any[] = [],
    keys: any[] = [],
    clients: any[] = [];
  const update = (r: any, data: any) => {
    Object.assign(r, {
      ...data,
      ...(data.attempts?.increment
        ? { attempts: r.attempts + data.attempts.increment }
        : {}),
      updatedAt: new Date(),
    });
    return { ...r };
  };
  const prisma: any = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    $queryRaw: jest.fn().mockResolvedValue([]),
    broker: {
      findUnique: jest.fn(async ({ where }) => ({ id: where.id, role: 'BROKER', status: 'ACTIVE', phone: '+79990000010', fullName: where.id, brokerAgencies: [] })),
      findMany: jest.fn(async ({ where }) => where.id.in.map((id: string) => ({ id, fullName: id }))),
    },
    agency: { findUnique: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
    fixationRequest: {
      findFirst: jest.fn(async ({ where }) => {
        const row = rows.find((r) => matches(r, where));
        return row ? { ...row } : null;
      }),
      findUniqueOrThrow: jest.fn(async ({ where }) => {
        const row = rows.find((r) => matches(r, where));
        if (!row) throw Error("not found");
        return { ...row };
      }),
      findMany: jest.fn(async ({ where, take }) =>
        rows
          .filter((r) => matches(r, where))
          .slice(0, take)
          .map((r) => ({ ...r })),
      ),
      create: jest.fn(async ({ data }) => {
        const row = {
          id: `request-${rows.length + 1}`,
          state: "PENDING",
          phase: "CHECKING",
          attempts: 0,
          nextAttemptAt: new Date(0),
          leaseUntil: null,
          leaseToken: null,
          result: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        rows.push(row);
        return { ...row };
      }),
      updateMany: jest.fn(async ({ where, data }) => {
        const selected = rows.filter((r) => matches(r, where));
        selected.forEach((r) => update(r, data));
        return { count: selected.length };
      }),
    },
    fixationRequestKey: {
      findUnique: jest.fn(async ({ where: { actorId_key: w } }) => {
        const key = keys.find((k) => matches(k, w));
        return key
          ? { ...key, request: { ...rows.find((r) => r.id === key.requestId) } }
          : null;
      }),
      create: jest.fn(async ({ data }) => {
        keys.push(data);
        return data;
      }),
    },
    client: {
      findUnique: jest.fn(
        async ({ where }) => clients.find((c) => matches(c, where)) || null,
      ),
      findMany: jest.fn(async ({ where }) =>
        clients.filter((c) => matches(c, where)),
      ),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  prisma.$transaction = jest.fn(async (action) => action(prisma));
  const safety = {
    execute: jest.fn(async (_request, action) =>
      action({ assertOwned: jest.fn().mockResolvedValue(undefined) }),
    ),
  };
  const fixation = {
    fixClient: jest.fn(async (_actor, _payload, assertOwned, execution) => {
      await execution.beforeMutation();
      await assertOwned();
      return {
        client: { id: "client-1" },
        status: "UNDER_REVIEW",
        amoSyncStatus: "SYNCED",
        message: "На проверке",
      };
    }),
  };
  const makeService = () => {
    const service = new FixationRequestService(
      prisma,
      safety as any,
      fixation as any,
    );
    (service as any).logger = { warn: jest.fn(), error: jest.fn() };
    return service;
  };
  return {
    prisma,
    rows,
    keys,
    clients,
    safety,
    fixation,
    makeService,
    service: makeService(),
  };
}

describe("durable fixation intake and delivery boundary", () => {
  it('shows a pending delegated request to its author and verified recipient only', async () => {
    const f = fixture();
    const accepted = await f.service.submit('author', { ...payload, responsibleBrokerId: 'recipient' }, 'delegated');
    expect(accepted.responsibleBroker).toMatchObject({ id: 'recipient' });
    expect(await f.service.get('recipient', accepted.requestId)).toMatchObject({ requestState: 'PENDING' });
    expect((await f.service.list('recipient')).map(row => row.requestId)).toEqual([accepted.requestId]);
    expect((await f.service.list('author', true)).map(row => row.requestId)).toEqual([accepted.requestId]);
    await expect(f.service.get('unrelated', accepted.requestId)).rejects.toThrow('Заявка не найдена');
    expect(await f.service.list('unrelated')).toEqual([]);
    expect(await f.service.list('recipient', true)).toEqual([]);
    for (const state of ['PROCESSING', 'RETRY', 'DELIVERY_PENDING', 'NEEDS_REVIEW', 'COMPLETED']) {
      f.rows[0].state = state;
      expect((await f.service.list('recipient')).map(row => row.requestId)).toEqual([accepted.requestId]);
    }
  });

  it('validates the destination before persisting a receipt or exposing submitted data', async () => {
    const f = fixture();
    f.prisma.broker.findUnique.mockResolvedValueOnce({ id: 'author' }).mockResolvedValueOnce(null);
    await expect(f.service.submit('author', { ...payload, responsibleBrokerId: 'missing' }, 'bad')).rejects.toThrow();
    expect(f.rows).toHaveLength(0);
    expect(f.keys).toHaveLength(0);
    expect(f.fixation.fixClient).not.toHaveBeenCalled();
  });

  it('pins the verified destination across delivery retries and lost acknowledgements', async () => {
    const f = fixture();
    const accepted = await f.service.submit('author', { ...payload, responsibleBrokerId: 'recipient' }, 'delegated');
    await f.service.process(accepted.requestId);
    expect(f.fixation.fixClient).toHaveBeenCalledWith('author', expect.anything(), expect.any(Function), expect.objectContaining({ responsibleBrokerId: 'recipient' }));
    expect(await f.service.submit('author', { ...payload, responsibleBrokerId: 'recipient' }, 'delegated')).toMatchObject({ requestId: accepted.requestId });
    expect(f.rows).toHaveLength(1);
  });

  it.each(["PENDING", "FAILED"])(
    "does not report a %s delivery as completed or rerun its creation",
    async (deliveryState) => {
      const f = fixture();
      f.fixation.fixClient.mockImplementationOnce(
        async (_actor, _payload, _assert, execution) => {
          await execution.beforeMutation();
          return {
            client: { id: "client-1" },
            status: "UNDER_REVIEW",
            amoSyncStatus: deliveryState,
            message: "queued",
          };
        },
      );
      const request = await f.service.submit("actor", payload, "key");
      await f.service.process(request.requestId);
      expect(await f.service.get("actor", request.requestId)).toMatchObject({
        requestState: "DELIVERY_PENDING",
        status: "ACCEPTED",
      });
      f.rows[0].nextAttemptAt = new Date(0);
      await f.service.drain();
      expect(f.fixation.fixClient).toHaveBeenCalledTimes(1);
    },
  );

  it("recovers a lost transaction acknowledgement from its durable key", async () => {
    const f = fixture();
    f.prisma.$transaction.mockImplementationOnce(async (action) => {
      await action(f.prisma);
      throw Error("commit response lost");
    });
    const request = await f.service.submit("actor", payload, "key");
    expect(request.requestState).toBe("PENDING");
    expect(f.rows).toHaveLength(1);
    expect(f.fixation.fixClient).not.toHaveBeenCalled();
  });

  it("saves before CRM work, and replays the same key after process restart", async () => {
    const f = fixture();
    const first = await f.service.submit("actor", payload, "key");
    expect(first.requestState).toBe("PENDING");
    expect(f.fixation.fixClient).not.toHaveBeenCalled();
    await f.service.process(first.requestId);
    const replay = await f.makeService().submit("actor", payload, "key");
    expect(replay).toMatchObject({
      requestId: first.requestId,
      requestState: "COMPLETED",
      status: "UNDER_REVIEW",
    });
    expect(f.rows).toHaveLength(1);
    expect(f.fixation.fixClient).toHaveBeenCalledTimes(1);
  });

  it("keeps a second tab alias even after the original request completes", async () => {
    const f = fixture();
    const first = await f.service.submit("actor", payload, "tab-1");
    const second = await f.service.submit("actor", payload, "tab-2");
    expect(second.requestId).toBe(first.requestId);
    await f.service.process(first.requestId);
    expect((await f.service.submit("actor", payload, "tab-2")).requestId).toBe(
      first.requestId,
    );
    expect(f.rows).toHaveLength(1);
    expect(f.keys).toHaveLength(2);
  });

  it("allows an intentional new submission after completion, and isolates actors", async () => {
    const f = fixture();
    const first = await f.service.submit("actor", payload, "key");
    await f.service.process(first.requestId);
    expect(
      (await f.service.submit("actor", payload, "new-intent")).requestId,
    ).not.toBe(first.requestId);
    expect(
      (await f.service.submit("another-actor", payload, "key")).requestId,
    ).not.toBe(first.requestId);
    await expect(
      f.service.get("another-actor", first.requestId),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("refuses to reuse a key with changed input", async () => {
    const f = fixture();
    await f.service.submit("actor", payload, "key");
    await expect(
      f.service.submit("actor", { ...payload, fullName: "Changed" }, "key"),
    ).rejects.toMatchObject({ status: 400 });
    expect(f.rows).toHaveLength(1);
  });

  it("retries proven temporary preflight failures without creating a second request", async () => {
    const f = fixture();
    const error = markFixationPreflightFailure(
      withFixationFailureCode(
        new ServiceUnavailableException("upstream failed"),
        "AMO_NETWORK_ERROR",
      ),
    );
    f.fixation.fixClient.mockRejectedValueOnce(error);
    const accepted = await f.service.submit("actor", payload, "key");
    await f.service.process(accepted.requestId);
    expect(f.rows[0]).toMatchObject({
      state: "RETRY",
      phase: "CHECKING",
      attempts: 1,
      errorCode: "AMO_NETWORK_ERROR",
    });
    f.rows[0].nextAttemptAt = new Date(0);
    await f.makeService().process(accepted.requestId);
    expect(f.rows[0].state).toBe("COMPLETED");
    expect(f.fixation.fixClient).toHaveBeenCalledTimes(2);
    expect(f.rows).toHaveLength(1);
  });

  it("never retries an uncertain failure after the mutation checkpoint", async () => {
    const f = fixture();
    f.fixation.fixClient.mockImplementationOnce(
      async (_a, _b, _c, execution) => {
        await execution.beforeMutation();
        throw Error("response lost after POST; private details");
      },
    );
    const accepted = await f.service.submit("actor", payload, "key");
    await f.service.process(accepted.requestId);
    expect(f.rows[0]).toMatchObject({
      state: "NEEDS_REVIEW",
      phase: "MUTATING",
    });
    f.rows[0].nextAttemptAt = new Date(0);
    await f.makeService().drain();
    await f.makeService().process(accepted.requestId);
    expect(f.fixation.fixClient).toHaveBeenCalledTimes(1);
    expect(
      JSON.stringify(await f.service.get("actor", accepted.requestId)),
    ).not.toContain("private details");
  });

  it("claims a request only once when workers race", async () => {
    const f = fixture();
    const request = await f.service.submit("actor", payload, "key");
    await Promise.all([
      f.service.process(request.requestId),
      f.makeService().process(request.requestId),
    ]);
    expect(f.fixation.fixClient).toHaveBeenCalledTimes(1);
  });

  it("resumes an expired checking lease but never replays an expired mutating lease", async () => {
    const f = fixture();
    const one = await f.service.submit("actor", payload, "key");
    Object.assign(f.rows[0], {
      state: "PROCESSING",
      phase: "CHECKING",
      leaseUntil: new Date(0),
    });
    await f.makeService().drain();
    expect(f.rows[0].state).toBe("COMPLETED");
    const two = await f.service.submit("actor", payload, "another");
    Object.assign(f.rows[1], {
      state: "PROCESSING",
      phase: "MUTATING",
      leaseUntil: new Date(0),
    });
    await f.makeService().drain();
    expect(f.rows[1].state).toBe("NEEDS_REVIEW");
    expect(f.fixation.fixClient).toHaveBeenCalledTimes(1);
    f.clients.push({
      id: "linked-client",
      fixationRequestId: two.requestId,
      amoLeadId: 123n,
      amoSyncStatus: "SYNCED",
      uniquenessStatus: "REJECTED",
    });
    f.rows[1].nextAttemptAt = new Date(0);
    await f.makeService().drain();
    expect(f.rows[1]).toMatchObject({
      state: "COMPLETED",
      result: { status: "REJECTED" },
    });
    expect(f.fixation.fixClient).toHaveBeenCalledTimes(1);
  });

  it("does not retry deterministic unknown stages or exhaust temporary errors forever", async () => {
    const f = fixture();
    const error = markFixationPreflightFailure(
      withFixationFailureCode(
        new ServiceUnavailableException(),
        "AMO_UNIQUENESS_LEAD_STAGE_UNRECOGNIZED",
      ),
    );
    f.fixation.fixClient.mockRejectedValueOnce(error);
    const request = await f.service.submit("actor", payload, "key");
    await f.service.process(request.requestId);
    expect(f.rows[0]).toMatchObject({
      state: "NEEDS_REVIEW",
      phase: "CHECKING",
      errorCode: "AMO_UNIQUENESS_LEAD_STAGE_UNRECOGNIZED",
    });
  });

  it("shows the current linked client status after a webhook, including a repeated submission", async () => {
    const f = fixture();
    const request = await f.service.submit("actor", payload, "key");
    await f.service.process(request.requestId);
    f.clients.push({
      id: "client-1",
      fixationRequestId: request.requestId,
      uniquenessStatus: "REJECTED",
    });
    expect(await f.service.get("actor", request.requestId)).toMatchObject({
      status: "REJECTED",
    });
    expect(await f.service.list("actor")).toEqual([
      expect.objectContaining({ status: "REJECTED" }),
    ]);
    expect(await f.service.submit("actor", payload, "key")).toMatchObject({
      status: "REJECTED",
    });
    expect(f.fixation.fixClient).toHaveBeenCalledTimes(1);
  });

  it("permits an audited staff retry only before mutation, and only once", async () => {
    const f = fixture();
    const request = await f.service.submit("actor", payload, "key");
    Object.assign(f.rows[0], {
      state: "NEEDS_REVIEW",
      phase: "CHECKING",
      attempts: 6,
    });
    expect(await f.service.reviewQueue()).toEqual([
      expect.objectContaining({ canRetryCheck: true }),
    ]);
    await f.service.retryCheck("manager", request.requestId);
    expect(f.rows[0]).toMatchObject({ state: "RETRY", attempts: 0 });
    expect(f.prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "manager",
        entityId: request.requestId,
      }),
    });
    await expect(
      f.service.retryCheck("manager", request.requestId),
    ).rejects.toMatchObject({ status: 400 });
    Object.assign(f.rows[0], { state: "NEEDS_REVIEW", phase: "MUTATING" });
    expect(await f.service.reviewQueue()).toEqual([
      expect.objectContaining({ canRetryCheck: false }),
    ]);
    await expect(
      f.service.retryCheck("manager", request.requestId),
    ).rejects.toMatchObject({ status: 400 });
    expect(f.prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(f.fixation.fixClient).not.toHaveBeenCalled();
  });

  it("stops automatic attempts at the configured limit", async () => {
    const f = fixture();
    const request = await f.service.submit("actor", payload, "key");
    f.rows[0].attempts = 5;
    f.fixation.fixClient.mockRejectedValue(
      markFixationPreflightFailure(
        withFixationFailureCode(new Error(), "AMO_NETWORK_ERROR"),
      ),
    );
    await f.service.process(request.requestId);
    expect(f.rows[0]).toMatchObject({
      state: "NEEDS_REVIEW",
      phase: "CHECKING",
      attempts: 6,
    });
    f.rows[0].nextAttemptAt = new Date(0);
    await f.service.drain();
    expect(f.fixation.fixClient).toHaveBeenCalledTimes(1);
  });
});
