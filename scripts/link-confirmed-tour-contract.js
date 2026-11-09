"use strict";

const { createHash } = require("node:crypto");
const TARGET = Object.freeze({
  id: "f88e7073-ee5a-4be5-bae2-26d082a71c0b",
  contractNumber: "ЗГ1-23-1-254-290/1",
  amount: "15896311.20", project: "ZORGE9",
  brokerId: "f6cac58c-b16e-4f76-8d29-cebc089bb6d4",
  signedAt: "2026-06-24", paidAt: "2026-06-24",
  leadId: "32185337", source: "REGISTRY",
});
const CONFIRMATION = "LINK_CONFIRMED_32185337_ONLY";
const ACTION = "REGISTRY_DEAL_CONFIRMED_AMO_LINK";
const ENTITY = "RegistryDeal";
const DECISION = "Owner confirmed on 2026-11-09 that the registry contract and amoCRM lead 32185337 are the same contract despite the omitted -1- component in the CRM contract number.";
function refuse(code) { const e = new Error("Confirmed registry link refused"); e.safeCode = code; throw e; }
function stable(value) {
  if (typeof value === "bigint") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    if (typeof value.toJSON === "function") return stable(value.toJSON());
    return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
  }
  return value;
}
function hash(value) { return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex"); }
function cents(value) {
  const s = String(value ?? "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [rub, fractional = ""] = s.split(".");
  return BigInt(rub) * 100n + BigInt(fractional.padEnd(2, "0"));
}
function day(value) { return value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString().slice(0, 10) : null; }
function identity(row) {
  if (!row || row.id !== TARGET.id || row.contractNumber !== TARGET.contractNumber ||
    row.project !== TARGET.project || row.brokerId !== TARGET.brokerId ||
    cents(row.amount) !== cents(TARGET.amount) || day(row.signedAt) !== TARGET.signedAt || day(row.paidAt) !== TARGET.paidAt ||
    row.saleChannel !== "BROKER" || row.brokerAmoContactId !== null) refuse("TARGET_IDENTITY_CHANGED");
  const linked = row.amoLeadId !== null && String(row.amoLeadId) === TARGET.leadId && row.source === "BOTH";
  const unlinked = row.amoLeadId === null && row.source === TARGET.source;
  if (!linked && !unlinked) refuse("TARGET_LINK_STATE_CHANGED");
  return linked;
}
function business(row) {
  const result = { ...row };
  for (const key of ["source", "amoLeadId", "updatedAt"]) delete result[key];
  return result;
}
function gate(mode, env) {
  if (!["dry-run", "apply"].includes(mode)) refuse("MODE_INVALID");
  if (!/^[0-9a-f]{40}$/.test(env.CONFIRMED_LINK_SOURCE_SHA || "") ||
      !/^[0-9a-f]{40}$/.test(env.CONFIRMED_LINK_DEPLOYED_SHA || "") ||
      env.GIT_SHA !== env.CONFIRMED_LINK_DEPLOYED_SHA ||
      !/^[0-9]+$/.test(env.PRODUCTION_PG_SYSTEM_IDENTIFIER || "")) refuse("EXECUTION_BINDING_INVALID");
  if (mode === "apply" && (
    env.CONFIRMED_LINK_CONFIRMATION !== CONFIRMATION || env.CONFIRMED_LINK_CI_ATTESTED !== "true" ||
    !/^[0-9a-f]{64}$/.test(env.CONFIRMED_LINK_PLAN_SHA256 || "") ||
    !/^[1-9][0-9]{5,19}$/.test(env.CONFIRMED_LINK_RUN_ID || "") ||
    env.CONFIRMED_LINK_RUN_ATTEMPT !== "1" || !/^[A-Za-z0-9_-]{1,100}$/.test(env.CONFIRMED_LINK_ACTOR || ""))) refuse("APPLY_NOT_CONFIRMED");
}
async function databaseIdentity(tx, env) {
  const rows = await tx.$queryRaw`SELECT current_database() AS name, system_identifier::text AS identifier FROM pg_control_system()`;
  if (rows?.length !== 1 || rows[0].name !== "broker_platform" || rows[0].identifier !== env.PRODUCTION_PG_SYSTEM_IDENTIFIER) refuse("DATABASE_IDENTITY_INVALID");
}
async function occupancy(tx) {
  const rows = await tx.registryDeal.findMany({ where: { amoLeadId: BigInt(TARGET.leadId), id: { not: TARGET.id } }, select: { id: true }, take: 1 });
  if (rows.length) refuse("AMO_LEAD_ALREADY_OCCUPIED");
}
async function auditRows(tx) {
  return tx.auditLog.findMany({ where: { action: ACTION, entity: ENTITY, entityId: TARGET.id }, select: { payload: true }, take: 2 });
}
function auditValid(rows) {
  return rows.length === 1 && rows[0].payload?.version === 1 && rows[0].payload?.leadId === TARGET.leadId &&
    rows[0].payload?.decision === DECISION && rows[0].payload?.decisionDate === "2026-11-09";
}
async function run({ prisma, mode = "dry-run", env = process.env }) {
  gate(mode, env);
  let committed = false;
  let expectedBusiness;
  try {
    const result = await prisma.$transaction(async tx => {
      if (mode === "dry-run") await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      await tx.$executeRaw`SET LOCAL lock_timeout = '2s'`;
      await tx.$executeRaw`SET LOCAL statement_timeout = '15s'`;
      if (mode === "apply") {
        // Blocks other insert/update writers during the occupancy check, since
        // registry_deals has no unique constraint on amo_lead_id.
        await tx.$executeRaw`LOCK TABLE registry_deals IN SHARE ROW EXCLUSIVE MODE`;
        await databaseIdentity(tx, env);
        const locked = await tx.$queryRaw`SELECT id FROM registry_deals WHERE id = ${TARGET.id} FOR UPDATE`;
        if (locked?.length !== 1 || locked[0].id !== TARGET.id) refuse("TARGET_MISSING");
      }
      if (mode === "dry-run") await databaseIdentity(tx, env);
      const row = await tx.registryDeal.findUnique({ where: { id: TARGET.id } });
      const linked = identity(row);
      await occupancy(tx);
      const audits = await auditRows(tx);
      if (linked && !auditValid(audits)) refuse("ALREADY_LINKED_WITHOUT_EXPECTED_AUDIT");
      if (!linked && audits.length) refuse("PRIOR_AUDIT_STATE_MISMATCH");
      const planSha256 = hash({ version: 1, row, targetLead: TARGET.leadId, decision: DECISION, sourceSha: env.CONFIRMED_LINK_SOURCE_SHA, deployedSha: env.CONFIRMED_LINK_DEPLOYED_SHA });
      const receipt = { mode, status: linked ? "ALREADY_LINKED" : "PLANNED", planSha256,
        changedRows: 0, auditCreated: false, businessFieldsPreserved: true, crmWrites: 0, deletedRows: 0 };
      if (mode === "dry-run" || linked) return receipt;
      if (env.CONFIRMED_LINK_PLAN_SHA256 !== planSha256) refuse("PLAN_FINGERPRINT_CHANGED");
      expectedBusiness = hash(business(row));
      const updated = await tx.registryDeal.updateMany({ where: {
        id: TARGET.id, source: "REGISTRY", amoLeadId: null,
        contractNumber: TARGET.contractNumber, amount: TARGET.amount, project: TARGET.project,
        brokerId: TARGET.brokerId, signedAt: row.signedAt, paidAt: row.paidAt, updatedAt: row.updatedAt,
      }, data: { amoLeadId: BigInt(TARGET.leadId), source: "BOTH" } });
      if (updated.count !== 1) refuse("COMPARE_AND_SWAP_FAILED");
      const after = await tx.registryDeal.findUnique({ where: { id: TARGET.id } });
      if (!identity(after) || hash(business(after)) !== expectedBusiness) refuse("POSTWRITE_INVARIANT_FAILED");
      await tx.auditLog.create({ data: { action: ACTION, entity: ENTITY, entityId: TARGET.id, payload: {
        version: 1, leadId: TARGET.leadId, decision: DECISION, decisionDate: "2026-11-09",
        confirmedBy: "user in current Codex chat", registryContract: TARGET.contractNumber, amoContract: "ЗГ1-23-254-290/1",
        previous: { source: "REGISTRY", amoLeadId: null }, next: { source: "BOTH", amoLeadId: TARGET.leadId },
        sourceSha: env.CONFIRMED_LINK_SOURCE_SHA, deployedSha: env.CONFIRMED_LINK_DEPLOYED_SHA,
        actor: env.CONFIRMED_LINK_ACTOR, runId: env.CONFIRMED_LINK_RUN_ID, planSha256,
        crmWrites: 0, deletedRows: 0,
      } } });
      if (!auditValid(await auditRows(tx))) refuse("AUDIT_READBACK_FAILED");
      return { ...receipt, status: "LINKED", changedRows: 1, auditCreated: true };
    }, { isolationLevel: mode === "apply" ? "Serializable" : "RepeatableRead", maxWait: 2000, timeout: mode === "apply" ? 2000 : 20000 });
    if (mode === "apply") {
      committed = true;
      await prisma.$transaction(async tx => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        await databaseIdentity(tx, env);
        const row = await tx.registryDeal.findUnique({ where: { id: TARGET.id } });
        if (!identity(row) || (expectedBusiness && hash(business(row)) !== expectedBusiness) || !auditValid(await auditRows(tx))) refuse("COMMITTED_READBACK_FAILED");
        await occupancy(tx);
      }, { isolationLevel: "RepeatableRead", maxWait: 5000, timeout: 20000 });
    }
    return { ...result, verified: true };
  } catch (error) {
    if (committed) refuse("COMMITTED_REQUIRES_READBACK_NO_BLIND_RETRY");
    if (error?.safeCode) throw error;
    refuse("DATABASE_OPERATION_FAILED_REVIEW_OUTCOME");
  }
}
async function main() {
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient({ log: [] });
  try { console.log(JSON.stringify(await run({ prisma, mode: process.env.CONFIRMED_LINK_MODE || "dry-run" }))); }
  catch (error) { console.error(JSON.stringify({ status: "REFUSED", code: error?.safeCode || "UNEXPECTED_ERROR" })); process.exitCode = 1; }
  finally { await prisma.$disconnect(); }
}
module.exports = { run, TARGET, CONFIRMATION, ACTION, DECISION, hash, identity };
if (require.main === module) main();