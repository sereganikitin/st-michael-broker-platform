import { PartnerSheetService } from "./partner-sheet.service";
import { LoyaltyBaseController } from "./loyalty-base.controller";
import { join } from "node:path";
const { COLUMNS } = require(
  join(__dirname, "../../../../scripts/partner-sheet/details.cjs"),
);

function fixture() {
  const store = new Map<string, string>();
  const settings = (map: Map<string, string>) => ({
    findUnique: jest.fn(async ({ where }: any) =>
      map.has(where.key) ? { key: where.key, value: map.get(where.key) } : null,
    ),
    upsert: jest.fn(async ({ where, create, update }: any) => {
      map.set(where.key, map.has(where.key) ? update.value : create.value);
    }),
    deleteMany: jest.fn(async ({ where }: any) => {
      map.delete(where.key);
    }),
    create: jest.fn(async ({ data }: any) => {
      if (map.has(data.key))
        throw Object.assign(new Error("duplicate"), { code: "P2002" });
      map.set(data.key, data.value);
    }),
  });
  const prisma: any = {
    systemSetting: settings(store),
    agency: { findMany: jest.fn().mockResolvedValue([]) },
  };
  let corrupt = false;
  prisma.$transaction = jest.fn(async (fn: any) => {
    const staged = new Map(store),
      systemSetting = settings(staged);
    if (corrupt)
      systemSetting.findUnique.mockImplementation(async ({ where }: any) =>
        systemSetting.upsert.mock.calls.length
          ? { key: where.key, value: "corrupt" }
          : staged.has(where.key)
            ? { key: where.key, value: staged.get(where.key) }
            : null,
      );
    const result = await fn({ systemSetting });
    store.clear();
    staged.forEach((value, key) => store.set(key, value));
    return result;
  });
  const alerts: any = { sendSafely: jest.fn().mockResolvedValue(true) };
  const service = new PartnerSheetService(prisma, alerts);
  const row = {
    tab: "Партнеры 2026",
    row: 6,
    name: "Example agency",
    normalizedName: "example agency",
    type: "АН",
    baselineRub: "10.00",
    addedRub: "2.00",
    totalRub: "12.00",
  };
  const source = {
    contentHash: "a".repeat(64),
    agencies: [row],
    sourceRows: [row],
    deals: [],
    issues: [],
    details: [
      {
        tab: row.tab,
        row: row.row,
        fields: COLUMNS.map((c: number) => ({
          column: String.fromCharCode(65 + c),
          label: "Field",
          value: "",
        })),
      },
    ],
  };
  const read = jest
    .spyOn(service as any, "loadSource")
    .mockResolvedValue(source);
  return {
    service,
    prisma,
    store,
    source,
    alerts,
    read,
    corrupt: () => {
      corrupt = true;
    },
  };
}

