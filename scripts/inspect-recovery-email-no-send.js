#!/usr/bin/env node
"use strict";

// Administrative diagnosis only. No reset requests/tokens, DB writes, or mail
// submission. SMTP verify establishes a connection/authentication, NOT delivery.
const TIMEOUT_MS = 15000;
const CANONICAL_ORIGIN = "https://broker.stmichael.ru";
const OBSOLETE_MAILBOX = "info@zorge9.com";
const EMAIL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._%+\-]{0,63}@[A-Za-z0-9](?:[A-Za-z0-9\-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9\-]{0,61}[A-Za-z0-9])?)+$/;
const SAFE_CODES = new Set([
  "EAUTH", "EDNS", "ECONNECTION", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT",
  "ETIMEOUT", "ESOCKET", "ETLS", "EPROTOCOL", "ENOTFOUND", "EAI_AGAIN",
  "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_TLS_CERT_ALTNAME_INVALID",
]);

function validateEmail(env) {
  const email = env.EMAIL;
  if (typeof email !== "string" || email.length > 254 || !EMAIL_PATTERN.test(email))
    throw new Error("INPUT_INVALID");
  return email;
}

function buildReadOnlyDatabaseUrl(databaseUrl) {
  let parsed;
  try { parsed = new URL(databaseUrl); } catch { throw new Error("DATABASE_CONFIG_INVALID"); }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol))
    throw new Error("DATABASE_CONFIG_INVALID");
  const previous = parsed.searchParams.getAll("options").filter(Boolean);
  parsed.searchParams.delete("options");
  parsed.searchParams.set("options", [...previous,
    "-c default_transaction_read_only=on", "-c statement_timeout=15000",
  ].join(" "));
  return parsed.toString();
}

function loadDependencies(env) {
  const { PrismaClient } = require("@st-michael/database");
  const nodemailer = require("nodemailer");
  return {
    prisma: new PrismaClient({ datasources: { db: { url: buildReadOnlyDatabaseUrl(env.DATABASE_URL) } } }),
    createTransport: (options) => nodemailer.createTransport(options),
  };
}

async function readAccountFacts(prisma, email) {
  // Verify and query on the SAME transaction/session; a pool-level preliminary
  // check alone would not attest the subsequent connection's read-only setting.
  return prisma.$transaction(async (tx) => {
    const session = await tx.$queryRaw`SELECT current_setting('transaction_read_only') AS mode`;
    if (!Array.isArray(session) || session.length !== 1 || session[0]?.mode !== "on")
      throw new Error("DATABASE_NOT_READ_ONLY");
    const rows = await tx.$queryRaw`
      SELECT CASE WHEN email = ${email} THEN 'exact'
                  WHEN lower(email) = lower(${email}) THEN 'case_only'
                  ELSE 'stored_whitespace' END AS "matchKind",
             role::text AS role, status::text AS status,
             password_hash IS NOT NULL AS "hasPassword",
             merged_into_id IS NOT NULL AS merged,
             password_reset_expires_at IS NOT NULL AS "resetExpiryPresent",
             (password_reset_expires_at IS NOT NULL AND password_reset_expires_at <= CURRENT_TIMESTAMP) AS "resetExpired",
             COUNT(*)::int AS count
      FROM brokers WHERE lower(btrim(email)) = lower(${email})
      GROUP BY 1, 2, 3, 4, 5, 6, 7
      ORDER BY 1, 2, 3, 4, 5, 6, 7 LIMIT 513`;
    if (!Array.isArray(rows) || rows.length > 512) throw new Error("DATABASE_RESULT_INVALID");
    const groups = rows.map((row) => {
      if (!["exact", "case_only", "stored_whitespace"].includes(row?.matchKind) ||
          !["BROKER", "MANAGER", "ADMIN"].includes(row?.role) ||
          !["ACTIVE", "PENDING", "BLOCKED"].includes(row?.status) ||
          !["hasPassword", "merged", "resetExpiryPresent", "resetExpired"].every((key) => typeof row[key] === "boolean") ||
          !Number.isInteger(row.count) || row.count < 1 || row.count > 1000000)
        throw new Error("DATABASE_RESULT_INVALID");
      // Whitelist every emitted field; never spread rows from the database.
      return { matchKind: row.matchKind, role: row.role, status: row.status,
        hasPassword: row.hasPassword, merged: row.merged,
        resetExpiryPresent: row.resetExpiryPresent, resetExpired: row.resetExpired,
        count: row.count };
    });
    const count = (predicate) => groups.filter(predicate).reduce((sum, row) => sum + row.count, 0);
    const eligible = (row) => row.matchKind === "exact" && row.status === "ACTIVE" && row.hasPassword;
    return { matchingAccountCount: count(() => true), exactMatchCount: count((row) => row.matchKind === "exact"),
      caseOnlyMatchCount: count((row) => row.matchKind === "case_only"),
      storedWhitespaceMatchCount: count((row) => row.matchKind === "stored_whitespace"),
      currentlyEligibleCount: count(eligible),
      eligibleStaffCount: count((row) => eligible(row) && row.role !== "BROKER"),
      eligibleMergedCount: count((row) => eligible(row) && row.merged),
      sharedEligibleEmail: count(eligible) > 1, groups };
  }, { maxWait: TIMEOUT_MS, timeout: TIMEOUT_MS });
}

