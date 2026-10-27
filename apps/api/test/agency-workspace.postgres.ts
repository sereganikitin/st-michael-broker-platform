/** Real PostgreSQL + HTTP integration. Dedicated disposable local DB only. */
import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  ValidationPipe,
  Controller,
  Get,
  Req,
  UseGuards,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PassportModule } from "@nestjs/passport";
import { sign } from "jsonwebtoken";
import { AgencyWorkspaceController } from "../src/loyalty-workflow/agency-workspace.controller";
import { AgencyWorkspaceService } from "../src/loyalty-workflow/agency-workspace.service";
import { AgencyCallReviewService } from "../src/loyalty-workflow/agency-call-review.service";
import { LoyaltyWorkflowController } from "../src/loyalty-workflow/loyalty-workflow.controller";
import { LoyaltyWorkflowService } from "../src/loyalty-workflow/loyalty-workflow.service";
import { LoyaltyPermissionService } from "../src/loyalty-workflow/loyalty-permission.service";
import { LoyaltyBaseService } from "../src/loyalty-base/loyalty-base.service";
import { JwtStrategy } from "../src/auth/jwt.strategy";
import { AuthService } from "../src/auth/auth.service";
import { JwtAuthGuard } from "../src/auth/jwt-auth.guard";
import { LoyaltyBaseController } from "../src/loyalty-base/loyalty-base.controller";
import { PartnerSheetService } from "../src/loyalty-base/partner-sheet.service";

@Controller("auth")
@UseGuards(JwtAuthGuard)
class LocalProfileController {
  @Get("me") me(@Req() req: any) {
    return { ...req.user, agencies: [], status: "ACTIVE" };
  }
}

const url = new URL(process.env.DATABASE_URL || "http://invalid");
if (
  url.hostname !== "127.0.0.1" ||
  url.port !== "55439" ||
  url.pathname !== "/agency_audit"
)
  throw Error("DEDICATED_LOCAL_DATABASE_REQUIRED");
