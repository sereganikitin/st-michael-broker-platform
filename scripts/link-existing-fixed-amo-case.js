"use strict";

// A new operation, NOT a resumption of the create writer. Provider capability
// is GET-only. Original five recovery audit phases are never changed/forged.
const { createHash } = require("node:crypto");
const CASE = "8d082b21-7cba-4778-a6c6-1d80bfe7ed7c";
const OWNER = "6e414141-f2ca-4c71-8402-2032c9186568";
const LEAD = 32377125;
const LIVE = "50c88ff5cef87894394c2d563904e2befafd781a";
const CONFIRM = "LINK_ONLY_32377125_PRESERVE_STATUS_ALLOW_ONLY_MISSING_MEMO";
const ENTITY = "AmoFixedCaseExistingLink";
const ACTION = "AMO_EXISTING_FIXED_CASE_LINKED";
function fail(code) { const e = new Error("Existing fixed case link refused"); e.safeCode = code; throw e; }
function hash(value) { return createHash("sha256").update(JSON.stringify(value, (_k, v) => typeof v === "bigint" ? String(v) : v)).digest("hex"); }
function equal(a, b) { return hash(a) === hash(b); }
function gate(env, now) {
  if (env.FIXED_CASE_LINK_CONFIRMATION !== CONFIRM || env.FIXED_CASE_LINK_CI_ATTESTED !== "true" ||
    env.FIXED_CASE_LINK_ACTOR !== "mefremov888-ai" || env.FIXED_CASE_LINK_RUN_ATTEMPT !== "1" ||
    env.FIXED_CASE_DEPLOYED_GIT_SHA !== LIVE || !/^[a-f0-9]{40}$/.test(env.FIXED_CASE_LINK_SOURCE_SHA || "") ||
    !/^[1-9][0-9]{5,19}$/.test(env.FIXED_CASE_LINK_BACKUP_RUN || "") ||
    !/^[a-f0-9]{64}$/.test(env.FIXED_CASE_LINK_BACKUP_SHA256 || "") ||
    env.FIXED_CASE_LINK_BACKUP_SOURCE_SHA !== env.FIXED_CASE_LINK_SOURCE_SHA) fail("LINK_EXECUTION_GATE_INVALID");
  const age = now - Date.parse(env.FIXED_CASE_LINK_BACKUP_CREATED_AT);
  if (!Number.isFinite(age) || age < 0 || age > 6 * 3600000) fail("LINK_BACKUP_STALE");
  return { sourceSha: env.FIXED_CASE_LINK_SOURCE_SHA, liveSha: LIVE,
    backupRun: env.FIXED_CASE_LINK_BACKUP_RUN, backupSha256: env.FIXED_CASE_LINK_BACKUP_SHA256 };
}
function assertProof(armed, historical) {
  if (armed?.scope !== "literal_armed_lead_followup_only" || historical?.scope !== "fixed_case_archived_agency_provenance_only" ||
    armed.leadId !== LEAD || historical.leadId !== LEAD || armed.stableReadback !== true || historical.stableReadback !== true ||
    historical.backupAuthenticated !== true || historical.archiveAgencyRowsRead !== 1) fail("LINK_READBACK_INVALID");
  const keys = ["auditBindingConfirmed", "exactGeneratedNameMatches", "exactLeadContactsMatch", "pipelineMatches",
    "createdWithinOriginalArmedWindow", "exactClientPhoneMatches", "exactClientNameMatches", "currentBrokerPhoneMatches",
    "brokerFlagMatches", "clientNotMarkedBroker", "strictSourceMarkerMatches", "exactProjectMatches",
    "requestDateOnlyMoscowDayMatchesArmed", "leadUnoccupiedByOtherClient", "clientContactNotBroker", "recoveryNoteMarkersPhoneNameMatch"];
  if (keys.some(key => armed.proof?.[key] !== true) || !Number.isSafeInteger(armed.proof.currentStatusId) || armed.proof.currentStatusId <= 0 ||
    armed.proof.dateFieldType !== "date" || armed.proof.recoveryNoteCount !== 1 ||
    armed.proof.formFields?.expectedFieldCount !== 8 || armed.proof.formFields?.priceMatches !== true ||
    !Array.isArray(armed.proof.formFields?.mismatchedFieldIds) || armed.proof.formFields.mismatchedFieldIds.length !== 0) fail("LINK_IDENTITY_PROOF_INCOMPLETE");
  const h = historical.proof;
  if (h?.originalCaseHashMatchesArmedPlan !== true || h.historicalAgencyTagExactMatch !== true ||
    h.currentAgencyIdNameInnMatchHistorical !== true ||
    !(h.fullHistoricalNoteExactMatch === true || h.fullHistoricalNoteWithoutMemoEmojiExactMatch === true)) fail("LINK_HISTORICAL_PROOF_INCOMPLETE");
  const db = armed.database;
  if (db?.amoSyncStatus !== "FAILED" || db.storedLeadId !== null || db.amoSyncAttempts !== 10 ||
    db.fixationStatus !== "NOT_FIXED" || db.uniquenessStatus !== "CONDITIONALLY_UNIQUE" || db.status !== "NEW" ||
    db.project !== "ZORGE9" || !equal(db, historical.database)) fail("LINK_CASE_STATE_CHANGED");
}
async function readFull(prisma, inspector, helpers) {
  return prisma.$transaction(async tx => {
    await helpers.assertReadOnlySession(tx);
    return tx.client.findUnique({ where: { id: CASE }, select: inspector.originalWriterClientSelection() });
  }, { isolationLevel: "RepeatableRead", timeout: 20000, maxWait: 5000 });
}
async function localUniqueness(tx, row, evidence, helpers) {
  const phone = helpers.normalizePhone(row.phone), broker = row.responsibleBrokerId === null ? row.broker : row.responsibleBroker;
  if (!phone || row.id !== CASE || row.brokerId !== OWNER || row.broker?.id !== OWNER ||
    !broker || broker.role !== "BROKER" || broker.mergedIntoId !== null || !["ACTIVE", "PENDING"].includes(broker.status) ||
    broker.id !== (row.responsibleBrokerId || row.brokerId)) fail("LINK_CASE_SCOPE_INVALID");
  const digits = phone.slice(1), aliases = [digits, `8${digits.slice(1)}`, digits.slice(1), `7${digits}`];
  const matches = await tx.$queryRaw`SELECT id, phone FROM public.clients WHERE regexp_replace(phone, '[^0-9]', '', 'g') = ANY(${aliases}::text[]) LIMIT 101`;
  if (!Array.isArray(matches) || matches.length !== 1 || matches[0].id !== CASE || helpers.normalizePhone(matches[0].phone) !== phone) fail("LINK_OTHER_PHONE_CASE_PRESENT");
  const occupied = await tx.client.findMany({ where: { amoLeadId: BigInt(LEAD), id: { not: CASE } }, select: { id: true }, take: 2 });
  const roles = await tx.broker.findMany({ where: { amoContactId: BigInt(evidence.client.id) }, select: { id: true }, take: 2 });
  const brokerRows = await tx.broker.findMany({ where: { amoContactId: BigInt(evidence.brokerContact.id) }, select: { id: true }, take: 3 });
  if (occupied.length || roles.length || brokerRows.length !== 1 || brokerRows[0].id !== broker.id) fail("LINK_OCCUPANCY_OR_ROLE_COLLISION");
}
async function collect({ readPrisma, inspector, helpers, table, env, now, fetchImpl }) {
  const started = now(), full = await readFull(readPrisma, inspector, helpers);
  const armed = await inspector.runArmedOnly({ prisma: readPrisma, environment: env, fetchImpl });
  const evidence = inspector.armedPrivateReadback(armed);
  if (evidence.recoveryAudit?.length !== 5 || evidence.recoveryAudit[4].payload.reason !== "LEAD_UNCONFIRMED" ||
    evidence.recoveryAudit[4].payload.automaticRetryBlocked !== true) fail("LINK_ORIGINAL_ARMED_OUTCOME_INVALID");
  const historical = await inspector.runHistoricalAgency({ prisma: readPrisma, table, environment: env, fetchImpl });
  assertProof(armed, historical);
  const tokenRow = await readPrisma.systemSetting.findUnique({ where: { key: "AMO_ACCESS_TOKEN" }, select: { value: true } });
  const request = helpers.createGetOnlyRequester(tokenRow?.value, fetchImpl);
  const search = async () => {
    const payload = await request("/api/v4/contacts", { query: helpers.normalizePhone(full.phone).slice(-10), limit: 250, page: 1 });
    const contacts = payload?._embedded?.contacts;
    if (!Array.isArray(contacts) || contacts.length >= 250 || payload?._links?.next) fail("LINK_PHONE_SEARCH_INCOMPLETE");
    const exact = contacts.filter(c => helpers.contactHasExactPhone(c, helpers.normalizePhone(full.phone)));
    if (exact.length !== 1 || exact[0].id !== evidence.client.id) fail("LINK_PHONE_CONTACT_AMBIGUOUS");
    return payload;
  };
  const searchFirst = await search();
  await readPrisma.$transaction(async tx => { await helpers.assertReadOnlySession(tx); await localUniqueness(tx, full, evidence, helpers); },
    { isolationLevel: "RepeatableRead", timeout: 20000, maxWait: 5000 });
  const after = await readFull(readPrisma, inspector, helpers), searchAfter = await search();
  const armedAfter = await inspector.runArmedOnly({ prisma: readPrisma, environment: env, fetchImpl });
  const evidenceAfter = inspector.armedPrivateReadback(armedAfter);
  assertProof(armedAfter, historical);
  if (!equal(full, after) || !equal(evidence, evidenceAfter) || !equal(searchFirst, searchAfter) || now() - started > 60000) fail("LINK_FRESH_EVIDENCE_DRIFT");
  return { full, evidence, statusId: armed.proof.currentStatusId,
    digest: hash({ full, evidence, search: searchFirst, historicalProof: historical.proof }) };
}
function validateCertificate(cert, binding, now) {
  if (!cert || Object.keys(cert).sort().join() !== "binding,caseId,certifiedAt,digest,leadId,statusId,version" ||
    cert.version !== 1 || cert.caseId !== CASE || cert.leadId !== LEAD || !equal(cert.binding, binding) ||
    !/^[a-f0-9]{64}$/.test(cert.digest || "") || !Number.isSafeInteger(cert.statusId) ||
    !Number.isSafeInteger(cert.certifiedAt) || cert.certifiedAt > now || now - cert.certifiedAt > 1800000) fail("LINK_CERTIFICATE_INVALID_OR_STALE");
}
async function run({ mode, readPrisma, createWritePrisma, inspector, helpers, table, env, certificate, now = Date.now, fetchImpl }) {
  const binding = gate(env, now());
  if (!["certify", "link"].includes(mode)) fail("LINK_MODE_INVALID");
  if (mode === "link") validateCertificate(certificate, binding, now());
  const proof = await collect({ readPrisma, inspector, helpers, table, env, now, fetchImpl });
  if (mode === "certify") {
    const cert = { version: 1, caseId: CASE, leadId: LEAD, binding, certifiedAt: now(), digest: proof.digest, statusId: proof.statusId };
    return { certificate: cert, report: { certified: true, certificateSha256: hash(cert), validForMinutes: 30,
      leadId: LEAD, currentCrmStatusPreserved: true, databaseWrites: false, crmWrites: false } };
  }
  if (certificate.digest !== proof.digest || certificate.statusId !== proof.statusId) fail("LINK_CERTIFICATE_READBACK_MISMATCH");
  const write = createWritePrisma(); let committed = false;
  try {
    await write.$transaction(async tx => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '2s'`;
      await tx.$executeRaw`SET LOCAL statement_timeout = '15s'`;
      await tx.$executeRaw`LOCK TABLE clients IN SHARE ROW EXCLUSIVE MODE`;
      await tx.$executeRaw`LOCK TABLE brokers, agencies, broker_agencies, audit_logs IN SHARE MODE`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"fixed-existing-amo-link:v1:" + CASE}, 0))`;
      const identity = await tx.$queryRaw`SELECT current_database() AS name, system_identifier::text AS identifier FROM pg_control_system()`;
      if (identity?.length !== 1 || identity[0].name !== "broker_platform" || identity[0].identifier !== env.PRODUCTION_PG_SYSTEM_IDENTIFIER) fail("LINK_DATABASE_IDENTITY_INVALID");
      const current = await tx.client.findUnique({ where: { id: CASE }, select: inspector.originalWriterClientSelection() });
      if (!equal(current, proof.full)) fail("LINK_LOCKED_CASE_DRIFT");
      const allRecovery = await tx.auditLog.findMany({ where: { entity: "AmoFixedCaseRecovery", entityId: CASE },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 17,
        select: { id: true, entity: true, entityId: true, action: true, createdAt: true, payload: true } });
      if (!equal(allRecovery, proof.evidence.recoveryAudit)) fail("LINK_ORIGINAL_AUDIT_CHANGED");
      await localUniqueness(tx, current, proof.evidence, helpers);
      if (await tx.auditLog.count({ where: { entity: ENTITY, entityId: CASE } })) fail("LINK_PRIOR_COMPLETION_REQUIRES_READBACK");
      // All provider calls below are GET; never invoke the original writer.
      const final = await collect({ readPrisma, inspector, helpers, table, env, now, fetchImpl });
      validateCertificate(certificate, binding, now()); gate(env, now());
      if (final.digest !== certificate.digest || final.statusId !== certificate.statusId) fail("LINK_FINAL_EVIDENCE_DRIFT");
      const result = await tx.client.updateMany({ where: { id: CASE, brokerId: OWNER, updatedAt: current.updatedAt,
        amoLeadId: null, amoSyncStatus: "FAILED", amoSyncAttempts: 10, amoSyncError: current.amoSyncError,
        fixationStatus: "NOT_FIXED", status: "NEW", uniquenessStatus: "CONDITIONALLY_UNIQUE" },
      data: { amoLeadId: BigInt(LEAD), amoSyncStatus: "SYNCED", amoSyncError: null, amoSyncLastAttemptAt: new Date(now()) } });
      if (result.count !== 1) fail("LINK_CAS_NOT_ONE");
      const updated = await tx.client.findUnique({ where: { id: CASE }, select: inspector.originalWriterClientSelection() });
      const business = row => { const v = { ...row }; for (const k of ["amoLeadId", "amoSyncStatus", "amoSyncError", "amoSyncLastAttemptAt", "updatedAt"]) delete v[k]; return v; };
      if (!equal(business(updated), business(current)) || updated.amoLeadId !== BigInt(LEAD) || updated.amoSyncStatus !== "SYNCED" || updated.amoSyncError !== null) fail("LINK_POSTWRITE_INVARIANT_FAILED");
      await tx.auditLog.create({ data: { action: ACTION, entity: ENTITY, entityId: CASE, payload: {
        source: "fixed-existing-amo-link-v1", originalApplyRun: "38252692034", originalPlanRun: "38252028798",
        ...binding, certificateSha256: hash(certificate), leadId: LEAD, preservedCrmStatusId: certificate.statusId,
        approvedMissingMemoOnly: true, providerWrites: 0, originalRecoveryAuditUnchanged: true,
      } } });
    }, { isolationLevel: "Serializable", maxWait: 5000, timeout: 120000 });
    committed = true;
    const row = await readFull(readPrisma, inspector, helpers);
    const token = await readPrisma.systemSetting.findUnique({ where: { key: "AMO_ACCESS_TOKEN" }, select: { value: true } });
    const raw = await helpers.createGetOnlyRequester(token?.value, fetchImpl)(`/api/v4/leads/${LEAD}`, { with: "contacts" });
    if (row.amoLeadId !== BigInt(LEAD) || row.amoSyncStatus !== "SYNCED" || row.amoSyncError !== null || raw.status_id !== certificate.statusId ||
      row.fixationStatus !== "NOT_FIXED" || row.amoSyncAttempts !== 10) fail("LINK_COMMITTED_VERIFICATION_UNCONFIRMED");
    return { report: { linked: true, verified: true, leadId: LEAD, amoSyncStatus: "SYNCED", errorCleared: true,
      crmStatusPreserved: true, businessStatePreserved: true, originalRecoveryAuditPreserved: true,
      createdContacts: 0, createdLeads: 0, crmWrites: 0, redisWrites: 0 } };
  } catch (e) {
    if (committed) fail("LINK_COMMITTED_REQUIRES_READBACK_NO_RETRY");
    if (!/^LINK_[A-Z_]{1,80}$/.test(e?.safeCode || "")) fail("LINK_WRITE_OUTCOME_UNCERTAIN_NO_RETRY");
    throw e;
  }
  finally { await write.$disconnect(); }
}
module.exports = { run, assertProof, gate, hash, validateCertificate, CONFIRM };