function configFacts(env) {
  const configured = (key) => Boolean(env[key]);
  const stale = (key) => String(env[key] || "").toLowerCase().includes(OBSOLETE_MAILBOX);
  let canonicalOrigin = false;
  try {
    const origin = new URL(env.WEB_URL);
    canonicalOrigin = origin.origin === CANONICAL_ORIGIN && origin.pathname === "/" &&
      !origin.username && !origin.password && !origin.search && !origin.hash;
  } catch { /* No raw URL or parser errors are emitted. */ }
  const port = Number(env.SMTP_PORT || 465);
  return {
    hostConfigured: configured("SMTP_HOST"), userConfigured: configured("SMTP_USER"),
    passwordConfigured: configured("SMTP_PASS"), fromConfigured: configured("SMTP_FROM"),
    effectiveFromConfigured: configured("SMTP_FROM") || configured("SMTP_USER"),
    port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null,
    implicitTls: env.SMTP_SECURE !== "false",
    // Report the existing production policy separately; the diagnostic never
    // authenticates an unverified peer or falls back to plaintext SMTP.
    productionCertificateVerificationEnabled: false, productionRequireTlsConfigured: false,
    diagnosticCertificateVerificationEnabled: true, diagnosticRequireTls: true,
    strictPolicyDifferentFromProduction: true,
    smtpFromObsoleteMailbox: stale("SMTP_FROM"), smtpUserObsoleteMailbox: stale("SMTP_USER"),
    effectiveFromObsoleteMailbox: String(env.SMTP_FROM || env.SMTP_USER || "").toLowerCase().includes(OBSOLETE_MAILBOX),
    sendgridApiKeyConfigured: configured("SENDGRID_API_KEY"), sendgridFromConfigured: configured("SENDGRID_FROM"),
    sendgridFromObsoleteMailbox: stale("SENDGRID_FROM"), vapidSubjectObsoleteMailbox: stale("VAPID_SUBJECT"),
    webUrlConfigured: configured("WEB_URL"), webUrlCanonicalOrigin: canonicalOrigin,
    nodeEnvProduction: env.NODE_ENV === "production",
  };
}

function smtpFailure(error) {
  const code = typeof error?.code === "string" && SAFE_CODES.has(error.code) ? error.code : null;
  const responseCode = Number.isInteger(error?.responseCode) && error.responseCode >= 100 && error.responseCode <= 599
    ? error.responseCode : null;
  const category = code === "EAUTH" ? "AUTH" :
    ["EDNS", "ENOTFOUND", "EAI_AGAIN"].includes(code) ? "DNS" :
    ["ETLS", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_TLS_CERT_ALTNAME_INVALID"].includes(code) ? "TLS" :
    ["ETIMEDOUT", "ETIMEOUT"].includes(code) ? "TIMEOUT" :
    code ? "CONNECTION_OR_PROTOCOL" : "VERIFY_FAILED";
  return { ok: false, failureTag: category, code, responseCode };
}

async function inspectSmtp(env, createTransport, facts) {
  if (!facts.hostConfigured || !facts.userConfigured || !facts.passwordConfigured || facts.port === null)
    return { attempted: false, attempts: 0, ok: false, failureTag: "CONFIG_INCOMPLETE" };
  let transport;
  try {
    transport = createTransport({ host: env.SMTP_HOST, port: facts.port, secure: facts.implicitTls,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS }, tls: { rejectUnauthorized: true }, requireTLS: true,
      logger: false, debug: false, pool: false,
      connectionTimeout: TIMEOUT_MS, greetingTimeout: TIMEOUT_MS, socketTimeout: TIMEOUT_MS });
    const verified = await transport.verify(); // No MAIL FROM / RCPT TO / DATA.
    return { attempted: true, attempts: 1, ok: verified === true,
      ...(verified === true ? {} : { failureTag: "VERIFY_FAILED", code: null, responseCode: null }) };
  } catch (error) {
    return { attempted: true, attempts: 1, ...smtpFailure(error) };
  } finally {
    try { transport?.close(); } catch { /* No private exception text. */ }
  }
}

async function run(env = process.env, load = loadDependencies, emit = (value) => console.log(JSON.stringify(value))) {
  let prisma;
  try {
    const email = validateEmail(env); // Before DB/SMTP initialization; never emitted.
    const dependencies = load(env);
    prisma = dependencies.prisma;
    const accounts = await readAccountFacts(prisma, email);
    const config = configFacts(env);
    const smtp = await inspectSmtp(env, dependencies.createTransport, config);
    const report = { readOnly: true, databaseSessionReadOnly: true, emailSent: false,
      resetRequested: false, automaticRetry: false, deliveryVerified: false,
      inputHadUppercase: email !== email.toLowerCase(), accounts, config, smtp };
    emit(report);
    return report;
  } catch (error) {
    const allowed = ["INPUT_INVALID", "DATABASE_CONFIG_INVALID", "DATABASE_NOT_READ_ONLY", "DATABASE_RESULT_INVALID"];
    emit({ readOnly: true, emailSent: false, resetRequested: false, diagnosticFailed: true,
      failureTag: allowed.includes(error?.message) ? error.message : "DIAGNOSTIC_FAILED" });
    throw new Error("RECOVERY_EMAIL_DIAGNOSTIC_FAILED"); // Never expose dependency error objects.
  } finally {
    try { await prisma?.$disconnect(); } catch { /* Never print raw DB errors. */ }
  }
}

module.exports = { run, validateEmail, buildReadOnlyDatabaseUrl, configFacts, smtpFailure };
if (require.main === module) {
  run().catch(() => {
    console.error("Read-only recovery-email diagnostic failed; no email sent or account changed.");
    process.exitCode = 1;
  });
}
