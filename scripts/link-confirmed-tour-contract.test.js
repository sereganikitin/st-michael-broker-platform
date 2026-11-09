"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { run, TARGET, CONFIRMATION, ACTION, DECISION, hash } = require("./link-confirmed-tour-contract");
const ENV = { CONFIRMED_LINK_SOURCE_SHA: "a".repeat(40), CONFIRMED_LINK_DEPLOYED_SHA: "b".repeat(40),
  GIT_SHA: "b".repeat(40), PRODUCTION_PG_SYSTEM_IDENTIFIER: "123456789", CONFIRMED_LINK_CONFIRMATION: CONFIRMATION,
  CONFIRMED_LINK_CI_ATTESTED: "true", CONFIRMED_LINK_RUN_ID: "42600000000", CONFIRMED_LINK_RUN_ATTEMPT: "1", CONFIRMED_LINK_ACTOR: "operator" };
function fixture() {
  let row = { id: TARGET.id, rowKey: "source-key", source: "REGISTRY", contractNumber: TARGET.contractNumber,
    amount: "15896311.2", project: TARGET.project, brokerId: TARGET.brokerId,
    signedAt: new Date(TARGET.signedAt), paidAt: new Date(TARGET.paidAt), amoLeadId: null, brokerAmoContactId: null,
    saleChannel: "BROKER", sqm: "16.8", apartmentNumber: "290/1", updatedAt: new Date("2026-11-09T00:00:00Z") };
  let audits = []; const queries = [], updates = []; let occupied = false, auditError = false, readbackError = false;
  const tx = {
    $executeRaw: async (sql) => { queries.push(sql.join("?")); },
    $queryRaw: async (sql, id) => { queries.push(sql.join("?")); return sql.join("").includes("pg_control_system") ? [{ name: "broker_platform", identifier: ENV.PRODUCTION_PG_SYSTEM_IDENTIFIER }] : row && id === row.id ? [{ id }] : []; },
    registryDeal: {
      findUnique: async () => { if (readbackError && audits.length) throw new Error("PRIVATE_DB_URL"); return structuredClone(row); },
      findMany: async () => occupied ? [{ id: "other" }] : [],
      updateMany: async (args) => { updates.push(args); row = { ...row, ...args.data, updatedAt: new Date("2026-11-09T01:00:00Z") }; return { count: 1 }; },
    },
    auditLog: { findMany: async () => structuredClone(audits), create: async ({ data }) => {
      if (auditError) throw new Error("PRIVATE_PII"); audits.push(data); return data;
    } },
  };
  const prisma = { $transaction: async (fn) => {
    const before = { row: structuredClone(row), audits: structuredClone(audits) };
    try { return await fn(tx); } catch (e) { row = before.row; audits = before.audits; throw e; }
  } };
  return { prisma, tx, queries, updates, row: () => row, audits: () => audits,
    mutate: patch => Object.assign(row, patch), occupy: () => { occupied = true; },
    failAudit: () => { auditError = true; }, failReadback: () => { readbackError = true; } };
}
async function armed(fx) { const plan = await run({ prisma: fx.prisma, env: ENV }); return { ...ENV, CONFIRMED_LINK_PLAN_SHA256: plan.planSha256 }; }
test("default dry-run is read-only and returns a stable plan fingerprint", async () => {
  const fx = fixture(); const first = await run({ prisma: fx.prisma, env: ENV });
  assert.equal(first.mode, "dry-run"); assert.equal(first.status, "PLANNED"); assert.match(first.planSha256, /^[a-f0-9]{64}$/);
  assert.equal((await run({ prisma: fx.prisma, env: ENV })).planSha256, first.planSha256);
  assert.equal(fx.updates.length, 0); assert.equal(fx.audits().length, 0);
  assert.ok(fx.queries.some(q => q.includes("SET TRANSACTION READ ONLY")));
  assert.ok(!fx.queries.some(q => q.includes("LOCK TABLE")));
});
test("confirmed apply changes only the two link fields and creates one decision audit", async () => {
  const fx = fixture(), env = await armed(fx), before = structuredClone(fx.row());
  const result = await run({ prisma: fx.prisma, mode: "apply", env });
  assert.equal(result.status, "LINKED"); assert.equal(result.verified, true);
  assert.deepEqual(fx.updates[0].data, { amoLeadId: 32185337n, source: "BOTH" });
  for (const key of Object.keys(before).filter(k => !["amoLeadId", "source", "updatedAt"].includes(k))) assert.deepEqual(fx.row()[key], before[key]);
  assert.equal(fx.audits().length, 1); assert.equal(fx.audits()[0].action, ACTION);
  assert.equal(fx.audits()[0].payload.decision, DECISION);
  assert.ok(fx.queries.some(q => q.includes("LOCK TABLE registry_deals IN SHARE ROW EXCLUSIVE MODE")));
});
test("second confirmed apply is idempotent without a duplicate audit", async () => {
  const fx = fixture(), env = await armed(fx);
  await run({ prisma: fx.prisma, mode: "apply", env });
  assert.equal((await run({ prisma: fx.prisma, mode: "apply", env })).status, "ALREADY_LINKED");
  assert.equal(fx.updates.length, 1); assert.equal(fx.audits().length, 1);
});
for (const patch of [ { contractNumber: "another" }, { amount: "15896311.21" }, { project: "SILVER_BOR" }, { brokerId: "other" },
  { signedAt: new Date("2026-06-25") }, { paidAt: null }, { source: "AMO_ONLY" }, { amoLeadId: 123n }, { saleChannel: "DIRECT" }, { brokerAmoContactId: 1n } ]) {
  test("refuses changed exact target guard " + Object.keys(patch)[0], async () => {
    const fx = fixture(), env = await armed(fx); fx.mutate(patch);
    await assert.rejects(run({ prisma: fx.prisma, mode: "apply", env }), e => /TARGET_/.test(e.safeCode));
    assert.equal(fx.updates.length, 0); assert.equal(fx.audits().length, 0);
  });
}
test("does not delete an existing AMO_ONLY row or other occupied lead", async () => {
  const fx = fixture(), env = await armed(fx); fx.occupy();
  await assert.rejects(run({ prisma: fx.prisma, mode: "apply", env }), { safeCode: "AMO_LEAD_ALREADY_OCCUPIED" });
  assert.equal(fx.updates.length, 0);
});
test("refuses business drift from the reviewed dry-run", async () => {
  const fx = fixture(), env = await armed(fx); fx.mutate({ sqm: "17" });
  await assert.rejects(run({ prisma: fx.prisma, mode: "apply", env }), { safeCode: "PLAN_FINGERPRINT_CHANGED" });
  assert.equal(fx.updates.length, 0);
});
test("rollback retains original row when audit insertion fails", async () => {
  const fx = fixture(), env = await armed(fx), before = hash(fx.row()); fx.failAudit();
  await assert.rejects(run({ prisma: fx.prisma, mode: "apply", env }), e => e.safeCode === "DATABASE_OPERATION_FAILED_REVIEW_OUTCOME" && !e.message.includes("PRIVATE"));
  assert.equal(hash(fx.row()), before); assert.equal(fx.audits().length, 0);
});
test("post-commit readback failure is explicit and does not retry a write", async () => {
  const fx = fixture(), env = await armed(fx); let transactions = 0;
  const original = fx.prisma.$transaction;
  fx.prisma.$transaction = async fn => { transactions++; if (transactions === 2) fx.failReadback(); return original(fn); };
  await assert.rejects(run({ prisma: fx.prisma, mode: "apply", env }), { safeCode: "COMMITTED_REQUIRES_READBACK_NO_BLIND_RETRY" });
  assert.equal(fx.row().amoLeadId, 32185337n); assert.equal(fx.updates.length, 1);
});
for (const patch of [{ CONFIRMED_LINK_CONFIRMATION: "" }, { CONFIRMED_LINK_CI_ATTESTED: "false" }, { CONFIRMED_LINK_PLAN_SHA256: "" },
  { CONFIRMED_LINK_RUN_ATTEMPT: "2" }, { GIT_SHA: "c".repeat(40) }, { PRODUCTION_PG_SYSTEM_IDENTIFIER: "" }]) {
  test("refuses missing execution gate " + Object.keys(patch)[0], async () => {
    const fx = fixture(), env = { ...await armed(fx), ...patch };
    await assert.rejects(run({ prisma: fx.prisma, mode: "apply", env })); assert.equal(fx.updates.length, 0);
  });
}
test("refuses an occupied state without the exact prior decision audit", async () => {
  const fx = fixture(); fx.mutate({ source: "BOTH", amoLeadId: 32185337n });
  await assert.rejects(run({ prisma: fx.prisma, env: ENV }), { safeCode: "ALREADY_LINKED_WITHOUT_EXPECTED_AUDIT" });
  assert.equal(fx.updates.length, 0);
});
test("does not reuse a plan across a changed source SHA", async () => {
  const fx = fixture(), env = { ...await armed(fx), CONFIRMED_LINK_SOURCE_SHA: "c".repeat(40) };
  await assert.rejects(run({ prisma: fx.prisma, mode: "apply", env }), { safeCode: "PLAN_FINGERPRINT_CHANGED" });
  assert.equal(fx.updates.length, 0);
});
test("refuses database identity mismatch without writes", async () => {
  const fx = fixture(); fx.tx.$queryRaw = async () => [{ name: "not-production", identifier: "123" }];
  await assert.rejects(run({ prisma: fx.prisma, env: ENV }), { safeCode: "DATABASE_IDENTITY_INVALID" });
  assert.equal(fx.updates.length, 0);
});
test("compare-and-swap count zero leaves row and audit unchanged", async () => {
  const fx = fixture(), env = await armed(fx), before = hash(fx.row());
  fx.tx.registryDeal.updateMany = async () => ({ count: 0 });
  await assert.rejects(run({ prisma: fx.prisma, mode: "apply", env }), { safeCode: "COMPARE_AND_SWAP_FAILED" });
  assert.equal(hash(fx.row()), before); assert.equal(fx.audits().length, 0);
});
test("unrequested business writes are rolled back", async () => {
  const fx = fixture(), env = await armed(fx), before = hash(fx.row());
  const original = fx.tx.registryDeal.updateMany;
  fx.tx.registryDeal.updateMany = async args => { const r = await original(args); fx.mutate({ sqm: "999" }); return r; };
  await assert.rejects(run({ prisma: fx.prisma, mode: "apply", env }), { safeCode: "POSTWRITE_INVARIANT_FAILED" });
  assert.equal(hash(fx.row()), before); assert.equal(fx.audits().length, 0);
});
test("workflow requires exact master CI, explicit SHA and production guards without live Git mutations", () => {
  const fs = require("node:fs"), path = require("node:path");
  const workflow = fs.readFileSync(path.join(__dirname, "../.github/workflows/link-confirmed-tour-contract.yml"), "utf8");
  for (const token of ["group: production-deploy", "cancel-in-progress: false", "environment: production", "default: dry-run",
    'test "$EXPECTED_REF" = "refs/heads/master"', 'test "$current_master" = "$EXPECTED_SHA"', 'head_sha="$EXPECTED_SHA"',
    'Build and test release commit', 'backup-production-loyalty-predeploy.yml', '21600', 'StrictHostKeyChecking=yes',
    'test "$container_sha" = "$production_sha"', 'flock -x -n 9', 'actual_script_sha', 'CONFIRMED_LINK_PLAN_SHA256',
    'PRODUCTION_PG_SYSTEM_IDENTIFIER', 'node --test scripts/link-confirmed-tour-contract.test.js']) assert.ok(workflow.includes(token), token);
  assert.ok(!/git (fetch|pull|checkout|reset|clean)|StrictHostKeyChecking=no|appleboy|script_stop|--log\b/.test(workflow));
});

test("apply obtains the table lock before the first data SELECT establishes a serializable snapshot", async () => {
  const fx = fixture(), env = await armed(fx);
  fx.queries.length = 0;
  await run({ prisma: fx.prisma, mode: "apply", env });
  const lock = fx.queries.findIndex(q => q.includes("LOCK TABLE registry_deals"));
  const firstSelect = fx.queries.findIndex(q => q.includes("SELECT"));
  assert.ok(lock >= 0 && firstSelect > lock);
  assert.ok(fx.queries[firstSelect].includes("pg_control_system"));
});