describe("separate partner sheet view", () => {
  it("verifies and persists complete snapshots, uses a real read on every scheduled run", async () => {
    const f = fixture();
    await f.service.list();
    expect(f.store.has("partner-sheet-v1-2:verified-snapshot")).toBe(true);
    await f.service.scheduledSync();
    expect(f.read).toHaveBeenCalledTimes(2);
    expect(f.alerts.sendSafely).not.toHaveBeenCalled();
    expect(f.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
    });
    expect([...f.store.keys()]).toEqual([
      "partner-sheet-v1-2:verified-snapshot",
    ]);
  });
  it("preserves last good snapshot on incomplete source and serves explicit stale warning", async () => {
    const f = fixture();
    await f.service.list();
    const saved = f.store.get("partner-sheet-v1-2:verified-snapshot");
    f.source.details[0].fields.pop();
    await f.service.scheduledSync();
    const stale = await f.service.list();
    expect(stale.syncWarning).toContain("последний проверенный");
    expect(f.store.get("partner-sheet-v1-2:verified-snapshot")).toBe(saved);
    expect(f.alerts.sendSafely).toHaveBeenCalledTimes(1);
    await f.service.scheduledSync();
    expect(f.alerts.sendSafely).toHaveBeenCalledTimes(1);
  });
  it("rolls back failed readback and suppresses unchanged incidents across restart", async () => {
    const f = fixture();
    await f.service.list();
    const saved = f.store.get("partner-sheet-v1-2:verified-snapshot");
    f.corrupt();
    await f.service.scheduledSync();
    expect(f.store.get("partner-sheet-v1-2:verified-snapshot")).toBe(saved);
    const restarted = new PartnerSheetService(f.prisma, f.alerts);
    jest
      .spyOn(restarted as any, "loadSource")
      .mockRejectedValue(new Error("private source response"));
    await restarted.scheduledSync();
    expect(f.alerts.sendSafely).toHaveBeenCalledTimes(1);
    expect(f.alerts.sendSafely.mock.calls[0][0]).not.toContain("private");
  });
  it("clears incident only after verified recovery and alerts on a new incident", async () => {
    const f = fixture();
    f.read.mockRejectedValueOnce(new Error("private"));
    await f.service.scheduledSync();
    expect(f.store.has("partner-sheet-v1-2:incident")).toBe(true);
    await f.service.scheduledSync();
    expect(f.store.has("partner-sheet-v1-2:incident")).toBe(false);
    expect(f.alerts.sendSafely).toHaveBeenCalledTimes(1);
    f.read.mockRejectedValueOnce(new Error("private"));
    await f.service.scheduledSync();
    expect(f.alerts.sendSafely).toHaveBeenCalledTimes(2);
  });
  it("coalesces concurrent source reads and uses its cache", async () => {
    const service = new PartnerSheetService({} as any, {} as any);
    const load = jest
      .spyOn(service as any, "load")
      .mockImplementation(async () => {
        await Promise.resolve();
        const value = { items: [] };
        (service as any).cached = { value, expires: Date.now() + 60000 };
        return value;
      });
    await Promise.all([service.list(), service.list()]);
    await service.list();
    expect(load).toHaveBeenCalledTimes(1);
  });
  it("clears pending on failure and permits a later read", async () => {
    const service = new PartnerSheetService(
      {
        systemSetting: { findUnique: jest.fn().mockResolvedValue(null) },
      } as any,
      {} as any,
    );
    jest
      .spyOn(service as any, "load")
      .mockRejectedValueOnce(new Error("failed"))
      .mockResolvedValueOnce({ items: [] });
    await expect(service.list()).rejects.toThrow("Проверенный снимок");
    await expect(service.list()).resolves.toEqual({ items: [] });
  });
  it("checks READ_ALL before accessing the data", async () => {
    const permissions: any = {
        require: jest.fn().mockRejectedValue(new Error("denied")),
      },
      sheet: any = { list: jest.fn() };
    const controller = new LoyaltyBaseController({} as any, permissions, sheet);
    await expect(
      controller.partnerSheetView({} as any, { set: jest.fn() } as any),
    ).rejects.toThrow("denied");
    expect(sheet.list).not.toHaveBeenCalled();
  });
  it("checks EXPORT permission and neutralizes CSV formulas", async () => {
    const permissions: any = {
      requireAll: jest.fn().mockResolvedValue(undefined),
    };
    const sheet: any = {
      list: jest.fn().mockResolvedValue({
        items: [
          {
            name: "=1+1",
            type: "АН",
            status: "REVIEW",
            periods: [
              {
                tab: "Спящие",
                row: 7,
                totalRub: "1.00",
                baselineRub: "1.00",
                addedRub: "0.00",
                baselineScope: "BEFORE_2026",
                fields: [
                  {
                    column: "L",
                    label: "Результат / комментарий",
                    value: '=HYPERLINK("test")\nстрока 2',
                  },
                  {
                    column: "T",
                    label: "На первую сделку до 30.09",
                    value: "0,5%",
                  },
                ],
              },
            ],
          },
        ],
      }),
    };
    const controller = new LoyaltyBaseController({} as any, permissions, sheet),
      user: any = { id: "admin", role: "ADMIN" };
    const result = await controller.exportPartnerSheet(user, {
      set: jest.fn(),
    } as any);
    const chunks: Buffer[] = [];
    for await (const chunk of result.getStream())
      chunks.push(Buffer.from(chunk));
    const csv = Buffer.concat(chunks).toString("utf8");
    expect(csv).toContain('"\'=1+1"');
    expect(csv).toContain('"\'=HYPERLINK(""test"")\nстрока 2"');
    expect(csv).toContain('"На первую сделку до 30.09";"0,5%"');
    expect(csv).toContain('"Кабинет: ИНН"');
    expect(permissions.requireAll).toHaveBeenCalledWith(user, [
      "READ_ALL",
      "EXPORT",
    ]);
  });
});
