"use strict";

// One approved case only. Private phones, tokens and raw CRM/DB errors never
// leave memory. This program cannot refresh credentials or repair a record.
const { createHash, randomBytes } = require("node:crypto");
const helpers = typeof FIXED_CASE_RECONCILIATION_HELPERS !== "undefined"
  ? FIXED_CASE_RECONCILIATION_HELPERS
  : require("./inspect-amo-fixation-lead-reconciliation.js");
const CLIENT_ID = "8d082b21-7cba-4778-a6c6-1d80bfe7ed7c";
const EXPECTED_BROKER_ID = "6e414141-f2ca-4c71-8402-2032c9186568";
// AMO_CONTACT_FIELDS.IS_BROKER in the reviewed shared field map; regression
// tests bind this exact checkbox ID, without importing a mutable live module.
const IS_BROKER_FIELD_ID = 835415;
const BROKER_SELECT = {
  id: true, phone: true, amoContactId: true, role: true, status: true, mergedIntoId: true,
  brokerAgencies: { select: { agencyId: true, isPrimary: true }, take: 101 },
};
const CLIENT_SELECT = {
  id: true, brokerId: true, responsibleBrokerId: true, phone: true,
  project: true, fixationAgencyId: true, createdAt: true, updatedAt: true,
  amoLeadId: true, amoCreatedAt: true, amoUpdatedAt: true,
  amoSyncStatus: true, amoSyncAttempts: true, amoSyncLastAttemptAt: true,
  amoSyncError: true, uniquenessStatus: true, uniquenessExpiresAt: true,
  fixationStatus: true, fixationExpiresAt: true, status: true,
  broker: { select: BROKER_SELECT }, responsibleBroker: { select: BROKER_SELECT },
};
const SAFE_VALUES = {
  project: ["ZORGE9", "SILVER_BOR", "TOLBUKHINA", "UNKNOWN"],
  amoSyncStatus: ["PENDING", "FAILED", "SYNCED"],
  uniquenessStatus: ["CONDITIONALLY_UNIQUE", "REJECTED", "UNDER_REVIEW", "EXPIRED"],
  fixationStatus: ["NOT_FIXED", "FIXED", "EXPIRED", "ANNULLED"],
  status: ["NEW", "BOOKED", "DEAL", "CANCELLED"],
  brokerStatus: ["ACTIVE", "BLOCKED", "PENDING"],
};
const NO_WRITE = Object.freeze({
  executablePayload: false, databaseMutationAuthorized: false,
  amoMutationAuthorized: false, retryAuthorized: false,
});

function refused(code) { const error = new Error("Fixed case inspection refused"); error.safeCode = code; throw error; }
function positiveId(value) {
  if (typeof value === "bigint") return value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}
