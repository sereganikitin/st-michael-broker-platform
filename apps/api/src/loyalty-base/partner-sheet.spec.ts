import { PartnerSheetService } from "./partner-sheet.service";
import { LoyaltyBaseController } from "./loyalty-base.controller";

describe("separate partner sheet view", () => {
  it("coalesces concurrent source reads and uses its cache", async () => {
    const service = new PartnerSheetService({} as any);
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
    const service = new PartnerSheetService({} as any);
    jest
      .spyOn(service as any, "load")
      .mockRejectedValueOnce(new Error("failed"))
      .mockResolvedValueOnce({ items: [] });
    await expect(service.list()).rejects.toThrow("failed");
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
