import { dateOnlyInPeriod } from "./loyalty-base.service";

// 2026-09-09: сводка «Контрольных показателей» и обзор считали сделки реестра
// по-разному на границе периода: колонки реестра — DATE, БД сравнивает их с
// границей без времени, а JS сравнивал миллисекунды.
describe("dateOnlyInPeriod (реестр: paidAt/dvouPaidAt как DATE)", () => {
  const period = {
    from: new Date("2026-08-10T04:48:58.738Z"),
    to: new Date("2026-09-09T04:48:58.738Z"),
  };

  it("день начала периода входит целиком, как в запросе к БД", () => {
    expect(dateOnlyInPeriod(new Date("2026-08-10T00:00:00.000Z"), period)).toBe(true);
    expect(dateOnlyInPeriod("2026-08-10", period)).toBe(true);
  });

  it("день конца периода входит целиком", () => {
    expect(dateOnlyInPeriod(new Date("2026-09-09T00:00:00.000Z"), period)).toBe(true);
    expect(dateOnlyInPeriod(new Date("2026-09-09T23:00:00.000Z"), period)).toBe(true);
  });

  it("дни вне периода не входят", () => {
    expect(dateOnlyInPeriod(new Date("2026-08-09T23:59:59.000Z"), period)).toBe(false);
    expect(dateOnlyInPeriod(new Date("2026-09-10T00:00:00.000Z"), period)).toBe(false);
  });

  it("пустые и битые значения — вне периода", () => {
    expect(dateOnlyInPeriod(null, period)).toBe(false);
    expect(dateOnlyInPeriod(undefined, period)).toBe(false);
    expect(dateOnlyInPeriod("не дата", period)).toBe(false);
  });
});
