import {
  AgencyCompanySyncService,
  AgencyCompanyReader,
  AMO_AGENCY_COMPANY_SYNC_RULE_VERSION,
  AMO_AGENCY_COMPANY_SYNC_STATE_KEY,
  agencyCompanySyncErrorCode,
} from "./agency-company-sync.service";

const INN_A = "9702028892";
const INN_B = "7701234567";
const INN_C = "7707654321";
const NOW = Date.parse("2026-11-09T12:00:00.000Z");
const field = (id: number, value: unknown) => ({
  field_id: id,
  values: [{ value }],
});
const company = (inn: string, website = "example.ru") => ({
  id: 1,
  updated_at: 1794042040,
  custom_fields_values: [field(663911, inn), field(557907, website)],
});
const readResponse = (inn = INN_A) => ({
  items: [company(inn)],
  pagesRead: 1,
  complete: true as const,
  readAt: new Date().toISOString(),
});
const cursorState = (
  cursor: string | null = null,
  error: string | null = null,
) => ({
  version: 1,
  cursor,
  cycleStartedAt: cursor ? new Date(NOW - 1000).toISOString() : null,
  lastCompleteAt: null,
  lastErrorCode: error,
  cycleInvalidInn: 0,
});
const oldSnapshot = (agencyId = "a") => ({
  agencyId,
  linkStatus: "LINKED",
  companyIds: ["old-company"],
  profile: { website: "https://old.example/" },
  fieldSources: {
    website: { source: "AMOCRM_COMPANY", companyIds: ["old-company"] },
  },
  conflicts: {},
  contracts: [],
  sourceUpdatedAt: new Date(NOW - 100000),
  lastAttemptAt: new Date(NOW - 100000),
  lastSuccessAt: new Date(NOW - 100000),
  errorCode: null,
  contentHash: "old-content-hash",
});

