import { LoyaltyProgramService } from "./loyalty-program.service";

const manager = {
  id: "manager-1",
  role: "MANAGER",
  phone: "",
  fullName: "Manager",
} as any;

function harness() {
  const prisma: any = {
    loyaltyDataset: {
      findFirst: jest.fn().mockResolvedValue({
        id: "dataset-1",
        activeSnapshotId: "snap-1",
      }),
    },
    loyaltySourceRecord: {
      findMany: jest.fn().mockResolvedValue([
        {
          entityType: "AGENCY",
          displayName: "TrendAgent",
          attributes: { aliases: ["Trend Agent"] },
          organizationId: "org-trend",
          personId: null,
          organization: { manualDisplayName: null },
          person: null,
        },
        {
          entityType: "AGENCY",
          displayName: "PRIME",
          attributes: {},
          organizationId: "org-prime-1",
          personId: null,
          organization: { manualDisplayName: null },
          person: null,
        },
        {
          entityType: "AGENCY",
          displayName: "Prime",
          attributes: {},
          organizationId: "org-prime-2",
          personId: null,
          organization: { manualDisplayName: null },
          person: null,
        },
      ]),
    },
    loyaltyProgramMatch: {
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn().mockResolvedValue({}),
    },
  };
  const permissions: any = {
    require: jest.fn().mockResolvedValue(undefined),
    requireAll: jest.fn().mockResolvedValue(undefined),
  };
  return {
    prisma,
    permissions,
    service: new LoyaltyProgramService(prisma, permissions),
  };
}

describe("LoyaltyProgramService overlay", () => {
  it("auto-matches Trend Agent and leaves PRIME for the manual UI", async () => {
    const { service, permissions } = harness();
    const overlay = await service.overlay(manager, "SOLD_2026");
    expect(permissions.require).toHaveBeenCalledWith(manager, "READ_ALL");
    const trend = overlay.rows.find((row) => row.partner.key === "trend-agent");
    expect(trend?.match.status).toBe("AUTO");
    expect(trend?.match.entityId).toBe("org-trend");
    const soldNames = overlay.rows.map((row) => row.partner.name);
    expect(soldNames).toContain("Trend Agent");
    expect(overlay.counts.sold).toBe(31);
    expect(overlay.counts.sleeping).toBe(57);
    expect(overlay.source).toMatchObject({
      status: "UNCONFIRMED",
      accuracy: "UNKNOWN",
      periodApplied: false,
      declared: { soldPartners: 32, dduCount: 76, soldMln: 2367 },
      extracted: { soldPartners: 31, dduCount: 75, soldMln: 2343.4 },
      discrepancy: { soldPartners: 1, dduCount: 1, soldMln: 23.6 },
    });
  });

  it("does not hide stored-match database failures as an empty result", async () => {
    const { service, prisma } = harness();
    prisma.loyaltyProgramMatch.findMany.mockRejectedValue(new Error("database offline"));
    await expect(service.overlay(manager, "SOLD_2026")).rejects.toThrow("database offline");
  });

  it("requires reference-management permission before saving a match", async () => {
    const { service, permissions } = harness();
    await service.decide(manager, {
      partnerKey: "trend-agent",
      status: "SKIPPED",
    });
    expect(permissions.requireAll).toHaveBeenCalledWith(manager, [
      "READ_ALL",
      "REFERENCE_MANAGE",
    ]);
  });
});