function iso(value, optional = false) {
  if (optional && value === null) return null;
  // Intrinsic Date operations validate the actual Date internal slot and also
  // work for Prisma/test objects created in another JavaScript realm.
  let time, year;
  try { time = Date.prototype.getTime.call(value); year = Date.prototype.getUTCFullYear.call(value); }
  catch { refused("INVALID_CASE_TIMESTAMP"); }
  if (!Number.isFinite(time) || year < 2000 || year > 2100) refused("INVALID_CASE_TIMESTAMP");
  return Date.prototype.toISOString.call(value);
}
function enumValue(key, value) {
  if (!SAFE_VALUES[key].includes(value)) refused("INVALID_CASE_STATE");
  return value;
}
function effectiveBroker(row) {
  if (row.responsibleBrokerId !== null) {
    if (!row.responsibleBroker || row.responsibleBroker.id !== row.responsibleBrokerId) refused("RESPONSIBLE_BROKER_UNRESOLVED");
    return { source: "responsible", broker: row.responsibleBroker };
  }
  if (!row.broker || row.broker.id !== row.brokerId) refused("OWNER_BROKER_UNRESOLVED");
  return { source: "owner_fallback", broker: row.broker };
}
function canInspectEffectiveBroker(row, effective = effectiveBroker(row)) {
  if (effective.broker.role !== "BROKER" || effective.broker.mergedIntoId !== null) return false;
  if (effective.broker.id === EXPECTED_BROKER_ID) return true;
  // The additional read-only scope is the stored responsible relation of this
  // one approved owner's one client, never a guessed/newest duplicate account.
  return row.brokerId === EXPECTED_BROKER_ID && row.broker?.id === EXPECTED_BROKER_ID &&
    row.responsibleBrokerId !== null && effective.source === "responsible";
}
function validateCase(row, allowOwnershipMismatch = false) {
  if (!row || row.id !== CLIENT_ID) refused("FIXED_CLIENT_MISSING");
  const effective = effectiveBroker(row);
  const expectedParticipant = row.brokerId === EXPECTED_BROKER_ID || row.responsibleBrokerId === EXPECTED_BROKER_ID;
  const expectedEffective = effective.broker.id === EXPECTED_BROKER_ID;
  if (!expectedParticipant || (!expectedEffective && !allowOwnershipMismatch)) refused("EXPECTED_BROKER_MISMATCH");
  if (row.brokerId === EXPECTED_BROKER_ID && row.broker?.id !== EXPECTED_BROKER_ID) refused("OWNER_BROKER_UNRESOLVED");
  if (expectedEffective && (effective.broker.role !== "BROKER" || effective.broker.mergedIntoId !== null)) refused("EXPECTED_BROKER_NOT_CANONICAL");
  if (!["BROKER", "MANAGER", "ADMIN"].includes(effective.broker.role)) refused("INVALID_CASE_STATE");
  enumValue("brokerStatus", effective.broker.status);
  const crmReadAllowed = canInspectEffectiveBroker(row, effective);
  if (crmReadAllowed && !helpers.normalizePhone(row.phone)) refused("INVALID_CLIENT_PHONE");
  if (crmReadAllowed && !["ZORGE9", "SILVER_BOR"].includes(row.project)) refused("PROJECT_MAPPING_UNSUPPORTED");
  if (!Number.isSafeInteger(row.amoSyncAttempts) || row.amoSyncAttempts < 0) refused("INVALID_SYNC_ATTEMPTS");
  for (const key of ["project", "amoSyncStatus", "uniquenessStatus", "fixationStatus", "status"]) enumValue(key, row[key]);
  for (const key of ["createdAt", "updatedAt"]) iso(row[key]);
  for (const key of ["amoCreatedAt", "amoUpdatedAt", "amoSyncLastAttemptAt", "uniquenessExpiresAt", "fixationExpiresAt"]) iso(row[key], true);
  helpers.optionalStoredAmoLeadId(row.amoLeadId);
  if (crmReadAllowed && effective.broker.amoContactId !== null && !positiveId(effective.broker.amoContactId)) refused("INVALID_BROKER_CONTACT_ID");
  if (crmReadAllowed && (!Array.isArray(effective.broker.brokerAgencies) || effective.broker.brokerAgencies.length > 100)) refused("AGENCY_SCOPE_TOO_LARGE");
  return effective;
}
function privateFingerprint(row) {
  // Snapshot equality includes all selected values, not only updatedAt. This
  // detects imports/raw SQL that change linkage without updating timestamps.
  return createHash("sha256").update(JSON.stringify(row, (_key, value) => typeof value === "bigint" ? value.toString() : value)).digest("hex");
}
function runtimeMetadata(environment) {
  const metadata = {
    inspectorSha256: environment.FIXED_CASE_INSPECTOR_SHA256,
    dependencySha256: environment.FIXED_CASE_DEPENDENCY_SHA256,
    deployedGitSha: environment.FIXED_CASE_DEPLOYED_GIT_SHA,
  };
  if (!/^[0-9a-f]{64}$/.test(metadata.inspectorSha256 || "") || !/^[0-9a-f]{64}$/.test(metadata.dependencySha256 || "") || !/^[0-9a-f]{40}$/.test(metadata.deployedGitSha || "")) refused("SOURCE_ATTESTATION_INVALID");
  if (!/^[0-9]+$/.test(environment.PRODUCTION_PG_SYSTEM_IDENTIFIER || "") || !/^[1-9][0-9]*$/.test(environment.PRODUCTION_MIN_BROKER_ROWS || "")) refused("DATABASE_ATTESTATION_INVALID");
  const floor = Number(environment.PRODUCTION_MIN_BROKER_ROWS);
  if (!Number.isSafeInteger(floor) || floor <= 0) refused("DATABASE_ATTESTATION_INVALID");
  if (environment.NODE_TLS_REJECT_UNAUTHORIZED === "0") refused("UNSAFE_TLS_CONFIGURATION");
  return metadata;
}
async function snapshot(prisma, environment, includeToken) {
  return prisma.$transaction(async (tx) => {
    await helpers.assertReadOnlySession(tx);
    const identities = await tx.$queryRaw`SELECT current_setting('transaction_read_only') AS read_only, current_database() AS database_name, system_identifier::text AS system_identifier, (SELECT count(*)::text FROM public.brokers) AS broker_rows FROM pg_control_system()`;
    const identity = Array.isArray(identities) && identities.length === 1 ? identities[0] : null;
    if (!identity || identity.read_only !== "on" || identity.database_name !== "broker_platform" || identity.system_identifier !== environment.PRODUCTION_PG_SYSTEM_IDENTIFIER || !/^[0-9]+$/.test(identity.broker_rows || "") || BigInt(identity.broker_rows) < BigInt(environment.PRODUCTION_MIN_BROKER_ROWS)) refused("DATABASE_IDENTITY_MISMATCH");
    const row = await tx.client.findUnique({ where: { id: CLIENT_ID }, select: CLIENT_SELECT });
    const effective = validateCase(row, true);
    const tokenRow = includeToken && canInspectEffectiveBroker(row, effective) ? await tx.systemSetting.findUnique({ where: { key: "AMO_ACCESS_TOKEN" }, select: { value: true } }) : null;
    return { row, token: tokenRow?.value };
  }, { isolationLevel: "RepeatableRead", timeout: 20000, maxWait: 5000 });
}
function buildReport(row, evidence, brokerContact, storedLead, metadata) {
  const effective = validateCase(row, true);
  if (!canInspectEffectiveBroker(row, effective)) refused("EXPECTED_BROKER_NOT_CANONICAL");
  const expectedBrokerMatched = effective.broker.id === EXPECTED_BROKER_ID;
  const brokerContactMatchesCurrentBrokerPhone = Boolean(brokerContact && helpers.normalizePhone(effective.broker.phone) && helpers.contactHasExactPhone(brokerContact, helpers.normalizePhone(effective.broker.phone)));
  const brokerFlag = brokerFlagEvidence(brokerContact);
  const inspected = helpers.inspectQueueRow(row, evidence.byPhone, randomBytes(32));
  const privateRecord = inspected.attestationRecord;
  const candidates = privateRecord.candidates.map((candidate) => ({
    leadId: candidate.leadId, pipelineId: candidate.pipelineId, statusId: candidate.statusId,
    strength: candidate.strength,
    effectiveBrokerAttachment: candidate.brokerAttachment,
    expectedBrokerAttachment: expectedBrokerMatched ? candidate.brokerAttachment : "not_inspected",
    strictBrokerSourceMarker: candidate.sourceMarker, projectEvidence: candidate.projectEvidence,
    leadCreatedAt: safeTimestamp(candidate.createdAt, row.createdAt),
    brokerRequestAt: safeTimestamp(candidate.requestValidValues, row.createdAt),
  }));
  const storedLeadId = helpers.optionalStoredAmoLeadId(row.amoLeadId);
  const exactIds = evidence.byPhone.get(helpers.normalizePhone(row.phone))?.exactContactIds || [];
  const storedDetail = storedLead ? {
    leadId: storedLead.leadId, pipelineId: storedLead.pipelineId, statusId: storedLead.statusId,
    exactClientContactLinked: storedLead.contactIds.some((id) => exactIds.includes(id)),
    effectiveBrokerLinked: positiveId(effective.broker.amoContactId) !== null && storedLead.contactIds.includes(positiveId(effective.broker.amoContactId)),
    expectedBrokerLinked: expectedBrokerMatched ? positiveId(effective.broker.amoContactId) !== null && storedLead.contactIds.includes(positiveId(effective.broker.amoContactId)) : null,
    strictBrokerSourceMarker: storedLead.sourceMarker,
    leadCreatedAt: safeTimestamp(storedLead.createdAt, row.createdAt),
  } : null;
  const resolution = inspected.publicRecord.resolution;
  // Complete bounded evidence permits a narrow absence statement only about
  // contact-linked KC leads. It does not certify absence anywhere in amoCRM.
  const conclusion = storedLeadId !== null ? "stored_link_requires_review"
    : resolution === "single_strong_candidate" ? "unique_strong_candidate_advisory"
    : ["no_exact_client_contact", "no_candidate"].includes(resolution) ? "no_contact_linked_kc_candidate_observed"
    : "ambiguous_or_incomplete_evidence";
  return {
    schemaVersion: 1, scope: "approved_single_client_case", ...metadata,
    expectedBrokerMatched,
    expectedBrokerIsOwner: row.brokerId === EXPECTED_BROKER_ID,
    expectedBrokerIsResponsible: row.responsibleBrokerId === EXPECTED_BROKER_ID,
    mappingSource: effective.source,
    effectiveBrokerRole: effective.broker.role,
    effectiveBrokerStatus: effective.broker.status,
    effectiveBrokerMerged: effective.broker.mergedIntoId !== null,
    effectiveBrokerCanonical: true,
    crmInspectionPerformed: true,
    brokerLinkageReference: "stored_effective_broker_contact",
    brokerStatus: effective.broker.status, brokerContactConfigured: positiveId(effective.broker.amoContactId) !== null,
    brokerContactObserved: brokerContact !== null,
    brokerContactMatchesCurrentBrokerPhone,
    brokerContactHasBrokerFlag: brokerFlag.value === true,
    brokerContactBrokerFlagEvidence: brokerFlag.coverage,
    brokerAgencyCount: effective.broker.brokerAgencies.length,
    fixationAgencyConfigured: row.fixationAgencyId !== null,
    fixationAgencyBelongsToBroker: row.fixationAgencyId !== null && effective.broker.brokerAgencies.some((agency) => agency.agencyId === row.fixationAgencyId),
    database: { ...safeDatabaseState(row), storedLeadObserved: storedLead !== null, storedLeadEvidence: storedDetail },
    evidenceCounts: evidence.stats, exactClientContactCount: exactIds.length,
    strongLeadIds: candidates.filter((candidate) => candidate.strength === "strong").map((candidate) => candidate.leadId),
    linkedLeadCounts: inspected.publicRecord.linkedLeadEvidence,
    resolution, conclusion, candidates, rowUnchangedDuringScan: true,
    advisory: { ...NO_WRITE, candidateLinkEvidenceSufficient: expectedBrokerMatched && conclusion === "unique_strong_candidate_advisory" && brokerContactMatchesCurrentBrokerPhone && brokerFlag.value === true && effective.broker.status === "ACTIVE" && candidates.some((candidate) => candidate.strength === "strong" && candidate.strictBrokerSourceMarker) },
  };
}
function brokerFlagEvidence(contact) {
  if (contact === null) return { coverage: "contact_missing", value: null };
  const fields = contact.custom_fields_values;
  if (fields === null || fields === undefined) return { coverage: "missing", value: null };
  if (!Array.isArray(fields) || fields.length > 1000) return { coverage: "invalid", value: null };
  const flags = fields.filter((field) => field?.field_id === IS_BROKER_FIELD_ID);
  if (flags.length === 0) return { coverage: "missing", value: null };
  if (flags.length !== 1 || !Array.isArray(flags[0].values) || flags[0].values.length !== 1 || typeof flags[0].values[0]?.value !== "boolean") return { coverage: "invalid", value: null };
  return { coverage: "valid", value: flags[0].values[0].value };
}
function safeDatabaseState(row) {
  return {
    project: row.project, status: row.status, amoSyncStatus: row.amoSyncStatus,
    amoSyncAttempts: row.amoSyncAttempts, errorClass: helpers.classifySyncError(row.amoSyncError),
    uniquenessStatus: row.uniquenessStatus, fixationStatus: row.fixationStatus,
    createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt),
    amoCreatedAt: iso(row.amoCreatedAt, true), amoUpdatedAt: iso(row.amoUpdatedAt, true),
    lastAttemptAt: iso(row.amoSyncLastAttemptAt, true),
    uniquenessExpiresAt: iso(row.uniquenessExpiresAt, true), fixationExpiresAt: iso(row.fixationExpiresAt, true),
    storedLeadId: helpers.optionalStoredAmoLeadId(row.amoLeadId),
  };
}
function buildOwnershipReport(row, metadata) {
  const effective = validateCase(row, true);
  if (effective.broker.id === EXPECTED_BROKER_ID) refused("EXPECTED_BROKER_MISMATCH");
  return {
    schemaVersion: 1, scope: "approved_single_client_case", ...metadata,
    expectedBrokerMatched: false,
    expectedBrokerIsOwner: row.brokerId === EXPECTED_BROKER_ID,
    expectedBrokerIsResponsible: row.responsibleBrokerId === EXPECTED_BROKER_ID,
    mappingSource: effective.source,
    effectiveBrokerRole: effective.broker.role,
    effectiveBrokerStatus: effective.broker.status,
    effectiveBrokerMerged: effective.broker.mergedIntoId !== null,
    effectiveBrokerCanonical: effective.broker.role === "BROKER" && effective.broker.mergedIntoId === null,
    crmInspectionPerformed: false, tokenRead: false,
    database: safeDatabaseState(row),
    conclusion: "effective_broker_mismatch_db_only",
    advisory: { ...NO_WRITE, candidateLinkEvidenceSufficient: false },
  };
}
function safeTimestamp(values, reference) {
  const evidence = helpers.unixTimestampEvidence(values, reference);
  return { coverage: evidence.coverage, validValueCount: evidence.validValueCount, relativeToQueue: evidence.relativeToQueue };
}
async function run({ prisma, environment = process.env, fetchImpl } = {}) {
  const metadata = runtimeMetadata(environment);
  const initial = await snapshot(prisma, environment, true);
  if (!canInspectEffectiveBroker(initial.row)) return buildOwnershipReport(initial.row, metadata);
  const token = typeof initial.token === "string" && initial.token.trim() ? initial.token : environment.AMO_ACCESS_TOKEN;
  const request = helpers.createGetOnlyRequester(token, fetchImpl);
  await helpers.assertExpectedAccount(request);
  const effective = validateCase(initial.row, true);
  const brokerContactId = positiveId(effective.broker.amoContactId);
  const brokerContact = brokerContactId ? await request(`/api/v4/contacts/${brokerContactId}`, { with: "leads" }) : null;
  if (brokerContact && brokerContact.id !== brokerContactId) refused("BROKER_CONTACT_ID_MISMATCH");
  const evidence = await helpers.collectAmoEvidence([initial.row], request);
  const storedId = helpers.optionalStoredAmoLeadId(initial.row.amoLeadId);
  const storedRaw = storedId ? await request(`/api/v4/leads/${storedId}`, { with: "contacts" }) : null;
  const storedLead = storedRaw ? helpers.reduceLeadEvidence(storedRaw, storedId) : null;
  const final = await snapshot(prisma, environment, false);
  if (privateFingerprint(initial.row) !== privateFingerprint(final.row)) refused("CASE_CHANGED_DURING_SCAN");
  return buildReport(initial.row, evidence, brokerContact, storedLead, metadata);
}
function failureCode(error) {
  const allowed = ["INVALID_CASE_TIMESTAMP", "INVALID_CASE_STATE", "RESPONSIBLE_BROKER_UNRESOLVED", "OWNER_BROKER_UNRESOLVED", "FIXED_CLIENT_MISSING", "EXPECTED_BROKER_MISMATCH", "EXPECTED_BROKER_NOT_CANONICAL", "INVALID_CLIENT_PHONE", "PROJECT_MAPPING_UNSUPPORTED", "INVALID_SYNC_ATTEMPTS", "INVALID_BROKER_CONTACT_ID", "AGENCY_SCOPE_TOO_LARGE", "SOURCE_ATTESTATION_INVALID", "DATABASE_ATTESTATION_INVALID", "UNSAFE_TLS_CONFIGURATION", "DATABASE_IDENTITY_MISMATCH", "BROKER_CONTACT_ID_MISMATCH", "CASE_CHANGED_DURING_SCAN"];
  try { return allowed.includes(error?.safeCode) ? error.safeCode : helpers.classifyFailure(error); } catch { return "UNKNOWN_FAILURE"; }
}
async function main() {
  if (typeof FIXED_CASE_INSPECTOR_SOURCE_SHA256 === "undefined" || typeof FIXED_CASE_DEPENDENCY_SOURCE_SHA256 === "undefined" || FIXED_CASE_INSPECTOR_SOURCE_SHA256 !== process.env.FIXED_CASE_INSPECTOR_SHA256 || FIXED_CASE_DEPENDENCY_SOURCE_SHA256 !== process.env.FIXED_CASE_DEPENDENCY_SHA256) refused("SOURCE_ATTESTATION_INVALID");
  runtimeMetadata(process.env);
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient({ datasources: { db: { url: helpers.buildReadOnlyDatabaseUrl(process.env.DATABASE_URL) } }, log: [] });
  try { process.stdout.write(`${JSON.stringify(await run({ prisma }), null, 2)}\n`); }
  finally { await prisma.$disconnect(); }
}
module.exports = { CLIENT_ID, EXPECTED_BROKER_ID, IS_BROKER_FIELD_ID, CLIENT_SELECT, validateCase, canInspectEffectiveBroker, brokerFlagEvidence, runtimeMetadata, snapshot, buildReport, buildOwnershipReport, run, failureCode, main };
if (require.main === module) main().catch((error) => { process.stderr.write(`fixed_case_failure_code=${failureCode(error)}\n`); process.exitCode = 1; });
