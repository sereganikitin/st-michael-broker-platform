#!/usr/bin/env node
"use strict";

// One fixed identity only. get=1 and immutable cost=1 never send a message.
// Only SMSC_SENDER may change; SMS flags, OTPs, users and journals are untouched.
const SENDER = "ST MICHAEL";
const TEST_TEXT = "Тест СМС: 000000. Код недействителен для входа и смены пароля.";
const FLAG_KEYS = ["SMS_ENABLED", "SMS_OTP_LOGIN", "SMS_OTP_REGISTER", "SMS_OTP_PASSWORD_RESET", "SMS_FIXATION_EXPIRY"];
const SETTING_KEYS = ["SMSC_LOGIN", "SMSC_API_KEY", "SMSC_SENDER", ...FLAG_KEYS];
const SAFE_FAILURES = new Set(["CONFIG_MISSING", "SETTINGS_INVALID", "SENDER_CONFLICT", "SMS_FLAGS_ENABLED", "SMS_FLAGS_INVALID", "DATABASE_IDENTITY_INVALID", "SENDER_NOT_EXACTLY_APPROVED", "SETTINGS_CHANGED", "READBACK_FAILED", "PROVIDER_REJECTED", "PROVIDER_RESPONSE_INVALID", "PROVIDER_TRANSPORT_FAILED"]);

function validateInput(env) {
  const input = {
    phone: String(env.PHONE || ""), runId: String(env.GITHUB_RUN_ID || ""),
    sourceSha: String(env.SOURCE_SHA || ""), runtimeSha: String(env.RUNTIME_SHA || ""),
    systemIdentifier: String(env.EXPECTED_PG_SYSTEM_IDENTIFIER || ""),
    brokerFloor: String(env.PRODUCTION_MIN_BROKER_ROWS || ""),
  };
  if (env.CONFIRM_SET_SENDER !== "1" || env.NODE_ENV !== "production" ||
      input.phone.length !== 12 || !/^\+79[0-9]{9}$/.test(input.phone) ||
      !/^[1-9][0-9]{0,19}$/.test(input.runId) ||
      !/^[0-9a-f]{40}$/.test(input.sourceSha) || !/^[0-9a-f]{40}$/.test(input.runtimeSha) ||
      env.GIT_SHA !== input.runtimeSha || !/^[1-9][0-9]{0,19}$/.test(input.systemIdentifier) ||
      !/^[1-9][0-9]{0,18}$/.test(input.brokerFloor)) throw new Error("INPUT_INVALID");
  return input;
}