function fixture(options: any = {}) {
  const agencies = options.agencies || [
    { id: "a", inn: INN_A, callContacts: [{ person: "manual" }] },
  ];
  const snapshots = new Map<string, any>(
    (options.snapshots || []).map((row: any) => [
      row.agencyId,
      structuredClone(row),
    ]),
  );
  const runs = new Map<string, any>();
  if (options.running)
    runs.set(options.running.id, {
      source: "AMOCRM",
      status: "RUNNING",
      ...options.running,
    });
  const settings = new Map<string, any>();
  if (options.state !== undefined)
    settings.set(AMO_AGENCY_COMPANY_SYNC_STATE_KEY, {
      value:
        typeof options.state === "string"
          ? options.state
          : JSON.stringify(options.state),
    });
  let sequence = 0;
  const matches = (agency: any, where: any): boolean => {
    if (where?.AND) return where.AND.every((w: any) => matches(agency, w));
    if (where?.id?.in && !where.id.in.includes(agency.id)) return false;
    if (where?.id?.gt && agency.id <= where.id.gt) return false;
    return true;
  };
  const prisma: any = {
    $queryRaw: jest.fn(async (_sql: unknown, id: string) =>
      agencies
        .filter((row: any) => row.id === id)
        .map(({ id, inn }: any) => ({ id, inn })),
    ),
    agency: {
      count: jest.fn(
        async ({ where }) =>
          agencies.filter((row: any) => matches(row, where)).length,
      ),
      findMany: jest.fn(async ({ where, take }) =>
        agencies
          .filter((row: any) => matches(row, where))
          .sort((a: any, b: any) => a.id.localeCompare(b.id))
          .slice(0, take)
          .map(({ id, inn }: any) => ({ id, inn })),
      ),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    broker: {
      findFirst: jest.fn(async () =>
        options.noAdmin ? null : { id: "existing-admin" },
      ),
      create: jest.fn(),
    },
    loyaltySyncRun: {
      findFirst: jest.fn(
        async () =>
          [...runs.values()].find(
            (row) => row.source === "AMOCRM" && row.status === "RUNNING",
          ) || null,
      ),
      create: jest.fn(async ({ data }) => {
        if (
          [...runs.values()].some(
            (row) => row.status === "RUNNING" && row.source === data.source,
          )
        )
          throw Object.assign(new Error("duplicate"), { code: "P2002" });
        const id = `run-${++sequence}`;
        runs.set(id, { id, ...data, startedAt: new Date() });
        return { id };
      }),
      updateMany: jest.fn(async ({ where, data }) => {
        const row = runs.get(where.id);
        if (
          !row ||
          row.status !== where.status ||
          row.source !== where.source ||
          row.ruleVersion !== where.ruleVersion
        )
          return { count: 0 };
        runs.set(where.id, { ...row, ...structuredClone(data) });
        return { count: 1 };
      }),
    },
    agencyAmoCompanySync: {
      findUnique: jest.fn(async ({ where }) =>
        structuredClone(snapshots.get(where.agencyId) || null),
      ),
      upsert: jest.fn(async ({ where, create, update }) => {
        const old = snapshots.get(where.agencyId);
        const row = old
          ? { ...old, ...structuredClone(update) }
          : {
              profile: {},
              companyIds: [],
              fieldSources: {},
              conflicts: {},
              contracts: [],
              contentHash: null,
              sourceUpdatedAt: null,
              lastSuccessAt: null,
              ...structuredClone(create),
            };
        snapshots.set(where.agencyId, row);
        return structuredClone(row);
      }),
    },
    systemSetting: {
      findUnique: jest.fn(async ({ where }) => settings.get(where.key) || null),
      upsert: jest.fn(async ({ where, create, update }) => {
        const row = settings.has(where.key) ? update : create;
        settings.set(where.key, structuredClone(row));
        return row;
      }),
    },
  };
  prisma.$transaction = jest.fn(async (operation) => {
    const before = {
      snapshots: structuredClone(snapshots),
      settings: structuredClone(settings),
      runs: structuredClone(runs),
    };
    try {
      return await operation(prisma);
    } catch (error) {
      for (const [map, old] of [
        [snapshots, before.snapshots],
        [settings, before.settings],
        [runs, before.runs],
      ] as any) {
        map.clear();
        for (const [key, value] of old) map.set(key, value);
      }
      throw error;
    }
  });
  const reader = {
    findCompaniesByInnStrict: jest.fn(async (inn: string) => readResponse(inn)),
  };
  const alerts = {
    sendSafely: jest.fn(async (_message: string, _options: any) => true),
  };
  const service = new AgencyCompanySyncService(prisma, alerts as any);
  service.setAdapter(reader as AgencyCompanyReader);
  jest
    .spyOn((service as any).logger, "log")
    .mockImplementation(() => undefined);
  jest
    .spyOn((service as any).logger, "warn")
    .mockImplementation(() => undefined);
  return {
    service,
    prisma,
    reader,
    alerts,
    snapshots,
    settings,
    runs,
    agencies,
    state: () =>
      JSON.parse(
        settings.get(AMO_AGENCY_COMPANY_SYNC_STATE_KEY)?.value || "null",
      ),
  };
}

describe("agency company snapshot sync", () => {
  beforeEach(() => jest.useFakeTimers({ now: NOW }));
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("completes all 1008 agencies and starts a fresh full cycle the next day", async () => {
    const agencies = Array.from({ length: 1008 }, (_, i) => ({
      id: String(i).padStart(4, "0"),
      inn: String(7700000000 + i),
    }));
    const fx = fixture({ agencies });
    for (let day = 0; day < 2; day++) {
      const result = await fx.service.run({ mode: "apply" });
      expect(result).toMatchObject({
        status: "SUCCEEDED",
        stats: {
          processed: 1008,
          deferred: 0,
          resumed: false,
          cycleComplete: true,
        },
      });
      expect(fx.state().cursor).toBeNull();
      jest.advanceTimersByTime(86400000);
    }
    expect(fx.reader.findCompaniesByInnStrict).toHaveBeenCalledTimes(2016);
  });

  it.each(["changed", "deleted", "changed-before-error"])(
    "rejects stale agency identity after a lookup: %s",
    async (scenario) => {
      const old = oldSnapshot();
      const fx = fixture({ snapshots: [old] });
      fx.reader.findCompaniesByInnStrict.mockImplementationOnce(async () => {
        if (scenario === "deleted") fx.agencies.splice(0, 1);
        else fx.agencies[0].inn = INN_B;
        if (scenario === "changed-before-error")
          throw new Error("amoCRM 429 /companies");
        return readResponse();
      });
      expect(await fx.service.run({ mode: "apply" })).toMatchObject({
        status: "FAILED",
        errorCode: "AGENCY_IDENTITY_CHANGED",
        stats: { processed: 0 },
      });
      expect(fx.snapshots.get("a")).toEqual(old);
      expect(fx.prisma.agencyAmoCompanySync.upsert).not.toHaveBeenCalled();
      expect(fx.state().cursor).toBeNull();
    },
  );

  it("keeps the source lock until the awaited failure alert completes", async () => {
    const fx = fixture();
    let release: () => void = () => undefined;
    fx.alerts.sendSafely.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          release = () => resolve(true);
        }),
    );
    fx.reader.findCompaniesByInnStrict.mockRejectedValueOnce(
      new Error("AMO_ACCESS_TOKEN not configured"),
    );
    const pending = fx.service.run({ mode: "apply" });
    for (let i = 0; i < 100 && !fx.alerts.sendSafely.mock.calls.length; i++)
      await Promise.resolve();
    expect(fx.alerts.sendSafely).toHaveBeenCalledTimes(1);
    expect([...fx.runs.values()][0].status).toBe("RUNNING");
    expect(await fx.service.run({ mode: "apply" })).toMatchObject({
      status: "SKIPPED",
    });
    release();
    expect(await pending).toMatchObject({
      status: "FAILED",
      errorCode: "AMO_AUTH_ERROR",
    });
    expect([...fx.runs.values()][0].status).toBe("FAILED");
  });

  it("uses the shared AMOCRM lock and existing admin, and writes only the source snapshot", async () => {
    const fx = fixture();
    const manual = structuredClone(fx.agencies);
    const result = await fx.service.run({ mode: "apply" });
    expect(result).toMatchObject({
      status: "SUCCEEDED",
      stats: {
        total: 1,
        processed: 1,
        linked: 1,
        written: 1,
        scopeComplete: true,
        cycleComplete: true,
      },
    });
    expect(fx.prisma.loyaltySyncRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          source: "AMOCRM",
          status: "RUNNING",
          requestedById: "existing-admin",
          ruleVersion: AMO_AGENCY_COMPANY_SYNC_RULE_VERSION,
        }),
      }),
    );
    expect(fx.reader.findCompaniesByInnStrict).toHaveBeenCalledWith(INN_A, {
      maxPages: 4,
      deadlineAt: NOW + 20 * 60 * 1000,
    });
    expect(fx.snapshots.get("a")).toMatchObject({
      profile: { website: "https://example.ru/" },
      linkStatus: "LINKED",
      errorCode: null,
      lastSuccessAt: new Date(NOW),
    });
    expect(fx.agencies).toEqual(manual);
    expect(fx.prisma.agency.update).not.toHaveBeenCalled();
    expect(fx.prisma.agency.updateMany).not.toHaveBeenCalled();
    expect(fx.prisma.broker.create).not.toHaveBeenCalled();
    expect(fx.runs.get(result.runId)).toMatchObject({
      status: "SUCCEEDED",
      contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("performs real reads in dry-run without snapshot or cursor writes", async () => {
    const state = cursorState("a", "AMO_AUTH_ERROR");
    const fx = fixture({
      state,
      agencies: [
        { id: "a", inn: INN_A },
        { id: "b", inn: INN_B },
      ],
    });
    const result = await fx.service.run({ mode: "dry-run" });
    expect(result).toMatchObject({
      status: "SUCCEEDED",
      stats: { lookups: 2, written: 0, resumed: false },
    });
    expect(fx.prisma.agencyAmoCompanySync.upsert).not.toHaveBeenCalled();
    expect(fx.prisma.systemSetting.upsert).not.toHaveBeenCalled();
    expect(fx.state()).toEqual(state);
    expect(fx.alerts.sendSafely).not.toHaveBeenCalled();
  });

  it("never steals a live shared lock", async () => {
    const fx = fixture({
      running: {
        id: "touch",
        startedAt: new Date(NOW - 1000),
        ruleVersion: "amo-touch-v1",
      },
    });
    expect(await fx.service.run({ mode: "apply" })).toMatchObject({
      status: "SKIPPED",
      runId: null,
    });
    expect(fx.prisma.loyaltySyncRun.updateMany).not.toHaveBeenCalled();
    expect(fx.prisma.loyaltySyncRun.create).not.toHaveBeenCalled();
    expect(fx.reader.findCompaniesByInnStrict).not.toHaveBeenCalled();
    expect(fx.alerts.sendSafely).not.toHaveBeenCalled();
  });

  it("alerts and skips a four-hour-old lock without terminating its owner", async () => {
    const fx = fixture({
      running: {
        id: "touch",
        startedAt: new Date(NOW - 5 * 3600000),
        ruleVersion: "amo-touch-v1",
      },
    });
    expect(await fx.service.run({ mode: "apply" })).toMatchObject({
      status: "SKIPPED",
      errorCode: "STALE_RUNNING_RUN",
    });
    expect(fx.runs.get("touch").status).toBe("RUNNING");
    expect(fx.prisma.loyaltySyncRun.updateMany).not.toHaveBeenCalled();
    expect(fx.alerts.sendSafely).toHaveBeenCalledWith(
      expect.stringContaining("STALE_RUNNING_RUN"),
      expect.objectContaining({ dedupKey: "amo-agency-company-sync:failure" }),
    );
  });

  it("skips the P2002 race and permits only one concurrent source reader", async () => {
    const fx = fixture();
    const results = await Promise.all([
      fx.service.run({ mode: "apply" }),
      fx.service.run({ mode: "apply" }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      "SKIPPED",
      "SUCCEEDED",
    ]);
    expect(fx.reader.findCompaniesByInnStrict).toHaveBeenCalledTimes(1);
    expect(fx.snapshots.size).toBe(1);
  });

  it("fails safely when no admin actor exists", async () => {
    const fx = fixture({ noAdmin: true });
    expect(await fx.service.run({ mode: "apply" })).toMatchObject({
      status: "FAILED",
      runId: null,
      errorCode: "ADMIN_ACTOR_NOT_FOUND",
    });
    expect(fx.prisma.loyaltySyncRun.create).not.toHaveBeenCalled();
    expect(fx.reader.findCompaniesByInnStrict).not.toHaveBeenCalled();
  });

  it("preserves the entire previous successful snapshot on NOT_FOUND", async () => {
    const old = oldSnapshot();
    const fx = fixture({ snapshots: [old] });
    fx.reader.findCompaniesByInnStrict.mockResolvedValue({
      ...readResponse(),
      items: [],
    });
    const result = await fx.service.run({ mode: "apply" });
    expect(result).toMatchObject({
      status: "SUCCEEDED",
      stats: { notFound: 1 },
    });
    expect(fx.snapshots.get("a")).toEqual({
      ...old,
      lastAttemptAt: new Date(NOW),
      errorCode: "COMPANY_NOT_FOUND",
    });
    expect(fx.alerts.sendSafely).not.toHaveBeenCalled();
  });

  it("creates an initial NOT_FOUND record without inventing source freshness", async () => {
    const fx = fixture();
    fx.reader.findCompaniesByInnStrict.mockResolvedValue({
      ...readResponse(),
      items: [],
    });
    await fx.service.run({ mode: "apply" });
    expect(fx.snapshots.get("a")).toMatchObject({
      linkStatus: "NOT_FOUND",
      lastSuccessAt: null,
      contentHash: null,
      profile: {},
      errorCode: "COMPANY_NOT_FOUND",
    });
  });

  it.each([
    [
      new Error("amoCRM 401 /companies?query=9702028892 Bearer PRIVATE_TOKEN"),
      "AMO_AUTH_ERROR",
    ],
    [
      Object.assign(new Error("private response"), { status: 403 }),
      "AMO_AUTH_ERROR",
    ],
    [new Error("AMO_ACCESS_TOKEN not configured"), "AMO_AUTH_ERROR"],
    [new Error("amoCRM 429 /companies"), "AMO_RATE_LIMIT"],
    [
      Object.assign(new Error("private response"), { name: "TimeoutError" }),
      "AMO_TIMEOUT",
    ],
    [new Error("amoCRM network error /companies"), "AMO_UNAVAILABLE"],
    [new Error("AMO_COMPANY_PAGE_BOUND_EXCEEDED"), "AMO_PAGINATION_LIMIT"],
    [new Error("AMO_COMPANY_PAGE_ORDER_INVALID"), "AMO_INVALID_RESPONSE"],
  ])(
    "preserves successful evidence on source failure %p",
    async (error, code) => {
      const old = oldSnapshot();
      const fx = fixture({ snapshots: [old] });
      fx.reader.findCompaniesByInnStrict.mockRejectedValue(error);
      const result = await fx.service.run({ mode: "apply" });
      expect(result).toMatchObject({
        status: "FAILED",
        errorCode: code,
        stats: { deferred: 1, processed: 0 },
      });
      expect(fx.snapshots.get("a")).toEqual({
        ...old,
        lastAttemptAt: new Date(NOW),
        errorCode: code,
      });
      expect(fx.reader.findCompaniesByInnStrict).toHaveBeenCalledTimes(1);
      expect(fx.state()).toMatchObject({ cursor: null, lastErrorCode: code });
      const publicRecord = JSON.stringify({
        result,
        run: fx.runs.get(result.runId),
        alerts: fx.alerts.sendSafely.mock.calls,
      });
      expect(publicRecord).not.toContain(INN_A);
      expect(publicRecord).not.toContain("PRIVATE_TOKEN");
      expect(fx.alerts.sendSafely).toHaveBeenCalledWith(
        expect.stringContaining(code),
        { dedupKey: "amo-agency-company-sync:failure", cooldownMs: 3600000 },
      );
    },
  );

  it.each([
    { ...readResponse(), complete: false },
    { ...readResponse(), pagesRead: 5 },
    { ...readResponse(), items: null },
    { ...readResponse(), readAt: "not-a-date" },
  ])("rejects incomplete or invalid reader response %p", async (response) => {
    const fx = fixture({ snapshots: [oldSnapshot()] });
    fx.reader.findCompaniesByInnStrict.mockResolvedValue(response as any);
    expect(await fx.service.run({ mode: "apply" })).toMatchObject({
      status: "FAILED",
      errorCode: "AMO_INVALID_RESPONSE",
    });
    expect(fx.snapshots.get("a").profile.website).toBe("https://old.example/");
  });

  it("continues from the persisted cursor after quota and resets after the whole cycle", async () => {
    const fx = fixture({
      agencies: [
        { id: "c", inn: INN_C },
        { id: "a", inn: INN_A },
        { id: "b", inn: INN_B },
      ],
    });
    const first = await fx.service.run({ mode: "apply", maxAgencies: 1 });
    expect(first).toMatchObject({
      status: "FAILED",
      errorCode: "AGENCY_QUOTA_EXCEEDED",
      stats: { processed: 1, deferred: 2 },
    });
    expect(fx.state()).toMatchObject({ cursor: "a" });
    const second = await fx.service.run({ mode: "apply", maxAgencies: 1 });
    expect(second).toMatchObject({
      status: "FAILED",
      stats: { resumed: true, remainingAtStart: 2, deferred: 1 },
    });
    expect(fx.state().cursor).toBe("b");
    const third = await fx.service.run({ mode: "apply", maxAgencies: 1 });
    expect(third).toMatchObject({
      status: "SUCCEEDED",
      stats: {
        total: 3,
        remainingAtStart: 1,
        processed: 1,
        cycleComplete: true,
      },
    });
    expect(fx.state()).toMatchObject({ cursor: null, lastErrorCode: null });
    await fx.service.run({ mode: "apply" });
    expect(
      fx.reader.findCompaniesByInnStrict.mock.calls.map((call) => call[0]),
    ).toEqual([INN_A, INN_B, INN_C, INN_A, INN_B, INN_C]);
    expect(
      fx.alerts.sendSafely.mock.calls.filter((call) =>
        call[1].dedupKey.endsWith(":recovery"),
      ),
    ).toHaveLength(0);
  });

  it("leaves a failed current INN ahead of the next resume and stops after deadline", async () => {
    const fx = fixture({
      agencies: [
        { id: "a", inn: INN_A },
        { id: "b", inn: INN_B },
      ],
    });
    fx.reader.findCompaniesByInnStrict.mockImplementation(async (inn) => {
      if (inn === INN_B) jest.advanceTimersByTime(1001);
      return readResponse(inn);
    });
    expect(
      await fx.service.run({ mode: "apply", deadlineMs: 1000 }),
    ).toMatchObject({
      status: "FAILED",
      errorCode: "DEADLINE_EXCEEDED",
      stats: { processed: 1, deferred: 1 },
    });
    expect(fx.state().cursor).toBe("a");
    expect(fx.snapshots.get("b")).toMatchObject({
      profile: {},
      lastSuccessAt: null,
      errorCode: "DEADLINE_EXCEEDED",
    });
    fx.reader.findCompaniesByInnStrict.mockImplementation(async (inn) =>
      readResponse(inn),
    );
    expect(await fx.service.run({ mode: "apply" })).toMatchObject({
      status: "SUCCEEDED",
      stats: { resumed: true, processed: 1 },
    });
  });

  it("does not send an API request when preflight consumed the deadline", async () => {
    const fx = fixture();
    const count = fx.prisma.agency.count.getMockImplementation();
    fx.prisma.agency.count.mockImplementation(async (args) => {
      jest.advanceTimersByTime(1000);
      return count(args);
    });
    expect(
      await fx.service.run({ mode: "apply", deadlineMs: 1000 }),
    ).toMatchObject({ status: "FAILED", errorCode: "DEADLINE_EXCEEDED" });
    expect(fx.reader.findCompaniesByInnStrict).not.toHaveBeenCalled();
  });

  it("rolls back snapshot and cursor together if a write crosses deadline", async () => {
    const fx = fixture({ snapshots: [oldSnapshot()] });
    const upsert =
      fx.prisma.agencyAmoCompanySync.upsert.getMockImplementation();
    fx.prisma.agencyAmoCompanySync.upsert.mockImplementationOnce(
      async (args) => {
        const result = await upsert(args);
        jest.advanceTimersByTime(2000);
        return result;
      },
    );
    expect(
      await fx.service.run({ mode: "apply", deadlineMs: 1000 }),
    ).toMatchObject({ status: "FAILED", errorCode: "DEADLINE_EXCEEDED" });
    expect(fx.snapshots.get("a")).toMatchObject({
      profile: oldSnapshot().profile,
      contentHash: "old-content-hash",
      lastSuccessAt: oldSnapshot().lastSuccessAt,
    });
    expect(fx.state().cursor).toBeNull();
  });

  it("preserves the global continuation cursor during a targeted run", async () => {
    const state = cursorState("b", "AGENCY_QUOTA_EXCEEDED");
    const fx = fixture({
      state,
      agencies: [
        { id: "a", inn: INN_A },
        { id: "c", inn: INN_C },
      ],
    });
    expect(
      await fx.service.run({ mode: "apply", agencyIds: ["a", "a"] }),
    ).toMatchObject({
      status: "SUCCEEDED",
      stats: { total: 1, resumed: false, cycleComplete: false },
    });
    expect(fx.state()).toEqual(state);
    expect(fx.prisma.systemSetting.upsert).not.toHaveBeenCalled();
    expect(fx.alerts.sendSafely).not.toHaveBeenCalled();
  });

  it("updates freshness and provenance timestamps when content is unchanged", async () => {
    const fx = fixture();
    await fx.service.run({ mode: "apply" });
    const before = structuredClone(fx.snapshots.get("a"));
    jest.advanceTimersByTime(60000);
    const result = await fx.service.run({ mode: "apply" });
    expect(result.stats).toMatchObject({ changed: 0, unchanged: 1 });
    const after = fx.snapshots.get("a");
    expect(after.contentHash).toBe(before.contentHash);
    expect(after.profile).toEqual(before.profile);
    expect(after.lastSuccessAt.getTime()).toBe(NOW + 60000);
    expect(after.fieldSources.website.checkedAt).toBe(
      new Date(NOW + 60000).toISOString(),
    );
    expect(
      fx.prisma.agencyAmoCompanySync.upsert.mock.calls.at(-1)[0].update,
    ).not.toHaveProperty("profile");
  });

  it("reads the same normalized INN once and applies evidence to each local agency", async () => {
    const fx = fixture({
      agencies: [
        { id: "a", inn: INN_A },
        { id: "b", inn: "9702 028892" },
      ],
    });
    const result = await fx.service.run({ mode: "apply" });
    expect(result).toMatchObject({
      status: "SUCCEEDED",
      stats: { processed: 2, lookups: 1, deduplicatedLookups: 1, written: 2 },
    });
    expect(fx.reader.findCompaniesByInnStrict).toHaveBeenCalledTimes(1);
    expect(fx.snapshots.get("a").contentHash).toBe(
      fx.snapshots.get("b").contentHash,
    );
  });

  it("rolls back a failed snapshot write without advancing the cursor", async () => {
    const old = oldSnapshot();
    const fx = fixture({ snapshots: [old] });
    fx.prisma.agencyAmoCompanySync.upsert.mockRejectedValueOnce(
      Object.assign(new Error("private database error"), { code: "P2024" }),
    );
    expect(await fx.service.run({ mode: "apply" })).toMatchObject({
      status: "FAILED",
      errorCode: "DATABASE_ERROR",
    });
    expect(fx.snapshots.get("a")).toEqual({
      ...old,
      lastAttemptAt: new Date(NOW),
      errorCode: "DATABASE_ERROR",
    });
    expect(fx.state().cursor).toBeNull();
  });

  it("does not report a requested missing local agency as a completed scope", async () => {
    const fx = fixture();
    expect(
      await fx.service.run({ mode: "apply", agencyIds: ["missing"] }),
    ).toMatchObject({ status: "FAILED", errorCode: "AGENCY_NOT_FOUND" });
    expect(fx.reader.findCompaniesByInnStrict).not.toHaveBeenCalled();
    expect(fx.prisma.agencyAmoCompanySync.upsert).not.toHaveBeenCalled();
  });

  it("stores fresh conflicts without failing a completed source read", async () => {
    const fx = fixture();
    fx.reader.findCompaniesByInnStrict.mockResolvedValue({
      ...readResponse(),
      items: [company(INN_A), { ...company(INN_A, "other.ru"), id: 2 }],
    });
    expect(await fx.service.run({ mode: "apply" })).toMatchObject({
      status: "SUCCEEDED",
      stats: { conflicts: 1 },
    });
    expect(fx.snapshots.get("a")).toMatchObject({
      linkStatus: "CONFLICT",
      profile: { website: null },
      lastSuccessAt: new Date(NOW),
    });
  });

  it("carries invalid-INN data quality across bounded chunks and completes eligible source reads", async () => {
    const fx = fixture({
      agencies: [
        { id: "a", inn: "bad" },
        { id: "b", inn: INN_B },
      ],
    });
    expect(
      await fx.service.run({ mode: "apply", maxAgencies: 1 }),
    ).toMatchObject({
      status: "FAILED",
      errorCode: "AGENCY_QUOTA_EXCEEDED",
      stats: { invalidInn: 1 },
    });
    expect(fx.state()).toMatchObject({ cursor: "a", cycleInvalidInn: 1 });
    expect(
      await fx.service.run({ mode: "apply", maxAgencies: 1 }),
    ).toMatchObject({
      status: "SUCCEEDED",
      errorCode: null,
      stats: {
        invalidInn: 0,
        cycleInvalidInn: 1,
        cycleEligibleRead: 1,
        errors: 0,
      },
    });
    expect(fx.state()).toMatchObject({
      cursor: null,
      lastErrorCode: null,
    });
    expect(fx.reader.findCompaniesByInnStrict).toHaveBeenCalledTimes(1);
    expect(
      fx.alerts.sendSafely.mock.calls.some((call) =>
        call[1].dedupKey.endsWith(":recovery"),
      ),
    ).toBe(false);
  });

  it("classifies all 1379 agencies and reads only the 64 eligible INNs", async () => {
    const agencies = Array.from({ length: 1379 }, (_, i) => ({
      id: String(i).padStart(4, "0"),
      inn: i < 64 ? String(7700000000 + i) : i % 2 ? "missing" : "",
    }));
    const fx = fixture({ agencies });
    expect(await fx.service.run({ mode: "apply" })).toMatchObject({
      status: "SUCCEEDED",
      errorCode: null,
      stats: {
        processed: 1379,
        invalidInn: 1315,
        cycleInvalidInn: 1315,
        cycleEligibleRead: 64,
        linked: 64,
        lookups: 64,
        errors: 0,
        cycleComplete: true,
      },
    });
    expect(fx.reader.findCompaniesByInnStrict).toHaveBeenCalledTimes(64);
    expect(fx.snapshots.get("1378")).toMatchObject({
      errorCode: "INVALID_INN",
      lastSuccessAt: null,
    });
    expect(fx.state()).toMatchObject({ cursor: null, lastErrorCode: null });
    expect(fx.alerts.sendSafely.mock.calls.map((call) => call[1])).toEqual([
      {
        dedupKey: "amo-agency-company-sync:data-quality:invalid-inn",
        cooldownMs: 86400000,
      },
    ]);
  });

  it("does not clear or announce auth recovery when a completed cycle has no eligible INN", async () => {
    const fx = fixture({
      agencies: [{ id: "a", inn: "" }],
      state: cursorState(null, "AMO_AUTH_ERROR"),
    });
    expect(await fx.service.run({ mode: "apply" })).toMatchObject({
      status: "SUCCEEDED",
      stats: { processed: 1, invalidInn: 1, cycleEligibleRead: 0, errors: 0 },
    });
    expect(fx.state().lastErrorCode).toBe("AMO_AUTH_ERROR");
    expect(
      fx.alerts.sendSafely.mock.calls.some((call) =>
        call[1].dedupKey.endsWith(":recovery"),
      ),
    ).toBe(false);
    fx.agencies[0].inn = INN_A;
    await fx.service.run({ mode: "apply" });
    expect(fx.state().lastErrorCode).toBeNull();
    expect(
      fx.alerts.sendSafely.mock.calls.filter((call) =>
        call[1].dedupKey.endsWith(":recovery"),
      ),
    ).toHaveLength(1);
  });

  it("retains pending source recovery across quota chunks and an invalid-only final chunk", async () => {
    const fx = fixture({
      agencies: [
        { id: "a", inn: INN_A },
        { id: "b", inn: "bad" },
      ],
      state: cursorState(null, "AMO_AUTH_ERROR"),
    });
    expect(
      await fx.service.run({ mode: "apply", maxAgencies: 1 }),
    ).toMatchObject({
      status: "FAILED",
      errorCode: "AGENCY_QUOTA_EXCEEDED",
    });
    expect(fx.state()).toMatchObject({
      cursor: "a",
      pendingSourceFailure: "AMO_AUTH_ERROR",
      cycleEligibleRead: 1,
    });
    expect(
      await fx.service.run({ mode: "apply", maxAgencies: 1 }),
    ).toMatchObject({
      status: "SUCCEEDED",
      stats: { cycleEligibleRead: 1, cycleInvalidInn: 1, errors: 0 },
    });
    expect(fx.state().pendingSourceFailure).toBeNull();
    expect(
      fx.alerts.sendSafely.mock.calls.filter((call) =>
        call[1].dedupKey.endsWith(":recovery"),
      ),
    ).toHaveLength(1);
  });

  it("targeted invalid INN fails with data quality alert without polluting the global integration state", async () => {
    const state = cursorState("z", "AMO_AUTH_ERROR");
    const fx = fixture({ agencies: [{ id: "a", inn: "bad" }], state });
    expect(
      await fx.service.run({ mode: "apply", agencyIds: ["a"] }),
    ).toMatchObject({ status: "FAILED", errorCode: "INVALID_INN" });
    expect(fx.state()).toEqual(state);
    expect(fx.reader.findCompaniesByInnStrict).not.toHaveBeenCalled();
    expect(fx.alerts.sendSafely.mock.calls[0][1].dedupKey).toBe(
      "amo-agency-company-sync:data-quality:invalid-inn",
    );
  });

  it("fails closed on malformed persisted cursor state", async () => {
    const fx = fixture({ state: "corrupt" });
    expect(await fx.service.run({ mode: "apply" })).toMatchObject({
      status: "FAILED",
      errorCode: "SYNC_STATE_INVALID",
    });
    expect(fx.reader.findCompaniesByInnStrict).not.toHaveBeenCalled();
    expect(fx.prisma.systemSetting.upsert).not.toHaveBeenCalled();
  });

  it("refuses snapshot writes after ownership is lost", async () => {
    const fx = fixture();
    fx.prisma.loyaltySyncRun.updateMany.mockResolvedValue({ count: 0 });
    expect(await fx.service.run({ mode: "apply" })).toMatchObject({
      status: "FAILED",
      errorCode: "RUN_OWNERSHIP_LOST",
    });
    expect(fx.prisma.agencyAmoCompanySync.upsert).not.toHaveBeenCalled();
    expect(fx.prisma.systemSetting.upsert).not.toHaveBeenCalled();
  });

  it.each([
    { mode: "wrong" },
    { mode: "apply", maxAgencies: 2001 },
    { mode: "apply", deadlineMs: 0 },
    { mode: "apply", agencyIds: [null] },
  ])(
    "rejects invalid options without source or snapshot writes %p",
    async (options) => {
      const fx = fixture();
      expect(await fx.service.run(options as any)).toMatchObject({
        status: "FAILED",
        errorCode: "INVALID_OPTIONS",
        runId: null,
      });
      expect(fx.reader.findCompaniesByInnStrict).not.toHaveBeenCalled();
      expect(fx.prisma.agencyAmoCompanySync.upsert).not.toHaveBeenCalled();
    },
  );

  it("does not mask source failure if alert delivery itself fails", async () => {
    const fx = fixture();
    fx.reader.findCompaniesByInnStrict.mockRejectedValue(
      new Error("amoCRM 429 /companies"),
    );
    fx.alerts.sendSafely.mockRejectedValue(
      new Error("private delivery failure"),
    );
    expect(await fx.service.run({ mode: "apply" })).toMatchObject({
      status: "FAILED",
      errorCode: "AMO_RATE_LIMIT",
    });
  });

  it("classifies safe codes without exposing raw exceptions", () => {
    expect(agencyCompanySyncErrorCode(new Error("AMO_COMPANY_DEADLINE"))).toBe(
      "DEADLINE_EXCEEDED",
    );
    expect(
      agencyCompanySyncErrorCode(
        Object.assign(new Error("private SQL"), { code: "P2024" }),
      ),
    ).toBe("DATABASE_ERROR");
    expect(
      agencyCompanySyncErrorCode(new Error("private unrecognized payload")),
    ).toBe("UNEXPECTED_ERROR");
  });
});
