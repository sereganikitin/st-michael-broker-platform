#!/usr/bin/env node
"use strict";

// Explicitly authorized synthetic test only. One mail submission, no retry,
// password reset, token, account/DB access, custom text, or recovery link.
const TIMEOUT_MS = 15000;
const SUBJECT = "TEST SMTP — ST Michael";
const BODY = "Это одноразовое тестовое письмо ST Michael для проверки доставки. Пароль не изменён. Это не восстановление доступа: ссылки и кода в письме нет. Никаких действий выполнять не нужно.";
const EMAIL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._%+\-]{0,63}@[A-Za-z0-9](?:[A-Za-z0-9\-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9\-]{0,61}[A-Za-z0-9])?)+$/;
const SAFE_CODES = new Set(["EAUTH", "EDNS", "ECONNECTION", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT",
  "ETIMEOUT", "ESOCKET", "ETLS", "EPROTOCOL", "ENOTFOUND", "EAI_AGAIN", "EENVELOPE", "EMESSAGE",
  "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_TLS_CERT_ALTNAME_INVALID"]);

function validateInput(env) {
  if (env.CONFIRM_TEST_EMAIL !== "true") throw new Error("CONFIRMATION_REQUIRED");
  const email = env.EMAIL;
  if (typeof email !== "string" || email.length > 254 || !EMAIL_PATTERN.test(email))
    throw new Error("INPUT_INVALID");
  const port = Number(env.SMTP_PORT || 465);
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS ||
      !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("CONFIG_INCOMPLETE");
  return { email, port };
}

function loadDependencies() {
  const nodemailer = require("nodemailer");
  return { createTransport: (options) => nodemailer.createTransport(options) };
}

function failureProjection(error, sendInvoked) {
  const code = typeof error?.code === "string" && SAFE_CODES.has(error.code) ? error.code : null;
  const responseCode = Number.isInteger(error?.responseCode) && error.responseCode >= 100 && error.responseCode <= 599
    ? error.responseCode : null;
  const category = code === "EAUTH" ? "AUTH" :
    ["EDNS", "ENOTFOUND", "EAI_AGAIN"].includes(code) ? "DNS" :
    ["ETLS", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_TLS_CERT_ALTNAME_INVALID"].includes(code) ? "TLS" :
    ["ETIMEDOUT", "ETIMEOUT"].includes(code) ? "TIMEOUT" :
    code === "EENVELOPE" ? "ENVELOPE_REJECTED" : code === "EMESSAGE" ? "MESSAGE_REJECTED" : "TRANSPORT_OR_UNKNOWN";
  // Only definite pre-auth or provider rejections can rule out acceptance.
  // A timeout/disconnect may occur AFTER DATA acceptance: never retry it.
  const definiteRejection = ["AUTH", "DNS", "TLS"].includes(category) ||
    (["ENVELOPE_REJECTED", "MESSAGE_REJECTED"].includes(category) && responseCode !== null && responseCode >= 400);
  return { failureTag: category, code, responseCode, ambiguousOutcome: sendInvoked && !definiteRejection };
}

function countProjection(values) {
  return Array.isArray(values) && values.length <= 1 ? values.length : null;
}

async function run(env = process.env, load = loadDependencies, emit = (value) => console.log(JSON.stringify(value))) {
  let transport;
  let sendInvoked = false;
  try {
    const { email, port } = validateInput(env); // Before SMTP initialization.
    const { createTransport } = load();
    transport = createTransport({ host: env.SMTP_HOST, port, secure: env.SMTP_SECURE !== "false",
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
      tls: { rejectUnauthorized: true }, requireTLS: true, logger: false, debug: false, pool: false,
      connectionTimeout: TIMEOUT_MS, greetingTimeout: TIMEOUT_MS, socketTimeout: TIMEOUT_MS });
    sendInvoked = true;
    const result = await transport.sendMail({ from: env.SMTP_FROM || env.SMTP_USER,
      to: email, subject: SUBJECT, text: BODY }); // Exactly one submission; no verify.
    const acceptedCount = countProjection(result?.accepted);
    const rejectedCount = countProjection(result?.rejected);
    const providerAccepted = acceptedCount === 1 && rejectedCount === 0;
    const report = { syntheticTest: true, resetRequested: false, accountChanged: false,
      sendAttempts: 1, automaticRetry: false, diagnosticCertificateVerificationEnabled: true,
      diagnosticRequireTls: true, mailboxDeliveryVerified: false,
      ok: providerAccepted, providerAccepted, acceptedCount, rejectedCount,
      ambiguousOutcome: !providerAccepted && !(acceptedCount === 0 && rejectedCount === 1) };
    emit(report);
    return report;
  } catch (error) {
    const validationCodes = ["CONFIRMATION_REQUIRED", "INPUT_INVALID", "CONFIG_INCOMPLETE"];
    const report = { syntheticTest: true, resetRequested: false, accountChanged: false,
      sendAttempts: sendInvoked ? 1 : 0, automaticRetry: false, mailboxDeliveryVerified: false,
      ok: false, providerAccepted: false,
      ...(validationCodes.includes(error?.message)
        ? { failureTag: error.message, code: null, responseCode: null, ambiguousOutcome: false }
        : failureProjection(error, sendInvoked)) };
    emit(report);
    return report;
  } finally {
    try { transport?.close(); } catch { /* No private exception text is emitted. */ }
  }
}

module.exports = { run, validateInput, failureProjection, SUBJECT, BODY };
if (require.main === module) {
  run().then((report) => { if (!report.ok) process.exitCode = 1; }).catch(() => {
    console.error("Synthetic SMTP test failed; do not retry automatically.");
    process.exitCode = 1;
  });
}
