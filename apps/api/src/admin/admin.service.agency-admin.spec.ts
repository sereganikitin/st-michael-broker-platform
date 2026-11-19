import "reflect-metadata";
import { AdminService } from "./admin.service";
import { AdminController } from "./admin.controller";

function fixture() {
  const membership: any = {
    id: "membership",
    brokerId: "broker",
    agencyId: "agency",
    isAgencyAdmin: false,
    broker: { role: "BROKER", status: "ACTIVE", mergedIntoId: null },
  };
  const tx: any = {
    broker: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ role: "ADMIN", status: "ACTIVE" }),
    },
    $queryRaw: jest.fn().mockResolvedValue([{ id: membership.id }]),
    brokerAgency: {
      findUnique: jest.fn().mockImplementation(async () => membership),
      update: jest
        .fn()
        .mockImplementation(async ({ data }) =>
          Object.assign(membership, data),
        ),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const service = Object.create(AdminService.prototype) as AdminService;
  (service as any).prisma = { $transaction: async (action: any) => action(tx) };
  return { service, tx, membership };
}

describe("agency administrator permission", () => {
  it("protects the assignment endpoint with the system ADMIN role", () => {
    expect(
      Reflect.getMetadata("roles", AdminController.prototype.setAgencyAdmin),
    ).toEqual(["ADMIN"]);
  });

  it("grants and revokes one membership with an audit, preserving the BROKER role", async () => {
    const f = fixture();
    await f.service.setAgencyAdmin("admin", "broker", "agency", true);
    expect(f.membership.isAgencyAdmin).toBe(true);
    expect(f.membership.broker.role).toBe("BROKER");
    expect(f.tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "AGENCY_ADMIN_GRANTED",
          userId: "admin",
          entityId: "membership",
        }),
      }),
    );
    await f.service.setAgencyAdmin("admin", "broker", "agency", false);
    expect(f.membership.isAgencyAdmin).toBe(false);
    expect(f.tx.auditLog.create).toHaveBeenCalledTimes(2);
  });

  it.each(["BROKER", "MANAGER"])(
    "rejects %s callers in the domain method too",
    async (role) => {
      const f = fixture();
      f.tx.broker.findUnique.mockResolvedValue({ role, status: "ACTIVE" });
      await expect(
        f.service.setAgencyAdmin("caller", "broker", "agency", true),
      ).rejects.toThrow("системный администратор");
      expect(f.tx.brokerAgency.update).not.toHaveBeenCalled();
    },
  );

  it("does not create a membership or widen access to another agency", async () => {
    const f = fixture();
    f.tx.brokerAgency.findUnique.mockResolvedValue(null);
    await expect(
      f.service.setAgencyAdmin("admin", "broker", "other-agency", true),
    ).rejects.toThrow("не состоит");
    expect(f.tx.brokerAgency.update).not.toHaveBeenCalled();
  });

  it("does not grant to a blocked or merged card and permits revocation", async () => {
    const f = fixture();
    f.membership.broker.status = "BLOCKED";
    await expect(
      f.service.setAgencyAdmin("admin", "broker", "agency", true),
    ).rejects.toThrow("активного брокера");
    f.membership.isAgencyAdmin = true;
    await f.service.setAgencyAdmin("admin", "broker", "agency", false);
    expect(f.membership.isAgencyAdmin).toBe(false);
  });

  it("does not create a second audit for an already applied assignment", async () => {
    const f = fixture();
    await f.service.setAgencyAdmin("admin", "broker", "agency", true);
    await f.service.setAgencyAdmin("admin", "broker", "agency", true);
    expect(f.tx.auditLog.create).toHaveBeenCalledTimes(1);
  });
});
