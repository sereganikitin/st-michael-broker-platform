import {
  fixationClientWhere,
  LoyaltyBaseService,
} from "./loyalty-base.service";

const date = (day: string) => new Date(`${day}T00:00:00.000+03:00`);
const tour = new Date("2026-04-01T21:00:00.000Z");
const broker = (id: string, visited = true, at: Date | null = tour) => ({
  id,
  brokerTourVisited: visited,
  brokerTourDate: at,
  brokerAgencies: [{ agency: { id: "agency-1", name: "Agency" } }],
});

function harness(
  options: {
    brokers?: any[];
    fixations?: any[];
    meetings?: any[];
    deals?: any[];
    registry?: any[];
  } = {},
) {
  const page = (rows: any[]) =>
    jest.fn(async ({ where }) =>
      rows.filter((row) => where.brokerId.in.includes(row.brokerId)),
    );
  const prisma: any = {
    broker: {
      findMany: jest.fn(async ({ where }) =>
        (options.brokers || [broker("b-1")]).filter(
          (row) => !where.id || where.id.in.includes(row.id),
        ),
      ),
    },
    client: { findMany: page(options.fixations || []) },
    meeting: { findMany: page(options.meetings || []) },
    deal: { findMany: page(options.deals || []) },
    registryDeal: { findMany: page(options.registry || []) },
    loyaltySourceAggregate: { findMany: jest.fn().mockResolvedValue([]) },
    loyaltyEntityLink: { findMany: jest.fn().mockResolvedValue([]) },
  };
  return { prisma, service: new LoyaltyBaseService(prisma) };
}

const counts = (result: any) =>
  result.funnel.steps.map((step: any) => step.count);

