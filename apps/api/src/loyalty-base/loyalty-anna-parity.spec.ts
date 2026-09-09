import { LoyaltyBaseService, sameCity } from "./loyalty-base.service";

// 2026-09-09 (паритет базы Анны с «Нашей базой»): город сравнивается с
// нормализацией, сводка активности для Анны считается по сцепкам,
// статусы строк Анны берутся из сцепленной карточки, когда своих метрик нет.
describe("паритет базы Анны", () => {
  it("sameCity: регистр, «г.», ё и синонимы Москвы/Петербурга", () => {
    expect(sameCity("Москва", "москва")).toBe(true);
    expect(sameCity("г. Москва", "МСК")).toBe(true);
    expect(sameCity("Санкт-Петербург", "СПб")).toBe(true);
    expect(sameCity("Питер", "Санкт Петербург")).toBe(true);
    expect(sameCity("Орёл", "Орел")).toBe(true);
    expect(sameCity("Москва", "Казань")).toBe(false);
    expect(sameCity("", "")).toBe(false);
    expect(sameCity(null, "Москва")).toBe(false);
  });

  it("annaLinkedSelection: уникальные id сцепленных карточек и число сцепленных записей", () => {
    const service = new LoyaltyBaseService({} as any);
    const linked = (service as any).annaLinkedSelection([
      { id: "a1", linkedId: "b1" },
      { id: "a2", linkedId: "b1" },
      { id: "a3", linkedId: null },
      { id: "a4", linkedId: "b2" },
    ]);
    expect(linked.ids).toEqual(["b1", "b2"]);
    expect(linked.records).toBe(3);
    expect((service as any).annaLinkedSelection(undefined)).toEqual({ ids: [], records: 0 });
  });

  it("annaLinkedOurId: только сцепка того же типа сущности", () => {
    const service = new LoyaltyBaseService({} as any);
    expect((service as any).annaLinkedOurId({ linkedOurs: { type: "BROKER", id: "b1" } }, "BROKER")).toBe("b1");
    expect((service as any).annaLinkedOurId({ linkedOurs: { type: "AGENCY", id: "g1" } }, "BROKER")).toBeNull();
    expect((service as any).annaLinkedOurId({ linkedOurs: null }, "BROKER")).toBeNull();
  });

  it("annaStatusCodes: без своих метрик статус берётся из сцепленной карточки кабинета", () => {
    const service = new LoyaltyBaseService({} as any);
    const svc: any = service;
    svc.annaMetricValue = () => null;
    svc.annaBrokerTour = () => null;
    svc.annaCalls = () => [];
    svc.lastCall = () => null;
    svc.annaDormancyLastActivity = () => null;
    const withLink = svc.annaStatusCodes(
      { linkedOurRecord: { metrics: { fixations: 2, meetings: 0, deals: 4 } } },
      "BROKER",
    );
    expect(withLink).toEqual(["TOP_SELLER"]);
    const withoutLink = svc.annaStatusCodes({ linkedOurRecord: null }, "BROKER");
    expect(withoutLink).toEqual([]);
  });

  it("activitySummaryPayload для базы Анны: методика про сцепки и число сцепленных записей", () => {
    const service = new LoyaltyBaseService({} as any);
    const payload = (service as any).activitySummaryPayload(
      "anna",
      "BROKER",
      { from: "2026-08-01T00:00:00.000Z", to: "2026-08-31T20:59:59.999Z" },
      undefined,
      120,
      "hash",
      {
        brokerIds: ["b1", "b2"],
        fixations: 5,
        meetings: 1,
        deals: 1,
        dealCents: 100000n,
        paidBookings: 2,
        registryDeals: 2,
        registryCents: 250000n,
      },
      { linkedRecords: 90 },
    );
    expect(payload.supported).toBe(true);
    expect(payload.selection).toMatchObject({ count: 120, brokers: 2, linkedRecords: 90 });
    expect(payload.activities).toEqual({ fixations: 5, meetings: 1, paidBookings: 2, deals: 3 });
    expect(payload.dealAmount).toBe("3500.00");
    expect(payload.methodology).toContain("сцеплено 90 из 120");
  });
});