function loadDependencies(env) {
  const { PrismaClient } = require("@st-michael/database");
  let url;
  try { url = new URL(env.DATABASE_URL); } catch { throw new Error("CONFIG_MISSING"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("CONFIG_MISSING");
  const options = url.searchParams.getAll("options").filter(Boolean);
  url.searchParams.delete("options");
  url.searchParams.set("options", [...options, "-c statement_timeout=15000"].join(" "));
  return { prisma: new PrismaClient({ log: [], datasources: { db: { url: url.toString() } } }), fetch: globalThis.fetch };
}

async function assertDatabaseIdentity(prisma, input) {
  const rows = await prisma.$queryRaw`SELECT system_identifier::text AS "systemIdentifier",
    (SELECT count(*) FROM public.brokers)::text AS "brokerRows" FROM pg_control_system()`;
  if (!Array.isArray(rows) || rows.length !== 1 ||
      String(rows[0]?.systemIdentifier) !== input.systemIdentifier ||
      !/^(0|[1-9][0-9]{0,18})$/.test(String(rows[0]?.brokerRows)) ||
      BigInt(rows[0].brokerRows) < BigInt(input.brokerFloor)) throw new Error("DATABASE_IDENTITY_INVALID");
}

async function readSettings(prisma, env) {
  const rows = await prisma.systemSetting.findMany({
    where: { key: { in: SETTING_KEYS } }, select: { key: true, value: true, updatedAt: true },
  });
  const byKey = new Map();
  if (!Array.isArray(rows)) throw new Error("SETTINGS_INVALID");
  for (const row of rows) {
    if (!row || !SETTING_KEYS.includes(row.key) || byKey.has(row.key) || typeof row.value !== "string" ||
        !(row.updatedAt instanceof Date) || !Number.isFinite(row.updatedAt.getTime())) throw new Error("SETTINGS_INVALID");
    byKey.set(row.key, row);
  }
  const effective = (key) => String(byKey.get(key)?.value || env[key] || "").trim();
  const flags = FLAG_KEYS.map(effective);
  for (const value of flags) {
    const normalized = value.toLowerCase();
    if (["1", "true", "yes", "on", "да"].includes(normalized)) throw new Error("SMS_FLAGS_ENABLED");
    if (!["", "0", "false", "no", "off", "нет"].includes(normalized)) throw new Error("SMS_FLAGS_INVALID");
  }
  const sender = effective("SMSC_SENDER");
  // No case, punctuation or whitespace identity substitution. Service trims
  // config values, but any nonempty noncanonical sender is a separate decision.
  if (sender && sender !== SENDER) throw new Error("SENDER_CONFLICT");
  const login = effective("SMSC_LOGIN"), apiKey = effective("SMSC_API_KEY");
  if (!login || !apiKey) throw new Error("CONFIG_MISSING");
  const snapshot = SETTING_KEYS.map((key) => {
    const row = byKey.get(key);
    return [key, row ? row.value : null, row ? row.updatedAt.toISOString() : null];
  });
  return { login, apiKey, sender, snapshot, senderRow: byKey.get("SMSC_SENDER") || null };
}

async function providerRequest(operation, settings, phone, fetchImpl) {
  const params = { login: settings.login, apikey: settings.apiKey, fmt: "3", charset: "utf-8" };
  const url = operation === "senders" ? "https://smsc.ru/sys/senders.php" : "https://smsc.ru/sys/send.php";
  if (operation === "senders") params.get = "1";
  else if (operation === "estimate") Object.assign(params, { cost: "1", phones: phone.slice(1), sender: SENDER, mes: TEST_TEXT });
  else throw new Error("PROVIDER_RESPONSE_INVALID");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetchImpl(url, {
      method: "POST", redirect: "error", headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
      body: new URLSearchParams(params).toString(), signal: controller.signal,
    });
    if (!response.body || typeof response.body.getReader !== "function") throw new Error("PROVIDER_RESPONSE_INVALID");
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array) || (total += value.byteLength) > 131072) throw new Error("PROVIDER_RESPONSE_INVALID");
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const raw = Buffer.concat(chunks, total).toString("utf8");
    let data;
    try { data = JSON.parse(raw); } catch { throw new Error("PROVIDER_RESPONSE_INVALID"); }
    if (!response.ok || (data && !Array.isArray(data) && (data.error !== undefined || data.error_code !== undefined))) throw new Error("PROVIDER_REJECTED");
    return data;
  } catch (error) {
    if (SAFE_FAILURES.has(error?.message)) throw error;
    throw new Error("PROVIDER_TRANSPORT_FAILED");
  } finally { clearTimeout(timeout); }
}

