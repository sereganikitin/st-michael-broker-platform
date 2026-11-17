import { ClientFixationController } from "./client-fixation.controller";
import { Reflector } from "@nestjs/core";
import { RolesGuard } from "../auth/roles.guard";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";

const validBody = {
  phone: "+79990000001",
  fullName: "Тестовый Клиент",
  project: "ZORGE9",
  agencyInn: "7700000000",
};

describe("ClientFixationController idempotency", () => {
  it("restricts operational inspection and retries to authenticated staff", () => {
    expect(
      Reflect.getMetadata("__guards__", ClientFixationController),
    ).toContain(JwtAuthGuard);
    const guard = new RolesGuard(new Reflector());
    for (const handler of [
      ClientFixationController.prototype.fixationReviewQueue,
      ClientFixationController.prototype.retryFixationCheck,
    ]) {
      expect(Reflect.getMetadata("__guards__", handler)).toContain(RolesGuard);
      const context = (role: string) =>
        ({
          getHandler: () => handler,
          getClass: () => ClientFixationController,
          switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
        }) as any;
      expect(guard.canActivate(context("BROKER"))).toBe(false);
      expect(guard.canActivate(context("MANAGER"))).toBe(true);
      expect(guard.canActivate(context("ADMIN"))).toBe(true);
    }
  });

  it("persists the parsed request and keeps its key out of domain data", async () => {
    const requests = {
      submit: jest
        .fn()
        .mockResolvedValue({ requestId: "request-1", requestState: "PENDING" }),
    };
    const service = { fixClient: jest.fn() };
    const controller = new ClientFixationController(
      service as any,
      {} as any,
      requests as any,
    );
    const key = "b5066154-6973-4730-bc62-d3df0dc85925";
    await expect(
      controller.fixClient({ id: "broker-1" } as any, {
        ...validBody,
        idempotencyKey: key,
      }),
    ).resolves.toMatchObject({ requestState: "PENDING" });
    expect(requests.submit).toHaveBeenCalledWith("broker-1", validBody, key);
    expect(service.fixClient).not.toHaveBeenCalled();
  });

  it("accepts legacy clients without a key into the same durable intake", async () => {
    const requests = {
      submit: jest.fn().mockResolvedValue({ requestId: "request-1" }),
    };
    const controller = new ClientFixationController(
      {} as any,
      {} as any,
      requests as any,
    );
    await controller.fixClient({ id: "broker-1" } as any, validBody);
    expect(requests.submit).toHaveBeenCalledWith(
      "broker-1",
      validBody,
      undefined,
    );
  });

  it("rejects a malformed idempotency key before the guarded action", async () => {
    const clientFixationService = { fixClient: jest.fn() };
    const fixationSafety = { execute: jest.fn() };
    const controller = new ClientFixationController(
      clientFixationService as any,
      fixationSafety as any,
      { submit: jest.fn() } as any,
    );

    await expect(
      controller.fixClient({ id: "broker-1" } as any, {
        ...validBody,
        idempotencyKey: "not-a-uuid",
      }),
    ).rejects.toMatchObject({ name: "ZodError" });
    expect(fixationSafety.execute).not.toHaveBeenCalled();
    expect(clientFixationService.fixClient).not.toHaveBeenCalled();
  });

  it.each(["123456789777", "12345678901"])(
    "persists soft-validated agency INN %s for domain processing",
    async (agencyInn) => {
      const requests = {
        submit: jest
          .fn()
          .mockResolvedValue({
            requestId: "request-1",
            requestState: "PENDING",
          }),
      };
      const service = { fixClient: jest.fn() };
      const controller = new ClientFixationController(
        service as any,
        {} as any,
        requests as any,
      );
      await expect(
        controller.fixClient({ id: "broker-1" } as any, {
          ...validBody,
          agencyInn,
        }),
      ).resolves.toMatchObject({ requestState: "PENDING" });
      expect(requests.submit).toHaveBeenCalledWith(
        "broker-1",
        expect.objectContaining({ agencyInn }),
        undefined,
      );
      expect(service.fixClient).not.toHaveBeenCalled();
    },
  );

  it("still rejects a non-numeric agency INN by schema", async () => {
    const clientFixationService = { fixClient: jest.fn() };
    const fixationSafety = { execute: jest.fn() };
    const controller = new ClientFixationController(
      clientFixationService as any,
      fixationSafety as any,
      { submit: jest.fn() } as any,
    );

    await expect(
      controller.fixClient({ id: "broker-1" } as any, {
        ...validBody,
        agencyInn: "abc",
      }),
    ).rejects.toMatchObject({ name: "ZodError" });
    expect(fixationSafety.execute).not.toHaveBeenCalled();
  });
});
