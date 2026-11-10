import "reflect-metadata";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from "@nestjs/common";
import { applyAgencyCompanyProjection } from "../loyalty-base/agency-profile-projection";
import {
  applyAgencyManualProjection,
  normalizeAgencyManualPatch,
} from "./agency-manual-profile";
import { AgencyWorkspaceService } from "./agency-workspace.service";
import { LoyaltyWorkflowService } from "./loyalty-workflow.service";

const operator: any = { id: "operator", role: "MANAGER" };
function fixture() {
  let row: any = {
    id: "agency",
    manualProfile: { specialTerms: "keep" },
    manualProfileFieldSources: {
      specialTerms: { actorId: "Alice", updatedAt: "2026-01-01T00:00:00Z" },
    },
    manualProfileVersion: 1,
  };
  const db: any = {
    $queryRaw: jest.fn(),
    agency: {
      findUnique: jest.fn(async () => row),
      updateMany: jest.fn(async ({ where, data }) => {
        if (where.manualProfileVersion !== row.manualProfileVersion)
          return { count: 0 };
        row = {
          ...row,
          ...data,
          manualProfileVersion: row.manualProfileVersion + 1,
        };
        return { count: 1 };
      }),
    },
    loyaltyCallAssignment: { findFirst: jest.fn(async () => ({ id: "own" })) },
    loyaltyWorkflowAudit: { create: jest.fn() },
  };
  db.$transaction = async (fn: any) => fn(db);
  const permissions: any = {
    require: jest.fn(),
    effective: jest.fn(async () => ({ permissions: [] })),
  };
  return {
    db,
    permissions,
    row: () => row,
    service: new AgencyWorkspaceService(db, permissions, {} as any, {} as any),
  };
}
describe("manual agency profile", () => {
  it.each([
    { inn: "123" },
    { brokerCount: "999" },
    { bankAccount: "123" },
    { website: "javascript:alert(1)" },
    { website: "https://user:secret@example.test" },
    { lastAgencyMeetingDate: "2026-02-30" },
    { nextAgreementDueAt: "2026-02-30T10:00:00Z" },
    { nextAgreementDueAt: "2026-01-01T10:00" },
    { agencySize: "OTHER" },
    { projectsOnSite: true },
    { specialTerms: "x".repeat(2001) },
    {},
  ])("rejects unsupported or invalid fields %p", (patch) => {
    expect(() => normalizeAgencyManualPatch(patch)).toThrow(
      BadRequestException,
    );
  });
  it("normalizes empty values to a removed override", () =>
    expect(
      normalizeAgencyManualPatch({ website: "  ", specialTerms: " text " }),
    ).toEqual({ website: null, specialTerms: "text" }));
  it("preserves independent fields and per-field authors, and audits the CAS", async () => {
    const f = fixture();
    await f.service.profile(
      "agency",
      { expectedVersion: 1, attributes: { website: "https://example.test" } },
      operator,
    );
    expect(f.row().manualProfile).toEqual({
      specialTerms: "keep",
      website: "https://example.test",
    });
    expect(f.row().manualProfileFieldSources.specialTerms.actorId).toBe(
      "Alice",
    );
    expect(f.row().manualProfileFieldSources.website.actorId).toBe(operator.id);
    expect(f.permissions.require).toHaveBeenCalledWith(operator, "ENTITY_EDIT");
    expect(f.db.loyaltyWorkflowAudit.create).toHaveBeenCalledTimes(1);
    await expect(
      f.service.profile(
        "agency",
        { expectedVersion: 1, attributes: { website: null } },
        operator,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });
  it("rechecks assignment scope after obtaining the agency lock", async () => {
    const f = fixture();
    f.db.loyaltyCallAssignment.findFirst.mockResolvedValue(null);
    await expect(
      f.service.profile(
        "agency",
        { expectedVersion: 1, attributes: { website: null } },
        operator,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.db.$queryRaw).toHaveBeenCalled();
    expect(f.db.agency.updateMany).not.toHaveBeenCalled();
  });
  it("null clears manual source and exposes CRM without changing its snapshot", async () => {
    const f = fixture();
    await f.service.profile(
      "agency",
      { expectedVersion: 1, attributes: { specialTerms: null } },
      operator,
    );
    expect(f.row().manualProfile).toEqual({});
    expect(f.row().manualProfileFieldSources).toEqual({});
    const record: any = {
      ...f.row(),
      inn: "9702028892",
      amoCompanySync: {
        profile: { website: "https://crm.test" },
        fieldSources: { website: { companyIds: ["1"], fieldId: 557907 } },
        lastSuccessAt: new Date(),
      },
    };
    const before = JSON.stringify(record.amoCompanySync),
      item: any = { attributes: {}, metrics: {} };
    applyAgencyCompanyProjection(record, item);
    applyAgencyManualProjection(record, item);
    expect(item.attributes.website).toBe("https://crm.test");
    expect(JSON.stringify(record.amoCompanySync)).toBe(before);
  });
  it("manual value has only its own active provenance while CRM origins remain separate", () => {
    const item: any = {
      attributes: { website: "https://crm.test" },
      provenance: [{ field: "website", source: "AMO" }],
    };
    applyAgencyManualProjection(
      {
        manualProfile: { website: "https://manual.test" },
        manualProfileFieldSources: {
          website: { actorId: "Alice", updatedAt: "2026-01-01T00:00:00Z" },
        },
        manualProfileUpdatedById: "Bob",
      },
      item,
    );
    expect(item.attributes.website).toBe("https://manual.test");
    expect(item.provenance).toHaveLength(1);
    expect(item.provenance[0].actorId).toBe("Alice");
    expect(item.sourceProvenance[0].source).toBe("AMO");
  });
});
describe("agency call metadata", () => {
  const workflow: any = new LoyaltyWorkflowService(
    {} as any,
    {} as any,
    {} as any,
  );
  it.each(["2030-01-01T00:00:00Z", "2026-01-01T10:00", "2026-02-30T00:00:00Z"])(
    "rejects invalid actual date %s",
    (occurredAt) =>
      expect(() =>
        workflow.validateAgencyCallMetadata("AGENCY", { occurredAt }),
      ).toThrow(BadRequestException),
  );
  it("rejects additional metadata on broker calls", () =>
    expect(() =>
      workflow.validateAgencyCallMetadata("BROKER", { interest: "x" }),
    ).toThrow(BadRequestException));
  it("retains metadata on correction, supports clearing, and compares create/retry payloads", () => {
    expect(
      workflow.agencyCallMetadata(
        { interest: "" },
        { interest: "old", agreement: "keep", otherStoredFact: 1 },
      ),
    ).toEqual({ agreement: "keep", otherStoredFact: 1 });
    expect(workflow.agencyCallMetadata({ agreement: "" })).toEqual({
      agreement: null,
    });
    expect(workflow.agencyCallMetadata({}, { agreement: null })).toEqual({
      agreement: null,
    });
    expect(
      workflow.sameAttemptValues(
        { result: "INFORMED", metadata: { agreement: null } },
        { expectedVersion: 1, result: "INFORMED" },
      ),
    ).toBe(false);
    const existing = {
      result: "INFORMED",
      metadata: { interest: "x" },
      occurredAt: new Date("2026-01-01T00:00:00Z"),
    };
    expect(
      workflow.sameAttemptValues(
        existing,
        { result: "INFORMED" },
        existing.metadata,
      ),
    ).toBe(true);
    expect(
      workflow.sameAttemptValues(existing, {
        result: "INFORMED",
        expectedVersion: 1,
      }),
    ).toBe(false);
    expect(
      workflow.sameAttemptValues(
        {
          ...existing,
          metadata: {
            interest: "x",
            callOccurredAt: "2026-01-01T00:00:00.000Z",
          },
        },
        {
          result: "INFORMED",
          expectedVersion: 1,
          interest: "x",
          occurredAt: "2026-01-01T03:00:00+03:00",
        },
      ),
    ).toBe(true);
    expect(
      workflow.sameAttemptValues(existing, {
        result: "INFORMED",
        expectedVersion: 1,
        interest: "x",
        occurredAt: "2026-01-02T00:00:00Z",
      }),
    ).toBe(false);
  });
});