async function run(env = process.env, load = loadDependencies, emit = (value) => console.log(JSON.stringify(value))) {
  const input = validateInput(env); // Before any DB/provider access.
  const { prisma, fetch: fetchImpl } = load(env);
  let phase = "database_identity", writeAttempted = false;
  const binding = { runId: input.runId, sourceSha: input.sourceSha, runtimeSha: input.runtimeSha };
  try {
    await assertDatabaseIdentity(prisma, input);
    const settings = await readSettings(prisma, env);
    phase = "approved_sender_check";
    const approved = await providerRequest("senders", settings, input.phone, fetchImpl);
    if (!Array.isArray(approved) || approved.length > 1000 || approved.some((row) => !row || typeof row.sender !== "string" || !row.sender.trim())) throw new Error("PROVIDER_RESPONSE_INVALID");
    if (approved.filter((row) => row.sender === SENDER).length !== 1) throw new Error("SENDER_NOT_EXACTLY_APPROVED");
    phase = "price_estimate";
    const estimate = await providerRequest("estimate", settings, input.phone, fetchImpl);
    if (!estimate || typeof estimate !== "object" || Array.isArray(estimate) || estimate.id !== undefined ||
        !["number", "string"].includes(typeof estimate.cost) ||
        (typeof estimate.cost === "string" && !/^\d+(?:\.\d+)?$/.test(estimate.cost)) ||
        !Number.isFinite(Number(estimate.cost)) || Number(estimate.cost) < 0 || Number(estimate.cost) > 10000 ||
        !["number", "string"].includes(typeof estimate.cnt) || !/^[1-9][0-9]{0,3}$/.test(String(estimate.cnt)) || Number(estimate.cnt) > 1000) throw new Error("PROVIDER_RESPONSE_INVALID");
    phase = "settings_transaction";
    const changed = await prisma.$transaction(async (tx) => {
      // Fixed keys and parameter-free SQL only. Serializable also fences missing
      // rows, and create/updateMany provides explicit CAS with no retry loop.
      await tx.$queryRaw`SELECT key FROM public.system_settings WHERE key IN
        ('SMSC_LOGIN','SMSC_API_KEY','SMSC_SENDER','SMS_ENABLED','SMS_OTP_LOGIN',
         'SMS_OTP_REGISTER','SMS_OTP_PASSWORD_RESET','SMS_FIXATION_EXPIRY') ORDER BY key FOR UPDATE`;
      await assertDatabaseIdentity(tx, input);
      const current = await readSettings(tx, env);
      if (JSON.stringify(current.snapshot) !== JSON.stringify(settings.snapshot) ||
          current.login !== settings.login || current.apiKey !== settings.apiKey || current.sender !== settings.sender) throw new Error("SETTINGS_CHANGED");
      if (current.sender === SENDER) return false;
      const attribution = `workflow:configure-smsc-sender:${input.runId}`;
      writeAttempted = true;
      if (current.senderRow) {
        const result = await tx.systemSetting.updateMany({
          where: { key: "SMSC_SENDER", value: current.senderRow.value, updatedAt: current.senderRow.updatedAt },
          data: { value: SENDER, updatedBy: attribution },
        });
        if (result.count !== 1) throw new Error("SETTINGS_CHANGED");
      } else await tx.systemSetting.create({ data: { key: "SMSC_SENDER", value: SENDER, updatedBy: attribution } });
      const after = await readSettings(tx, env);
      if (after.senderRow?.value !== SENDER || after.sender !== SENDER ||
          after.snapshot.some((row, index) => row[0] !== "SMSC_SENDER" && JSON.stringify(row) !== JSON.stringify(current.snapshot[index]))) throw new Error("READBACK_FAILED");
      return true;
    }, { isolationLevel: "Serializable", maxWait: 5000, timeout: 15000 });
    const result = { ...binding, sender: SENDER, exactSenderApproved: true, priceEstimatePassed: true,
      providerRequests: 2, smsSent: false, automaticRetry: false, settingsChanged: changed,
      verifiedNoop: !changed, smsFlagsUnchanged: true, usersOtpsPasswordsJournalsUntouched: true };
    emit(result);
    return result;
  } catch (error) {
    emit({ ...binding, configurationFailed: true, phase, smsSent: false, automaticRetry: false,
      configurationOutcomeMayBeUnknown: writeAttempted,
      failureTag: SAFE_FAILURES.has(error?.message) ? error.message : "CONFIGURATION_FAILED" });
    throw new Error("CONFIGURATION_FAILED");
  } finally { await prisma.$disconnect(); }
}

module.exports = { run, validateInput };
if (require.main === module) run().catch(() => {
  console.error("Guarded sender configuration failed; no SMS was sent. Do not assume an ambiguous DB outcome was unchanged.");
  process.exitCode = 1;
});
