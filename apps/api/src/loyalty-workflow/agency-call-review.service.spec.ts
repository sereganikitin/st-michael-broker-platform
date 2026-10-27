import "reflect-metadata";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { AgencyCallReviewService } from "./agency-call-review.service";
import { AgencyCallReviewDto } from "./agency-call-review.dto";
import { LoyaltyPermissionService } from "./loyalty-permission.service";

const user: any = { id: "reviewer", role: "MANAGER" };
const body = () => ({
  submissionId: "11111111-1111-4111-8111-111111111111",
  expectedVersion: 0,
  criteria: {
    offerCurrent: "PASS",
    needsClarified: "NOT_OBSERVABLE",
    agreementRecorded: "FAIL",
    nextStepCorrect: "PASS",
  },
  comment: "  Based on operator record; audio unavailable  ",
});
function fixture() {
  const rows: any[] = [];
  const db: any = {
    loyaltyCallAttempt: {
      findFirst: jest.fn().mockResolvedValue({ id: "attempt" }),
    },
    agencyCallReview: {
      findUnique: jest.fn(async ({ where }: any) =>
        rows.find((r) => r.submissionId === where.submissionId),
      ),
      findFirst: jest.fn(async () => rows.at(-1)),
      findMany: jest.fn(async () => [...rows].reverse()),
      create: jest.fn(async ({ data }: any) => {
        const row = {
          ...data,
          id: `review-${rows.length}`,
          reviewer: { id: user.id, fullName: "Reviewer" },
        };
        rows.push(row);
        return row;
      }),
    },
    loyaltyWorkflowAudit: { create: jest.fn() },
    $queryRawUnsafe: jest.fn(),
    $transaction: jest.fn(),
  };
  db.$transaction.mockImplementation((fn: any) => fn(db));
  const permissions: any = { require: jest.fn(), requireAll: jest.fn() };
  return {
    rows,
    db,
    permissions,
    service: new AgencyCallReviewService(db, permissions),
  };
}

describe("manual agency call QA", () => {
  it("requires both read-all and independent review permission before any write", async () => {
    const { service, db, permissions } = fixture();
    permissions.requireAll.mockRejectedValue(new ForbiddenException());
    await expect(
      service.save("agency", "attempt", body(), user),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(permissions.requireAll).toHaveBeenCalledWith(user, [
      "READ_ALL",
      "CALL_REVIEW",
    ]);
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it("does not grant review to a manager with read-all only", async () => {
    const permissions = new LoyaltyPermissionService({
      loyaltyUserGrant: {
        findMany: jest.fn().mockResolvedValue([{ permission: "READ_ALL" }]),
      },
    } as any);
    await expect(
      permissions.requireAll(user, ["READ_ALL", "CALL_REVIEW"]),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
  it("rejects an attempt from another agency without creating review or audit", async () => {
    const { service, db } = fixture();
    db.loyaltyCallAttempt.findFirst.mockResolvedValue(null);
    await expect(
      service.save("wrong-agency", "attempt", body(), user),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(db.agencyCallReview.create).not.toHaveBeenCalled();
    expect(db.loyaltyWorkflowAudit.create).not.toHaveBeenCalled();
  });
  it("appends review and audit, retry returns same result without duplicate", async () => {
    const { service, rows, db } = fixture();
    const first = await service.save("agency", "attempt", body(), user);
    expect(await service.save("agency", "attempt", body(), user)).toEqual(
      first,
    );
    expect(rows).toHaveLength(1);
    expect(first).not.toHaveProperty("requestHash");
    expect(first).not.toHaveProperty("submissionId");
    expect(first.comment).toBe(body().comment.trim());
    expect(db.loyaltyWorkflowAudit.create).toHaveBeenCalledTimes(1);
    expect(db.$queryRawUnsafe.mock.invocationCallOrder[0]).toBeLessThan(
      db.agencyCallReview.findFirst.mock.invocationCallOrder[0],
    );
  });
  it("rejects reused submission for changed payload or reviewer", async () => {
    const { service } = fixture();
    await service.save("agency", "attempt", body(), user);
    await expect(
      service.save(
        "agency",
        "attempt",
        { ...body(), comment: "changed" },
        user,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      service.save("agency", "attempt", body(), { ...user, id: "other" }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
  it("detects stale version after lock and preserves previous review", async () => {
    const { service, rows } = fixture();
    await service.save("agency", "attempt", body(), user);
    await expect(
      service.save(
        "agency",
        "attempt",
        { ...body(), submissionId: "new" },
        user,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(rows).toHaveLength(1);
  });
  it("requires revision reason and stores both immutable versions", async () => {
    const { service, rows } = fixture();
    await service.save("agency", "attempt", body(), user);
    const revision = {
      ...body(),
      submissionId: "new",
      expectedVersion: 1,
      comment: "New evidence",
    };
    await expect(
      service.save("agency", "attempt", revision, user),
    ).rejects.toBeInstanceOf(BadRequestException);
    await service.save(
      "agency",
      "attempt",
      { ...revision, correctionReason: " Evidence clarified " },
      user,
    );
    expect(rows.map((r) => r.version)).toEqual([1, 2]);
    expect(rows[0].comment).toBe(body().comment.trim());
    expect(rows[1].correctionReason).toBe("Evidence clarified");
  });
  it("rejects whitespace-only justification", async () => {
    const { service, db } = fixture();
    await expect(
      service.save("agency", "attempt", { ...body(), comment: " " }, user),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it("read is scoped and strips internal idempotency data", async () => {
    const { service, permissions, db } = fixture();
    await service.save("agency", "attempt", body(), user);
    const result = await service.list("agency", "attempt", user);
    expect(permissions.require).toHaveBeenCalledWith(user, "READ_ALL");
    expect(db.loyaltyCallAttempt.findFirst).toHaveBeenLastCalledWith({
      where: { id: "attempt", assignment: { ourAgencyId: "agency" } },
      select: { id: true },
    });
    expect(result.reviews[0]).not.toHaveProperty("requestHash");
  });
  it("validates complete criterion dictionary, version and UUID at HTTP boundary", async () => {
    expect(
      await validate(plainToInstance(AgencyCallReviewDto, body())),
    ).toHaveLength(0);
    for (const invalid of [
      { ...body(), criteria: undefined },
      {
        ...body(),
        criteria: { ...body().criteria, nextStepCorrect: "AUTOMATIC_PASS" },
      },
      { ...body(), criteria: { offerCurrent: "PASS" } },
      { ...body(), expectedVersion: -1 },
      { ...body(), submissionId: "invalid" },
    ])
      expect(
        (await validate(plainToInstance(AgencyCallReviewDto, invalid))).length,
      ).toBeGreaterThan(0);
  });
});
