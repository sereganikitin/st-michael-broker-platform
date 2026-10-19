"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const link = require("./link-existing-fixed-amo-case");
const NOW = Date.parse("2026-10-19T16:00:00Z"), CASE = "8d082b21-7cba-4778-a6c6-1d80bfe7ed7c", OWNER = "6e414141-f2ca-4c71-8402-2032c9186568";
const env = { FIXED_CASE_LINK_CONFIRMATION: link.CONFIRM, FIXED_CASE_LINK_CI_ATTESTED: "true", FIXED_CASE_LINK_ACTOR: "mefremov888-ai",
  FIXED_CASE_LINK_RUN_ATTEMPT: "1", FIXED_CASE_DEPLOYED_GIT_SHA: "50c88ff5cef87894394c2d563904e2befafd781a",
  FIXED_CASE_LINK_RUN_ID: "39250000001",
  FIXED_CASE_LINK_SOURCE_SHA: "a".repeat(40), FIXED_CASE_LINK_BACKUP_SOURCE_SHA: "a".repeat(40), FIXED_CASE_LINK_BACKUP_RUN: "39250000000",
  FIXED_CASE_LINK_BACKUP_SHA256: "b".repeat(64), FIXED_CASE_LINK_BACKUP_CREATED_AT: new Date(NOW - 1000).toISOString(), PRODUCTION_PG_SYSTEM_IDENTIFIER: "12345" };
