import "reflect-metadata";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from "@nestjs/common";
import {
  AgencyCampaignOutcomeService,
  campaignOutcomeCsv,
  campaignOutcomeProjection,
  validateCampaignOutcome,
} from "./agency-campaign-outcome.service";
const now = new Date("2026-10-27T10:00:00Z");
const body = {
  eventId: "event",
  submissionId: "submission",
  expectedVersion: 0,
  kind: "MEETING",
  status: "PLANNED",
  occurredAt: "2026-10-28T10:00:00Z",
  basis: "Confirmed date",
  comment: "",
};
describe("manual campaign results", () => {
  it("allows future plans but not future facts or cancellation", () => {
    expect(() => validateCampaignOutcome(body, now)).not.toThrow();
    for (const status of ["HELD", "CANCELLED"])
      expect(() => validateCampaignOutcome({ ...body, status }, now)).toThrow(
        BadRequestException,
      );
  });
  it("requires compatible kind/status, nonempty basis and revision reason", () => {
    for (const patch of [
      { kind: "REACTIVATION" },
      { basis: " " },
      { expectedVersion: 1 },
    ])
      expect(() => validateCampaignOutcome({ ...body, ...patch }, now)).toThrow(
        BadRequestException,
      );
  });
  it("does not revive a prior fact when cancellation is outside the period or author filter", () => {
    const rows = [
      {
        ...body,
        id: "old",
        eventId: "x",
        version: 1,
        status: "HELD",
        occurredAt: "2026-10-26T10:00:00Z",
        actorId: "operator",
      },
      {
        ...body,
        id: "new",
        eventId: "x",
        version: 2,
        status: "CANCELLED",
        occurredAt: "2026-10-28T10:00:00Z",
        actorId: "leader",
      },
    ];
    expect(
      campaignOutcomeProjection(
        rows,
        new Date("2026-10-26"),
        new Date("2026-10-27"),
        "operator",
      ).events,
    ).toEqual([]);
  });
  it("counts latest event once and keeps cancelled separate from facts", () => {
    const rows = [
      { ...body, eventId: "a", version: 1, status: "PLANNED", occurredAt: now },
      { ...body, eventId: "a", version: 2, status: "HELD", occurredAt: now },
      {
        ...body,
        eventId: "b",
        version: 1,
        kind: "TOUR",
        status: "CANCELLED",
        occurredAt: now,
      },
      {
        ...body,
        eventId: "c",
        version: 1,
        kind: "REACTIVATION",
        status: "REACTIVATED",
        occurredAt: now,
      },
    ];
    const result = campaignOutcomeProjection(
      rows,
      new Date("2026-10-27"),
      new Date("2026-10-28"),
    );
    expect(result.events).toHaveLength(3);
    expect(result.counts).toEqual({
      meetingsScheduled: 1,
      toursScheduled: 0,
      meetingsPlanned: 0,
      meetingsHeld: 1,
      toursPlanned: 0,
      toursHeld: 0,
      reactivations: 1,
      cancelled: 1,
    });
  });
  it("exports both plan and fact with spreadsheet formula protection", () => {
    const result = campaignOutcomeProjection(
      [{ ...body, version: 1, basis: "=HYPERLINK(1)", occurredAt: now }],
      new Date("2026-10-27"),
      new Date("2026-10-28"),
    );
    expect(campaignOutcomeCsv(result)).toContain("'=HYPERLINK(1)");
    expect(campaignOutcomeCsv(result)).toContain("Последняя версия плана");
  });
  it("checks ownership again under the assignment lock", async () => {
    const db: any = {
      $queryRawUnsafe: jest.fn(),
      loyaltyCallAssignment: {
        findFirst: jest.fn().mockResolvedValue({ assignedToId: "other" }),
      },
    };
    db.$transaction = (f: any) => f(db);
    const permissions: any = {
      requireStaff: jest.fn(),
      effective: jest.fn().mockResolvedValue({ permissions: ["CALL_EXECUTE"] }),
    };
    const service = new AgencyCampaignOutcomeService(db, permissions);
    await expect(
      service.save("agency", "assignment", body, {
        id: "old",
        role: "MANAGER",
      } as any),
    ).rejects.toThrow(ForbiddenException);
    expect(db.$queryRawUnsafe.mock.invocationCallOrder[0]).toBeLessThan(
      db.loyaltyCallAssignment.findFirst.mock.invocationCallOrder[0],
    );
  });
  it("rejects a reused event key from another assignment", async () => {
    const db: any = {
      $queryRawUnsafe: jest.fn(),
      loyaltyCallAssignment: {
        findFirst: jest.fn().mockResolvedValue({ assignedToId: "me" }),
      },
      agencyCampaignOutcome: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest
          .fn()
          .mockResolvedValue({ assignmentId: "elsewhere", version: 1 }),
      },
    };
    db.$transaction = (f: any) => f(db);
    const permissions: any = {
      requireStaff: jest.fn(),
      effective: jest.fn().mockResolvedValue({ permissions: ["CALL_EXECUTE"] }),
    };
    await expect(
      new AgencyCampaignOutcomeService(db, permissions).save(
        "agency",
        "assignment",
        body,
        { id: "me", role: "MANAGER" } as any,
      ),
    ).rejects.toThrow(ConflictException);
  });
  it("does not let the old owner write through a cancelled assignment", async () => {
    const db: any = {
      $queryRawUnsafe: jest.fn(),
      loyaltyCallAssignment: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ assignedToId: "me", status: "CANCELLED" }),
      },
    };
    db.$transaction = (f: any) => f(db);
    const permissions: any = {
      requireStaff: jest.fn(),
      effective: jest.fn().mockResolvedValue({ permissions: ["CALL_EXECUTE"] }),
    };
    await expect(
      new AgencyCampaignOutcomeService(db, permissions).save(
        "agency",
        "assignment",
        body,
        { id: "me", role: "MANAGER" } as any,
      ),
    ).rejects.toThrow(ForbiddenException);
  });
});