describe("broker funnel event windows", () => {
  it("includes later events after the tour even when every lifetime minimum predates it", async () => {
    const { service, prisma } = harness({
      fixations: [
        { brokerId: "b-1", createdAt: date("2026-04-03") },
        { brokerId: "b-1", createdAt: date("2026-03-01") },
      ],
      meetings: [
        { brokerId: "b-1", date: date("2026-03-02") },
        { brokerId: "b-1", date: date("2026-04-04") },
      ],
      deals: [
        { brokerId: "b-1", signedAt: date("2026-03-02") },
        { brokerId: "b-1", signedAt: date("2026-04-05") },
      ],
      registry: [
        {
          brokerId: "b-1",
          paidAt: date("2026-03-03"),
          dvouPaidAt: date("2026-03-04"),
        },
        {
          brokerId: "b-1",
          paidAt: date("2026-04-06"),
          dvouPaidAt: date("2026-04-04"),
        },
      ],
    });
    const strict = await service.brokerFunnel("ours", {
      mode: "strict",
      cabinetSource: "new",
    });
    expect(counts(strict)).toEqual([1, 1, 1, 1, 1]);
    expect(strict.funnel.medianDays).toEqual({
      tourToFixation: 1,
      fixationToMeeting: 1,
      fixationToDeal: 2,
    });
    expect(strict.byMonth).toEqual([
      expect.objectContaining({
        month: "2026-04",
        fixation30: 1,
        fixation90: 1,
        fixationAny: 1,
        meetingAny: 1,
        dealAny: 1,
      }),
    ]);
    expect(strict.byAgency).toEqual([
      expect.objectContaining({
        brokers: 1,
        withFixation: 1,
        withMeeting: 1,
        withDeal: 1,
      }),
    ]);
    expect(prisma.client.findMany.mock.calls[0][0].where).toEqual({
      brokerId: { in: ["b-1"] },
      ...fixationClientWhere("new"),
    });
    expect(prisma.meeting.findMany.mock.calls[0][0].where).toMatchObject({
      status: { in: ["CONFIRMED", "COMPLETED"] },
      type: { not: "BROKER_TOUR" },
    });
    expect(prisma.deal.findMany.mock.calls[0][0].where).toMatchObject({
      contractType: "DDU",
      amount: { gt: 0 },
      signedAt: { not: null },
    });

    const all = await service.brokerFunnel("ours", { mode: "all" });
    expect(counts(all)).toEqual([1, 1, 1, 1, 1]);
    expect(all.funnel.medianDays).toEqual({
      tourToFixation: 1,
      fixationToMeeting: 1,
      fixationToDeal: 1,
    });
    expect(all.byMonth[0]).toMatchObject({ fixation30: 1, fixation90: 1 });
  });

  it("all-time includes work exclusively before the tour while strict excludes it", async () => {
    const { service } = harness({
      fixations: [{ brokerId: "b-1", createdAt: date("2026-03-01") }],
      meetings: [{ brokerId: "b-1", date: date("2026-03-02") }],
      registry: [
        {
          brokerId: "b-1",
          paidAt: date("2026-03-03"),
          dvouPaidAt: date("2026-03-02"),
        },
      ],
    });
    expect(counts(await service.brokerFunnel("ours", { mode: "all" }))).toEqual(
      [1, 1, 1, 1, 1],
    );
    const strict = await service.brokerFunnel("ours", { mode: "strict" });
    expect(counts(strict)).toEqual([1, 0, 0, 0, 0]);
    expect(strict.funnel.medianDays).toEqual({
      tourToFixation: null,
      fixationToMeeting: null,
      fixationToDeal: null,
    });
  });

  it("counts independent broker sets and expresses each share against the cohort", async () => {
    const { service } = harness({
      brokers: [broker("a"), broker("b"), broker("c")],
      fixations: [{ brokerId: "a", createdAt: date("2026-04-03") }],
      meetings: [
        { brokerId: "b", date: date("2026-04-04") },
        { brokerId: "c", date: date("2026-04-04") },
      ],
      registry: [
        { brokerId: "c", paidAt: date("2026-04-05"), dvouPaidAt: null },
      ],
    });
    const result = await service.brokerFunnel("ours", { mode: "strict" });
    expect(counts(result)).toEqual([3, 1, 2, 0, 1]);
    expect(result.funnel.steps.map((step) => step.fromStart)).toEqual([
      100, 33.3, 66.7, 0, 33.3,
    ]);
    expect(
      result.funnel.steps.every((step) => step.fromPrevious === null),
    ).toBe(true);
    expect(result.funnel.medianDays.fixationToMeeting).toBeNull();
    expect(result.methodology.steps).toContain("независимо");
    expect(result.methodology.steps).toContain("влияет только на фиксации");
  });

  it("uses qualifying post-tour event pairs for transition medians", async () => {
    const { service } = harness({
      fixations: [
        { brokerId: "b-1", createdAt: date("2026-03-01") },
        { brokerId: "b-1", createdAt: date("2026-04-05") },
      ],
      meetings: [
        { brokerId: "b-1", date: date("2026-03-02") },
        { brokerId: "b-1", date: date("2026-04-03") },
        { brokerId: "b-1", date: date("2026-04-10") },
      ],
      registry: [
        { brokerId: "b-1", paidAt: date("2026-03-03"), dvouPaidAt: null },
        { brokerId: "b-1", paidAt: date("2026-04-04"), dvouPaidAt: null },
        { brokerId: "b-1", paidAt: date("2026-04-12"), dvouPaidAt: null },
      ],
    });
    const strict = await service.brokerFunnel("ours", { mode: "strict" });
    expect(strict.funnel.medianDays).toEqual({
      tourToFixation: 3,
      fixationToMeeting: 5,
      fixationToDeal: 7,
    });
    const all = await service.brokerFunnel("ours", { mode: "all" });
    expect(all.funnel.medianDays.fixationToMeeting).toBe(1);
    expect(all.funnel.medianDays.fixationToDeal).toBe(2);
  });

  it("preserves undated tours in all-time and lifetime activity for brokers without a tour", async () => {
    const { service } = harness({
      brokers: [
        broker("dated"),
        broker("undated", true, null),
        broker("no-tour", false, null),
      ],
      fixations: [
        { brokerId: "dated", createdAt: date("2026-03-01") },
        { brokerId: "undated", createdAt: date("2026-04-03") },
        { brokerId: "no-tour", createdAt: date("2026-04-03") },
      ],
      meetings: [{ brokerId: "no-tour", date: date("2026-04-04") }],
      registry: [
        {
          brokerId: "no-tour",
          paidAt: date("2026-04-05"),
          dvouPaidAt: date("2026-04-04"),
        },
      ],
    });
    const strict = await service.brokerFunnel("ours", { mode: "strict" });
    const all = await service.brokerFunnel("ours", { mode: "all" });
    expect(strict.totals).toMatchObject({
      withTourMark: 2,
      withTourDate: 1,
      withoutTourDate: 1,
      cohort: 1,
    });
    expect(counts(strict)).toEqual([1, 0, 0, 0, 0]);
    expect(counts(all)).toEqual([2, 2, 0, 0, 0]);
    expect(strict.noTourFunnel).toEqual({
      brokers: 1,
      withFixation: 1,
      withMeeting: 1,
      withPaidBooking: 1,
      withDeal: 1,
    });
    expect(all.noTourFunnel).toEqual(strict.noTourFunnel);
    expect(
      (
        await service.brokerFunnel("ours", {
          mode: "all",
          from: "2026-04-01",
          to: "2026-04-30",
        })
      ).totals.cohort,
    ).toBe(1);
  });

  it("filters tour cohorts by Moscow day boundaries and includes an event exactly at the tour", async () => {
    const { service } = harness({
      brokers: [
        broker("previous-day", true, new Date("2026-04-01T20:59:59.999Z")),
        broker("in-day", true, tour),
        broker("next-day", true, new Date("2026-04-02T21:00:00.000Z")),
      ],
      fixations: [{ brokerId: "in-day", createdAt: tour }],
    });
    const result = await service.brokerFunnel("ours", {
      mode: "strict",
      from: "2026-04-02",
      to: "2026-04-02",
    });
    expect(result.totals.cohort).toBe(1);
    expect(counts(result)).toEqual([1, 1, 0, 0, 0]);
    expect(result.period).toEqual({
      from: "2026-04-01T21:00:00.000Z",
      to: "2026-04-02T20:59:59.999Z",
    });
    expect(result.funnel.medianDays.tourToFixation).toBe(0);
    expect(result.byMonth[0].month).toBe("2026-04");
  });

  it("keeps every qualifying event and batches narrow reads across more than 500 brokers", async () => {
    const brokers = Array.from({ length: 501 }, (_, i) => broker(`b-${i}`));
    const fixations = [
      ...Array.from({ length: 200 }, () => ({
        brokerId: "b-0",
        createdAt: date("2026-03-01"),
      })),
      { brokerId: "b-0", createdAt: date("2026-04-03") },
      { brokerId: "b-500", createdAt: date("2026-04-03") },
    ];
    const { service, prisma } = harness({ brokers, fixations });
    const result = await service.brokerFunnel("ours", { mode: "strict" });
    expect(counts(result)).toEqual([501, 2, 0, 0, 0]);
    for (const model of [
      prisma.client,
      prisma.meeting,
      prisma.deal,
      prisma.registryDeal,
    ]) {
      expect(model.findMany).toHaveBeenCalledTimes(2);
      for (const [query] of model.findMany.mock.calls) {
        expect(query.where.brokerId.in.length).toBeLessThanOrEqual(500);
        expect(query.take).toBeUndefined();
        expect(Object.keys(query.select).length).toBeLessThanOrEqual(4);
      }
    }
  });

  it("keeps an empty cohort explicit and limits Anna to confirmed linked brokers", async () => {
    const { service, prisma } = harness({
      brokers: [broker("linked"), broker("unlinked")],
    });
    jest
      .spyOn(service as any, "activeAnnaSnapshot")
      .mockResolvedValue({ dataset: { id: "dataset-1" } });
    prisma.loyaltyEntityLink.findMany.mockResolvedValue([
      { targetId: "linked" },
    ]);
    const anna = await service.brokerFunnel("anna", { mode: "strict" });
    expect(anna.totals.cohort).toBe(1);
    const empty = await service.brokerFunnel("ours", {
      mode: "strict",
      from: "2026-05-01",
    });
    expect(counts(empty)).toEqual([0, 0, 0, 0, 0]);
    expect(empty.funnel.steps.every((step) => step.fromStart === null)).toBe(
      true,
    );
    expect(empty.byMonth).toEqual([]);
  });

  it("drills into the exact post-tour cohort and the selected fixation source", async () => {
    const { service, prisma } = harness({
      brokers: [
        broker("a"),
        broker("before-only"),
        broker("outside", true, date("2026-03-01")),
      ],
      fixations: [
        { id: "before", brokerId: "a", createdAt: date("2026-03-01") },
        { id: "later", brokerId: "a", createdAt: date("2026-04-10") },
        { id: "first-after", brokerId: "a", createdAt: date("2026-04-03") },
        {
          id: "before-only",
          brokerId: "before-only",
          createdAt: date("2026-03-01"),
        },
        { id: "outside", brokerId: "outside", createdAt: date("2026-04-03") },
      ],
    });
    const query = {
      mode: "strict" as const,
      cabinetSource: "new" as const,
      from: "2026-04-01",
      to: "2026-04-30",
    };
    const result = await service.brokerFunnel("ours", query, {
      ...query,
      step: "fixation",
    });
    expect(result.drill).toMatchObject({
      total: 1,
      cohort: 2,
      mode: "strict",
      cabinetSource: "new",
      page: 1,
    });
    expect(result.drill?.items).toEqual([
      {
        brokerId: "a",
        displayName: "a",
        tourAt: tour.toISOString(),
        eventAt: date("2026-04-03").toISOString(),
        eventId: "first-after",
        eventSource: "CLIENT",
      },
    ]);
    expect(result.drill?.total).toBe(
      result.funnel.steps.find((step) => step.key === "fixation")?.count,
    );
    expect(prisma.client.findMany.mock.calls[0][0].where).toEqual({
      brokerId: { in: ["a", "before-only", "outside"] },
      ...fixationClientWhere("new"),
    });
    const all = await service.brokerFunnel(
      "ours",
      { ...query, mode: "all" },
      { ...query, mode: "all", step: "fixation" },
    );
    expect(all.drill?.total).toBe(2);
    expect(all.drill?.items[0].eventId).toBe("before");
  });

  it("keeps booking evidence separate from a paid DDU and pages brokers deterministically", async () => {
    const { service } = harness({
      brokers: [
        { ...broker("ddu"), fullName: "А" },
        { ...broker("dvou"), fullName: "Б" },
      ],
      registry: [
        {
          id: "r-ddu",
          brokerId: "ddu",
          paidAt: date("2026-04-03"),
          dvouPaidAt: null,
        },
        {
          id: "r-dvou",
          brokerId: "dvou",
          paidAt: null,
          dvouPaidAt: date("2026-04-04"),
        },
      ],
    });
    const booking = await service.brokerFunnel(
      "ours",
      { mode: "strict" },
      { step: "paidBooking", mode: "strict" },
    );
    expect(booking.drill?.items).toEqual([
      expect.objectContaining({
        brokerId: "dvou",
        eventId: "r-dvou",
        eventSource: "REGISTRY_DVOU",
        eventAt: date("2026-04-04").toISOString(),
      }),
    ]);
    const deal = await service.brokerFunnel(
      "ours",
      { mode: "strict" },
      { step: "deal", mode: "strict" },
    );
    expect(deal.drill?.items[0]).toMatchObject({
      brokerId: "ddu",
      eventId: "r-ddu",
      eventSource: "REGISTRY_DDU",
    });
    const second = await service.brokerFunnel(
      "ours",
      { mode: "strict" },
      { step: "brokerTour", mode: "strict", page: 2, pageSize: 1 },
    );
    expect(second.drill).toMatchObject({ total: 2, page: 2, pageSize: 1 });
    expect(second.drill?.items).toEqual([
      expect.objectContaining({
        brokerId: "dvou",
        eventSource: "AMO_BROKER_TOUR",
      }),
    ]);
  });

  it("shows undated tours only in all-time drill and returns an empty page for an empty step", async () => {
    const { service } = harness({
      brokers: [broker("undated", true, null), broker("no-tour", false, null)],
    });
    const all = await service.brokerFunnel(
      "ours",
      { mode: "all" },
      { mode: "all", step: "brokerTour" },
    );
    expect(all.drill?.items).toEqual([
      expect.objectContaining({
        brokerId: "undated",
        tourAt: null,
        eventAt: null,
      }),
    ]);
    const strict = await service.brokerFunnel(
      "ours",
      { mode: "strict" },
      { mode: "strict", step: "brokerTour" },
    );
    expect(strict.drill).toMatchObject({ total: 0, items: [] });
  });
});