const { PrismaClient } = require("@prisma/client");
const { encodeSnapshot } = require(
  resolve("scripts/partner-sheet/snapshot.cjs"),
);
const { COLUMNS } = require(resolve("scripts/partner-sheet/details.cjs"));
const db = new PrismaClient();
process.env.JWT_SECRET = "agency-local-integration-only";
let app: any;
let passed = 0;
async function main() {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "brokers", "agencies", "system_settings" CASCADE',
  );
  const users: any = {};
  for (const [i, role] of ["ADMIN", "MANAGER", "MANAGER", "BROKER"].entries()) {
    const row = await db.broker.create({
      data: {
        id: randomUUID(),
        fullName: `Synthetic ${i}`,
        phone: `+7000000000${i}`,
        role,
        status: "ACTIVE",
      },
    });
    users[["admin", "a", "b", "broker"][i]] = row;
  }
  for (const user of [users.a, users.b])
    for (const permission of ["READ_OWN_QUEUE", "CALL_EXECUTE", "ENTITY_EDIT"])
      await db.loyaltyUserGrant.create({
        data: { userId: user.id, permission, grantedById: users.admin.id },
      });
  const agencies = [];
  for (let i = 0; i < 3; i++)
    agencies.push(
      await db.agency.create({
        data: { name: `Synthetic agency ${i}`, inn: `AUDIT-${randomUUID()}` },
      }),
    );
  const snapshot = {
    version: "agency-v1-2",
    loadedAt: new Date().toISOString(),
    sourceHash: "a".repeat(64),
    readOnly: true,
    matched: 3,
    review: 0,
    new: 0,
    sourceRowCount: 3,
    audit: {
      sourceFields: COLUMNS.length * 3,
      sourceFilled: 0,
      cabinetMissing: 3,
    },
    items: agencies.map((a, i) => ({
      key: `Партнеры 2026:${6 + i}`,
      name: a.name,
      type: i === 2 ? "Ключевой" : "АН",
      status: "MATCHED",
      matchedAgency: {
        id: a.id,
        name: a.name,
        updatedAt: new Date().toISOString(),
        fields: [],
      },
      periods: [
        {
          tab: "Партнеры 2026",
          row: 6 + i,
          baselineRub: "0.00",
          addedRub: "0.00",
          totalRub: "0.00",
          fields: COLUMNS.map((c: number) => ({
            column: String.fromCharCode(65 + c),
            label: "Synthetic",
            value: "",
          })),
        },
      ],
    })),
  };
  await db.systemSetting.create({
    data: {
      key: "partner-sheet-v1-2:verified-snapshot",
      value: encodeSnapshot(snapshot),
    },
  });
  const module = await Test.createTestingModule({
    imports: [PassportModule],
    controllers: [
      AgencyWorkspaceController,
      LoyaltyWorkflowController,
      LocalProfileController,
      LoyaltyBaseController,
    ],
    providers: [
      AgencyWorkspaceService,
      AgencyCallReviewService,
      LoyaltyWorkflowService,
      LoyaltyPermissionService,
      LoyaltyBaseService,
      JwtStrategy,
      { provide: "PrismaClient", useValue: db },
      {
        provide: PartnerSheetService,
        useFactory: () => {
          const source = new PartnerSheetService(db, {
            sendSafely: () => {
              throw Error("EXTERNAL_ALERT_FORBIDDEN_IN_TEST");
            },
          } as any);
          (source as any).cached = {
            expires: Number.MAX_SAFE_INTEGER,
            value: snapshot,
          };
          return source;
        },
      },
      // No SMS, amoCRM, queues or scheduled services. Production JWT validation
      // uses real local Broker rows through this narrow auth repository adapter.
      {
        provide: AuthService,
        useValue: {
          validateBroker: (id: string) =>
            db.broker.findUnique({ where: { id } }),
        },
      },
    ],
  }).compile();
  app = module.createNestApplication({ logger: false });
  app.setGlobalPrefix("api");
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  await app.listen(55440, "127.0.0.1");
  const request = async (
    path: string,
    actor: string | null = "admin",
    method = "GET",
    body?: any,
    expected = 200,
  ) => {
    const token = actor
      ? sign(
          { sub: users[actor].id, type: "access", authVersion: 0 },
          process.env.JWT_SECRET!,
          { expiresIn: "1h" },
        )
      : "";
    const r = await fetch(
      `http://127.0.0.1:55440/api/loyalty-workflow/${path}`,
      {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    );
    const text = await r.text();
    let value: any;
    try {
      value = JSON.parse(text);
    } catch {
      value = text;
    }
    assert.equal(
      r.status,
      expected,
      `${method} ${path}: ${r.status} ${text.slice(0, 350)}`,
    );
    passed++;
    return value;
  };
  await request("agencies-v1-2", null, "GET", undefined, 401);
  await request("agencies-v1-2", "broker", "GET", undefined, 403);
  await request(
    "agencies-v1-2/script",
    "a",
    "POST",
    {
      expectedVersion: 0,
      text: "Synthetic",
      owner: "Synthetic",
      validUntil: "2030-01-01T00:00:00Z",
    },
    403,
  );
  await request(
    "agencies-v1-2/script",
    "admin",
    "POST",
    {
      expectedVersion: 0,
      text: "Synthetic script",
      owner: "Synthetic owner",
      validUntil: "2030-01-01T00:00:00Z",
    },
    201,
  );
  const pilotBody = {
    submissionId: randomUUID(),
    name: "Synthetic pilot",
    agencyIds: agencies.map((a) => a.id),
    assigneeId: users.a.id,
    sourceHash: snapshot.sourceHash,
  };
  const campaign = await request(
    "agencies-v1-2/pilot",
    "admin",
    "POST",
    pilotBody,
    201,
  );
  const retry = await request(
    "agencies-v1-2/pilot",
    "admin",
    "POST",
    pilotBody,
    201,
  );
  assert.equal(campaign.id, retry.id);
  passed++;
  const active = await request(
    `campaigns/${campaign.id}/activate`,
    "admin",
    "POST",
    { expectedVersion: campaign.version },
    201,
  );
  let aList = await request("agencies-v1-2", "a");
  assert.equal(aList.cards.length, 3);
  passed++;
  assert.equal((await request("agencies-v1-2", "b")).cards.length, 0);
  passed++;
  const assignment = aList.cards.find((c: any) => c.id === agencies[0].id)
    .assignments[0];
  const session = randomUUID();
  const claimed = await request(
    `agencies-v1-2/assignments/${assignment.id}/claim`,
    "a",
    "POST",
    { expectedVersion: assignment.version, workSessionId: session },
    201,
  );
  await request(
    `agencies-v1-2/assignments/${assignment.id}/claim`,
    "b",
    "POST",
    { expectedVersion: claimed.version, workSessionId: randomUUID() },
    403,
  );
  await request(
    `agencies-v1-2/assignments/${assignment.id}/claim`,
    "a",
    "POST",
    { expectedVersion: claimed.version, workSessionId: randomUUID() },
    409,
  );
  const attemptBody = {
    expectedVersion: claimed.version,
    workSessionId: session,
    submissionId: randomUUID(),
    result: "SEND_INFORMATION",
    comment: "Synthetic promise",
    nextStep: "Send materials",
    nextActionKind: "SEND_MATERIALS",
    nextActionAt: "2027-01-01T10:00:00+03:00",
  };
  await request(
    `assignments/${assignment.id}/attempts`,
    "a",
    "POST",
    { ...attemptBody, nextActionAt: undefined },
    400,
  );
  const concurrent = await Promise.all([
    request(
      `assignments/${assignment.id}/attempts`,
      "a",
      "POST",
      attemptBody,
      201,
    ),
    request(
      `assignments/${assignment.id}/attempts`,
      "a",
      "POST",
      attemptBody,
      201,
    ),
  ]);
  const attempt = concurrent[0];
  const reviewPath = `agencies-v1-2/${agencies[0].id}/attempts/${attempt.id}/reviews`;
  const reviewBody = {
    submissionId: randomUUID(),
    expectedVersion: 0,
    criteria: {
      offerCurrent: "PASS",
      needsClarified: "NOT_OBSERVABLE",
      agreementRecorded: "FAIL",
      nextStepCorrect: "PASS",
    },
    comment: "Synthetic manual QA; no audio evidence",
  };
  await request(reviewPath, "a", "POST", reviewBody, 403);
  await request(reviewPath, "broker", "GET", undefined, 403);
  await request(
    reviewPath,
    "admin",
    "POST",
    {
      ...reviewBody,
      criteria: { ...reviewBody.criteria, offerCurrent: "AUTO" },
    },
    400,
  );
  await request(
    `agencies-v1-2/${agencies[1].id}/attempts/${attempt.id}/reviews`,
    "admin",
    "POST",
    reviewBody,
    404,
  );
  const firstReviews = await Promise.all([
    request(reviewPath, "admin", "POST", reviewBody, 201),
    request(reviewPath, "admin", "POST", reviewBody, 201),
  ]);
  assert.equal(firstReviews[0].id, firstReviews[1].id);
  passed++;
  await request(
    reviewPath,
    "admin",
    "POST",
    { ...reviewBody, comment: "changed retry" },
    409,
  );
  await request(
    reviewPath,
    "admin",
    "POST",
    { ...reviewBody, submissionId: randomUUID() },
    409,
  );
  await request(
    reviewPath,
    "admin",
    "POST",
    { ...reviewBody, submissionId: randomUUID(), expectedVersion: 1 },
    400,
  );
  const revision = {
    ...reviewBody,
    submissionId: randomUUID(),
    expectedVersion: 1,
    correctionReason: "Synthetic evidence clarified",
    comment: "Revised manual QA",
  };
  await request(reviewPath, "admin", "POST", revision, 201);
  const reviewHistory = await request(reviewPath);
  assert.deepEqual(
    reviewHistory.reviews.map((r: any) => r.version),
    [2, 1],
  );
  passed++;
  assert.equal(reviewHistory.reviews[1].comment, reviewBody.comment);
  passed++;
  assert.equal(
    await db.agencyCallReview.count({ where: { callAttemptId: attempt.id } }),
    2,
  );
  passed++;
  assert.equal(concurrent[0].id, concurrent[1].id);
  passed++;
  await request(
    `assignments/${assignment.id}/attempts`,
    "a",
    "POST",
    attemptBody,
    201,
  );
  assert.equal(
    await db.loyaltyCallAttempt.count({
      where: { assignmentId: assignment.id },
    }),
    1,
  );
  passed++;
  const task = await db.loyaltyTask.findFirstOrThrow({
    where: { callAttemptId: attempt.id },
  });
  assert.equal(task.status, "OPEN");
  assert.equal(task.kind, "SEND_MATERIALS");
  passed++;
  // An unrelated failed call must not fulfil the material promise.
  const next = aList.cards.find((c: any) => c.id === agencies[1].id)
    .assignments[0];
  const nextSession = randomUUID();
  const nextClaim = await request(
    `agencies-v1-2/assignments/${next.id}/claim`,
    "a",
    "POST",
    { expectedVersion: next.version, workSessionId: nextSession },
    201,
  );
  await db.loyaltyTask.create({
    data: {
      ourAgencyId: agencies[1].id,
      assignmentId: next.id,
      title: "Pending promise",
      kind: "SEND_MATERIALS",
      assignedToId: users.a.id,
      createdById: users.admin.id,
      dueAt: new Date("2027-01-01"),
    },
  });
  await request(
    `assignments/${next.id}/attempts`,
    "a",
    "POST",
    {
      expectedVersion: nextClaim.version,
      workSessionId: nextSession,
      submissionId: randomUUID(),
      result: "NO_ANSWER",
      comment: "No answer",
    },
    201,
  );
  assert.equal(
    await db.loyaltyTask.count({
      where: { assignmentId: next.id, status: "OPEN" },
    }),
    1,
  );
  passed++;
  const third = aList.cards.find((c: any) => c.id === agencies[2].id)
    .assignments[0];
  const moved = await request(
    `agencies-v1-2/assignments/${third.id}/reassign`,
    "admin",
    "PATCH",
    { expectedVersion: third.version, assigneeId: users.b.id },
  );
  assert.notEqual(moved.id, third.id);
  assert.equal(
    (
      await db.loyaltyCallAssignment.findUniqueOrThrow({
        where: { id: third.id },
      })
    ).assignedToId,
    users.a.id,
  );
  passed++;
  await request(
    `agencies-v1-2/assignments/${third.id}/claim`,
    "a",
    "POST",
    { expectedVersion: third.version, workSessionId: randomUUID() },
    409,
  );
  const report = await request(
    `agencies-v1-2?assigneeId=${users.a.id}`,
    "admin",
  );
  assert.equal(report.metrics.attempts, 2);
  assert.equal(report.metrics.coverage.denominator, 3);
  passed++;
  assert.equal(
    (await request(`agencies-v1-2?assigneeId=${users.b.id}`, "admin")).metrics
      .attempts,
    0,
  );
  passed++;
  const filtered = await request(
    `agencies-v1-2?agencyType=${encodeURIComponent("Ключевой")}`,
    "admin",
  );
  assert.equal(filtered.cards.length, 1);
  passed++;
  const byAgency = await request(
    `agencies-v1-2?agencyId=${agencies[0].id}`,
    "admin",
  );
  assert.equal(byAgency.cards.length, 1);
  passed++;
  await request("agencies-v1-2/export", "a", "POST", {}, 403);
  await request("agencies-v1-2/export", "admin", "POST", {}, 201);
  // Legacy mutable assignments must not move the author's call statistics.
  await db.loyaltyCallAssignment.update({
    where: { id: assignment.id },
    data: { assignedToId: users.b.id },
  });
  assert.equal(
    (await request(`agencies-v1-2?assigneeId=${users.b.id}`, "admin")).metrics
      .attempts,
    0,
  );
  passed++;
  assert.equal(
    (await request(`agencies-v1-2?assigneeId=${users.a.id}`, "admin")).metrics
      .attempts,
    2,
  );
  passed++;
  await db.loyaltyCallAssignment.update({
    where: { id: assignment.id },
    data: { assignedToId: users.a.id },
  });
  const reviewed = await request(
    `assignments/${assignment.id}/attempts/${attempt.id}/corrections`,
    "admin",
    "POST",
    {
      submissionId: randomUUID(),
      result: "SEND_INFORMATION",
      comment: "Admin corrected original author evidence",
      nextStep: "Send materials",
      nextActionKind: "SEND_MATERIALS",
      nextActionAt: "2027-01-01T10:00:00+03:00",
      correctionReason: "Synthetic review",
    },
    201,
  );
  assert.equal(
    (await request(`agencies-v1-2?assigneeId=${users.a.id}`, "admin")).metrics
      .attempts,
    2,
  );
  passed++;
  assert.equal(
    (await request(`agencies-v1-2?assigneeId=${users.admin.id}`, "admin"))
      .metrics.attempts,
    0,
  );
  passed++;
  const handedTask = await db.loyaltyTask.findFirstOrThrow({
    where: { callAttemptId: reviewed.id },
  });
  const handed = await request(`tasks/${handedTask.id}`, "admin", "PATCH", {
    expectedVersion: handedTask.version,
    assignedToId: users.b.id,
  });
  await request(
    `assignments/${assignment.id}/attempts/${reviewed.id}/corrections`,
    "a",
    "POST",
    {
      submissionId: randomUUID(),
      result: "SEND_INFORMATION",
      comment: "Should not change handed task",
      nextStep: "Changed other operator task",
      nextActionKind: "SEND_MATERIALS",
      nextActionAt: "2027-01-01T10:00:00+03:00",
      correctionReason: "Synthetic negative test",
    },
    403,
  );
  assert.equal(
    (await db.loyaltyTask.findUniqueOrThrow({ where: { id: handedTask.id } }))
      .title,
    "Send materials",
  );
  passed++;
  await request(`tasks/${handedTask.id}`, "admin", "PATCH", {
    expectedVersion: handed.version,
    assignedToId: users.a.id,
  });
  const contextualAssignment = await db.loyaltyCallAssignment.create({
    data: {
      campaignId: campaign.id,
      ourAgencyId: agencies[0].id,
      assignedToId: users.b.id,
      assignedById: users.admin.id,
    },
  });
  const contextView = await request(
    `agencies-v1-2?assigneeId=${users.b.id}`,
    "admin",
  );
  assert.equal(contextView.metrics.attempts, 0);
  passed++;
  assert.ok(
    contextView.cards
      .find((c: any) => c.id === agencies[0].id)
      .contextAttempts.some((a: any) => a.id === attempt.id),
  );
  passed++;
  // Force a real row-lock wait: ownership changes while claim is blocked.
  let unlock!: () => void;
  let ready!: () => void;
  const locked = new Promise<void>((r) => (ready = r));
  const gate = new Promise<void>((r) => (unlock = r));
  const holder = db.$transaction(
    async (tx: any) => {
      await tx.$queryRawUnsafe(
        "SELECT id FROM agencies WHERE id=$1 FOR UPDATE",
        agencies[2].id,
      );
      ready();
      await gate;
      await tx.loyaltyCallAssignment.update({
        where: { id: moved.id },
        data: { assignedToId: users.a.id, version: { increment: 1 } },
      });
    },
    { timeout: 15000 },
  );
  await locked;
  const waitingClaim = request(
    `agencies-v1-2/assignments/${moved.id}/claim`,
    "b",
    "POST",
    { expectedVersion: 1, workSessionId: randomUUID() },
    403,
  );
  for (let i = 0; i < 50; i++) {
    const rows = await db.$queryRawUnsafe(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",
    );
    if (rows[0].n > 0) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  unlock();
  await holder;
  await waitingClaim;
  passed++;
  // Contacts are optimistic and audited; a stale writer cannot overwrite.
  const contact = {
    id: randomUUID(),
    name: "Synthetic contact",
    role: "Coordinator",
    phone: "+70000000009",
    alternatePhone: "",
    source: "Local integration",
    verifiedAt: "2026-01-01T10:00:00Z",
    archived: false,
  };
  await request(`agencies-v1-2/${agencies[2].id}/contacts`, "a", "PATCH", {
    expectedVersion: 1,
    contacts: [contact],
  });
  await request(
    `agencies-v1-2/${agencies[2].id}/contacts`,
    "a",
    "PATCH",
    { expectedVersion: 1, contacts: [] },
    409,
  );
  assert.equal(
    (await db.agency.findUniqueOrThrow({ where: { id: agencies[2].id } }))
      .callContacts.length,
    1,
  );
  passed++;
  // Explicit task type, stop/re-enable lifecycle and legacy compatibility.
  await request(
    `agencies-v1-2/tasks/${task.id}/resume`,
    "a",
    "POST",
    { expectedVersion: task.version },
    400,
  );
  const lastAssignment = await db.loyaltyCallAssignment.findUniqueOrThrow({
    where: { id: moved.id },
  });
  const stopSession = randomUUID();
  const stopClaim = await request(
    `agencies-v1-2/assignments/${moved.id}/claim`,
    "a",
    "POST",
    { expectedVersion: lastAssignment.version, workSessionId: stopSession },
    201,
  );
  await request(
    `assignments/${moved.id}/attempts`,
    "a",
    "POST",
    {
      expectedVersion: stopClaim.version,
      workSessionId: stopSession,
      submissionId: randomUUID(),
      result: "DO_NOT_CALL",
      comment: "Synthetic stop request",
    },
    201,
  );
  const stopped = await db.agency.findUniqueOrThrow({
    where: { id: agencies[2].id },
  });
  assert.equal(stopped.doNotCall, true);
  passed++;
  assert.equal(
    await db.loyaltyCallAssignment.count({
      where: {
        ourAgencyId: agencies[2].id,
        status: { in: ["PENDING", "IN_PROGRESS"] },
      },
    }),
    0,
  );
  passed++;
  await request(
    `agencies-v1-2/${agencies[2].id}/call-control`,
    "a",
    "PATCH",
    {
      expectedVersion: stopped.callControlVersion,
      doNotCall: false,
      reason: "Not authorized",
    },
    403,
  );
  await request(
    `agencies-v1-2/${agencies[2].id}/call-control`,
    "admin",
    "PATCH",
    {
      expectedVersion: stopped.callControlVersion,
      doNotCall: false,
      reason: "Synthetic reviewed consent",
    },
  );
  const legacy = await db.loyaltyCallCampaign.create({
    data: {
      name: "Legacy",
      message: "Legacy",
      base: "OUR",
      entityType: "AGENCY",
      status: "ACTIVE",
      filterSnapshot: {},
      filterHash: "l".repeat(64),
      expectedCount: 1,
      createdById: users.admin.id,
    },
  });
  const legacyAssignment = await db.loyaltyCallAssignment.create({
    data: {
      campaignId: legacy.id,
      ourAgencyId: agencies[2].id,
      assignedToId: users.a.id,
      assignedById: users.admin.id,
    },
  });
  await request(
    `assignments/${legacyAssignment.id}/attempts`,
    "a",
    "POST",
    {
      expectedVersion: 1,
      submissionId: randomUUID(),
      result: "SEND_INFORMATION",
      comment: "Legacy behavior preserved",
    },
    201,
  );
  if (process.env.AGENCY_KEEP_API === "1") {
    const fs = require("node:fs");
    fs.writeFileSync(
      resolve("work/api-fixture.json"),
      JSON.stringify({
        users: Object.fromEntries(
          Object.entries(users).map(([key, u]: any) => [
            key,
            {
              id: u.id,
              token: sign(
                { sub: u.id, type: "access", authVersion: 0 },
                process.env.JWT_SECRET!,
                { expiresIn: "2h" },
              ),
            },
          ]),
        ),
        agencies: agencies.map((a) => ({ id: a.id, name: a.name })),
      }),
    );
  }
  if (process.env.AGENCY_KEEP_API === "1") {
    console.log(`LOCAL_API_READY assertions=${passed}`);
    return;
  }
  console.log(`PASS real PostgreSQL + HTTP/JWT: ${passed} assertions`);
}
main()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (process.env.AGENCY_KEEP_API !== "1" || process.exitCode) {
      await app?.close();
      await db.$disconnect();
    }
  });
