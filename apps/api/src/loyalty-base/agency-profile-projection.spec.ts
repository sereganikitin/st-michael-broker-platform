import { applyAgencyCompanyProjection } from "./agency-profile-projection";
import { LoyaltyBaseService } from "./loyalty-base.service";

describe("agency profile evidence projection", () => {
  const now = new Date("2026-11-09T10:00:00Z");
  const item = () => ({ attributes: { partnershipStatus: "VIP" }, metrics: { brokers: 12 } } as any);
  const snapshot = () => ({
    companyIds: ["123"], lastAttemptAt: now, lastSuccessAt: now,
    sourceUpdatedAt: "2026-11-07T09:00:00Z", errorCode: null,
    profile: { lastContractDate: "2025-11-22", lastContractNumber: "TEST-1", website: null },
    fieldSources: { lastContractDate: { fieldId: 842477, companyIds: ["123"], sourceUpdatedAt: "2026-11-07T09:00:00Z", checkedAt: now } },
    contracts: [], conflicts: {},
  });

  it("shows a sourced agreement, local broker scope, and explicit reasons for empty fields", () => {
    const target = item();
    applyAgencyCompanyProjection({ amoCompanySync: snapshot() }, target, now);
    expect(target.attributes).toMatchObject({ partnershipStatus: "VIP", lastContractDate: "2025-11-22", brokerCount: 12, brokerCountScope: "CABINET_LINKS" });
    expect(target.fieldAvailability.lastContractDate.status).toBe("AVAILABLE");
    expect(target.fieldAvailability.website.status).toBe("EMPTY_IN_SOURCE");
    expect(target.fieldAvailability.agencySize.status).toBe("FIELD_NOT_IN_SOURCE");
    expect(target.sourceFreshness.status).toBe("CURRENT");
    expect(target.provenance[0]).toMatchObject({ field: "lastContractDate", checkedAt: now.toISOString(), sourceUpdatedAt: "2026-11-07T09:00:00.000Z" });
  });

  it("preserves the last good values when a subsequent source check fails", () => {
    const target = item();
    applyAgencyCompanyProjection({ amoCompanySync: { ...snapshot(), errorCode: "AMO_AUTH_ERROR" } }, target, now);
    expect(target.attributes.lastContractDate).toBe("2025-11-22");
    expect(target.sourceFreshness.status).toBe("ERROR");
    expect(target.sourceFreshness.errorCode).toBe("AMO_AUTH_ERROR");
  });

  it("separates stale, absent and conflicting evidence", () => {
    const stale = item();
    applyAgencyCompanyProjection({ amoCompanySync: { ...snapshot(), lastSuccessAt: "2026-11-01T00:00:00Z" } }, stale, now);
    expect(stale.sourceFreshness.status).toBe("STALE");
    const absent = item();
    applyAgencyCompanyProjection({}, absent, now);
    expect(absent.sourceFreshness.status).toBe("NOT_SYNCED");
    expect(absent.fieldAvailability.website.status).toBe("NOT_SYNCED");
    const conflict = item();
    applyAgencyCompanyProjection({ amoCompanySync: { ...snapshot(), conflicts: { website: { candidates: [] } } } }, conflict, now);
    expect(conflict.fieldAvailability.website.status).toBe("CONFLICT");
  });
});

describe("agency active brokers in the agreed 90-day window", () => {
  it("deduplicates brokers across fixations, client meetings and DDU sources", async () => {
    const db: any = {
      client: { groupBy: jest.fn().mockResolvedValue([{ brokerId: "a" }]) },
      meeting: { groupBy: jest.fn().mockResolvedValue([{ brokerId: "a" }, { brokerId: "b" }]) },
      deal: { groupBy: jest.fn().mockResolvedValue([]) },
      registryDeal: { groupBy: jest.fn().mockResolvedValue([{ brokerId: "b" }]) },
    };
    const service = new LoyaltyBaseService(db);
    const item: any = { attributes: {}, fieldAvailability: {}, provenance: [] };
    await (service as any).attachAgencyActiveBrokers({ brokerAgencies: [{ broker: { id: "a" } }, { broker: { id: "b" } }] }, item);
    expect(item.attributes.activeBrokers).toBe(2);
    expect(item.attributes.activeBrokerWindowDays).toBe(90);
    expect(db.meeting.groupBy.mock.calls[0][0].where).toMatchObject({ type: { not: "BROKER_TOUR" }, status: { in: ["CONFIRMED", "COMPLETED"] } });
    expect(db.registryDeal.groupBy.mock.calls[0][0].where.paidAt.gte).toBeInstanceOf(Date);
    expect(db.client.groupBy.mock.calls[0][0].where.createdAt.lte).toBeInstanceOf(Date);
    expect(item.fieldAvailability.activeBrokers.status).toBe("AVAILABLE");
  });

  it("shows a known zero for an agency without linked brokers", async () => {
    const service = new LoyaltyBaseService({} as any);
    const item: any = { attributes: {}, fieldAvailability: {}, provenance: [] };
    await (service as any).attachAgencyActiveBrokers({ brokerAgencies: [] }, item);
    expect(item.attributes.activeBrokers).toBe(0);
  });

  it("does not turn a broker event or metadata update into a direct agency contact", () => {
    const service = new LoyaltyBaseService({} as any);
    const record = {
      id: "agency", name: "Test", updatedAt: new Date(),
      brokerAgencies: [{ broker: { id: "a", clients: [], meetings: [], deals: [], callLogs: [], brokerTourVisited: true, brokerTourDate: "2026-11-09", __workflowCalls: { effective: [] } } }],
      deals: [], __registryDeals: [], __workflowCalls: { effective: [] }, __workflowEvents: { effective: [] },
    };
    const result = (service as any).mapOurAgency(record, null, true);
    expect(result.lastContactAt).toBeNull();
    expect(result.lastActivityAt).toBe("2026-11-09");
  });
});
