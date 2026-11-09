import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { LoyaltyFunnelDrillQueryDto } from "./loyalty-base.dto";
import { LoyaltyBaseController } from "./loyalty-base.controller";

describe("funnel drill read contract", () => {
  it("validates the event step, inherited filters and bounded page inputs", async () => {
    const valid = plainToInstance(LoyaltyFunnelDrillQueryDto, {
      step: "paidBooking",
      mode: "strict",
      cabinetSource: "new",
      from: "2026-04-01",
      page: "2",
      pageSize: "30",
    });
    expect(await validate(valid)).toEqual([]);
    expect(valid.page).toBe(2);
    for (const input of [
      { step: "unknown" },
      {},
      { step: "deal", mode: "wrong" },
      { step: "deal", from: "bad-date" },
      { step: "deal", page: 0 },
      { step: "deal", pageSize: 101 },
    ]) {
      expect(
        (await validate(plainToInstance(LoyaltyFunnelDrillQueryDto, input)))
          .length,
      ).toBeGreaterThan(0);
    }
  });

  it("requires READ_ALL before querying exact funnel evidence", async () => {
    const query: LoyaltyFunnelDrillQueryDto = {
      step: "deal",
      mode: "strict",
      cabinetSource: "new",
    };
    const user: any = { id: "reader" };
    const loyalty: any = {
      brokerFunnel: jest
        .fn()
        .mockResolvedValue({ drill: { total: 1, items: [] } }),
    };
    const permissions: any = {
      require: jest.fn().mockResolvedValue(undefined),
    };
    const controller = new LoyaltyBaseController(
      loyalty,
      permissions,
      {} as any,
    );
    await expect(controller.funnelDrill("ours", query, user)).resolves.toEqual({
      total: 1,
      items: [],
    });
    expect(permissions.require).toHaveBeenCalledWith(user, "READ_ALL");
    expect(loyalty.brokerFunnel).toHaveBeenCalledWith("ours", query, query);
    loyalty.brokerFunnel.mockClear();
    permissions.require.mockRejectedValue(new Error("denied"));
    await expect(controller.funnelDrill("ours", query, user)).rejects.toThrow(
      "denied",
    );
    expect(loyalty.brokerFunnel).not.toHaveBeenCalled();
  });
});