function reports() {
  const db = { amoSyncStatus: "FAILED", storedLeadId: null, amoSyncAttempts: 10, fixationStatus: "NOT_FIXED", uniquenessStatus: "CONDITIONALLY_UNIQUE", status: "NEW", project: "ZORGE9" };
  const p = Object.fromEntries(["auditBindingConfirmed", "exactGeneratedNameMatches", "exactLeadContactsMatch", "pipelineMatches", "createdWithinOriginalArmedWindow", "exactClientPhoneMatches", "exactClientNameMatches", "currentBrokerPhoneMatches", "brokerFlagMatches", "clientNotMarkedBroker", "strictSourceMarkerMatches", "exactProjectMatches", "requestDateOnlyMoscowDayMatchesArmed", "leadUnoccupiedByOtherClient", "clientContactNotBroker", "recoveryNoteMarkersPhoneNameMatch"].map(k => [k, true]));
  return { armed: { scope: "literal_armed_lead_followup_only", leadId: 32377125, stableReadback: true, database: db,
    proof: { ...p, currentStatusId: 142, dateFieldType: "date", recoveryNoteCount: 1, formFields: { expectedFieldCount: 8, priceMatches: true, mismatchedFieldIds: [] } } },
  historical: { scope: "fixed_case_archived_agency_provenance_only", leadId: 32377125, stableReadback: true, backupAuthenticated: true, archiveAgencyRowsRead: 1,
    database: db, proof: { originalCaseHashMatchesArmedPlan: true, historicalAgencyTagExactMatch: true, currentAgencyIdNameInnMatchHistorical: true,
      fullHistoricalNoteExactMatch: false, fullHistoricalNoteWithoutMemoEmojiExactMatch: true } } };
}
test("only complete proof accepts the explicitly approved literal heading variant and later status", () => {
  const r = reports(); assert.doesNotThrow(() => link.assertProof(r.armed, r.historical));
  r.historical.proof.fullHistoricalNoteWithoutMemoEmojiExactMatch = false;
  assert.throws(() => link.assertProof(r.armed, r.historical), /refused/);
});
test("every identity boolean and original case/tag proof remains mandatory", () => {
  for (const key of Object.keys(reports().armed.proof).filter(k => reports().armed.proof[k] === true)) {
    const r = reports(); r.armed.proof[key] = false; assert.throws(() => link.assertProof(r.armed, r.historical));
  }
  for (const key of ["originalCaseHashMatchesArmedPlan", "historicalAgencyTagExactMatch", "currentAgencyIdNameInnMatchHistorical"]) {
    const r = reports(); r.historical.proof[key] = false; assert.throws(() => link.assertProof(r.armed, r.historical));
  }
});
test("form, date, occupancy, business state and full readback cannot be weakened", () => {
  for (const mutate of [r => r.armed.proof.formFields.mismatchedFieldIds.push(833045), r => r.armed.proof.dateFieldType = "date_time",
    r => r.armed.database.fixationStatus = "FIXED", r => r.armed.stableReadback = false, r => r.armed.proof.currentStatusId = null,
    r => r.historical.archiveAgencyRowsRead = 2]) {
    const r = reports(); mutate(r); assert.throws(() => link.assertProof(r.armed, r.historical));
  }
});
test("execution is exact-source, exact-actor, fresh-backup bound", () => {
  assert.doesNotThrow(() => link.gate(env, NOW));
  for (const change of [{ FIXED_CASE_LINK_CONFIRMATION: "other" }, { FIXED_CASE_LINK_ACTOR: "other" },
    { FIXED_CASE_LINK_BACKUP_SOURCE_SHA: "c".repeat(40) }, { FIXED_CASE_LINK_BACKUP_CREATED_AT: new Date(NOW - 21600001).toISOString() }]) {
    assert.throws(() => link.gate({ ...env, ...change }, NOW));
  }
});
function fixture() {
  let current = { id: CASE, brokerId: OWNER, responsibleBrokerId: null, phone: "+79991234567", updatedAt: new Date(NOW - 1000),
    broker: { id: OWNER, role: "BROKER", status: "PENDING", mergedIntoId: null }, responsibleBroker: null,
    amoLeadId: null, amoSyncStatus: "FAILED", amoSyncAttempts: 10, amoSyncError: "private-error", status: "NEW", fixationStatus: "NOT_FIXED", uniquenessStatus: "CONDITIONALLY_UNIQUE" };
  const originalAudit = Array.from({ length: 5 }, (_, i) => ({ id: String(i), payload: { reason: "LEAD_UNCONFIRMED", automaticRetryBlocked: true } }));
  const evidence = { raw: { status_id: 142 }, client: { id: 10 }, brokerContact: { id: 20 }, recoveryAudit: originalAudit };
  const r = reports(); let mutations = 0, audits = 0, writeClients = 0;
  const tx = { $executeRaw: async () => 0, $queryRaw: async (s) => s.join('').includes('pg_control_system') ? [{ name: "broker_platform", identifier: "12345" }] : [{ id: CASE, phone: current.phone }],
    client: { findUnique: async () => current, findMany: async () => [], updateMany: async ({ data }) => { mutations++; current = { ...current, ...data, updatedAt: new Date(NOW) }; return { count: 1 }; } },
    broker: { findMany: async ({ where }) => where.amoContactId === 20n ? [{ id: OWNER }] : [] },
    auditLog: { count: async () => 0, findMany: async () => originalAudit, create: async () => { audits++; } } };
  const read = { ...tx, $transaction: async fn => fn(tx), systemSetting: { findUnique: async () => ({ value: "private-token" }) } };
  const options = { readPrisma: read, createWritePrisma: () => { writeClients++; return { $transaction: async fn => fn(tx), $disconnect: async () => {} }; },
    inspector: { originalWriterClientSelection: () => ({}), runArmedOnly: async () => r.armed, armedPrivateReadback: () => evidence, runHistoricalAgency: async () => r.historical },
    helpers: { assertReadOnlySession: async () => {}, normalizePhone: v => v, contactHasExactPhone: () => true,
      createGetOnlyRequester: () => async path => path === '/api/v4/contacts' ? { _embedded: { contacts: [{ id: 10 }] } } : { status_id: 142 } },
    table: "private-archive", env, now: () => NOW };
  return { options, r, evidence, tx, counts: () => ({ mutations, audits, writeClients }), current: () => current };
}
test("certificate generation has no writer capability and produces no private values", async () => {
  const f = fixture(), result = await link.run({ ...f.options, mode: "certify" });
  assert.deepEqual(f.counts(), { mutations: 0, audits: 0, writeClients: 0 });
  assert.doesNotMatch(JSON.stringify(result), /private|7999/);
});
test("one CAS link preserves status/attempts/business and appends a new honest audit", async () => {
  const f = fixture(), c = await link.run({ ...f.options, mode: "certify" });
  const result = await link.run({ ...f.options, mode: "link", certificate: c.certificate });
  assert.equal(result.report.verified, true); assert.equal(f.current().amoLeadId, 32377125n);
  assert.equal(f.current().fixationStatus, "NOT_FIXED"); assert.equal(f.current().status, "NEW"); assert.equal(f.current().amoSyncAttempts, 10);
  assert.equal(f.evidence.raw.status_id, 142); assert.deepEqual(f.counts(), { mutations: 1, audits: 1, writeClients: 1 });
  assert.doesNotMatch(JSON.stringify(result), /private|7999/);
});
test("changed status and stale/mismatched certificates refuse before creating a write client", async () => {
  for (const mutate of [c => c.certifiedAt = NOW - 1800001, c => c.digest = "e".repeat(64), c => c.statusId = 143]) {
    const f = fixture(), c = await link.run({ ...f.options, mode: "certify" }); mutate(c.certificate);
    await assert.rejects(() => link.run({ ...f.options, mode: "link", certificate: c.certificate }));
    assert.equal(f.counts().writeClients, 0);
  }
});
test("prior armed outcome and other phone rows refuse, never request a retry", async () => {
  const f = fixture(); f.evidence.recoveryAudit[4].payload.reason = "OTHER";
  await assert.rejects(() => link.run({ ...f.options, mode: "certify" })); assert.equal(f.counts().mutations, 0);
  const g = fixture(); g.tx.$queryRaw = async () => [{ id: "other", phone: "+79991234567" }];
  await assert.rejects(() => link.run({ ...g.options, mode: "certify" })); assert.equal(g.counts().mutations, 0);
});
test("new link code has no provider writer or Redis dependency, and cannot rewrite original recovery phases", () => {
  const source = require("node:fs").readFileSync(require.resolve("./link-existing-fixed-amo-case"), "utf8");
  assert.doesNotMatch(source, /require\([^)]*(?:redis|apply-fixed-amo)|method\s*:\s*["'](?:POST|PATCH|DELETE)|auditLog\.(?:update|delete)/i);
  assert.match(source, /amoLeadId: BigInt\(LEAD\), amoSyncStatus: "SYNCED", amoSyncError: null/);
  assert.match(source, /LOCK TABLE clients IN SHARE ROW EXCLUSIVE MODE/);
  assert.match(source, /LINK_ORIGINAL_AUDIT_CHANGED/);
});
