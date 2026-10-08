#!/usr/bin/env node
"use strict";

// Official read-only SMSC operations only: approved sender listing (get=1)
// and price estimation (cost=1). Never create SMS/OTP/journal/settings rows.
// https://smsc.ru/api/http/senders/ and https://smsc.ru/api/http/send/
const SETTING_KEYS = ["SMSC_LOGIN", "SMSC_API_KEY", "SMSC_SENDER"];
const TIMEOUT_MS = 15000;
const MAX_RESPONSE_CHARS = 131072;
const MAX_SENDERS = 1000;
const MAX_PROVIDER_REQUESTS = 11;
const MAX_EXTRA_APPROVED_SENDERS = 3;
const BRAND_SENDER = "ST MICHAEL";
const ESTIMATE_TEXTS = Object.freeze({
  test: "Тест СМС: 000000. Код недействителен для входа и смены пароля.",
  password_reset:
    "Код для смены пароля: 000000. Если это не вы — не вводите его.",
  neutral: "Тест.",
});

function validatePhone(env) {
  const phone = String(env.PHONE || "");
  if (phone.length !== 12 || !/^\+79\d{9}$/.test(phone))
    throw new Error("INPUT_INVALID");
  return phone;
}

function buildReadOnlyDatabaseUrl(databaseUrl) {
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_CONFIG_INVALID");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol))
    throw new Error("DATABASE_CONFIG_INVALID");
  const previous = parsed.searchParams.getAll("options").filter(Boolean);
  parsed.searchParams.delete("options");
  parsed.searchParams.set(
    "options",
    [
      ...previous,
      "-c default_transaction_read_only=on",
      "-c statement_timeout=15000",
    ].join(" "),
  );
  return parsed.toString();
}

function loadDependencies(env) {
  const { PrismaClient } = require("@st-michael/database");
  return {
    prisma: new PrismaClient({
      datasources: { db: { url: buildReadOnlyDatabaseUrl(env.DATABASE_URL) } },
    }),
    fetch: globalThis.fetch,
  };
}

async function readSettings(prisma, env) {
  const rows = await prisma.systemSetting.findMany({
    where: { key: { in: SETTING_KEYS } },
    select: { key: true, value: true },
  });
  const values = new Map(
    rows.filter((row) => row.value).map((row) => [row.key, row.value]),
  );
  const get = (key) => String(values.get(key) || env[key] || "").trim();
  return {
    login: get("SMSC_LOGIN"),
    apiKey: get("SMSC_API_KEY"),
    sender: get("SMSC_SENDER"),
  };
}

function errorCode(data) {
  const code = Number(data && data.error_code);
  return Number.isInteger(code) && code >= 1 && code <= 9 ? code : null;
}

async function requestNoSend(operation, settings, phone, fetchImpl, estimate) {
  const params = {
    login: settings.login,
    apikey: settings.apiKey,
    fmt: "3",
    charset: "utf-8",
  };
  let endpoint;
  if (operation === "senders") {
    endpoint = "https://smsc.ru/sys/senders.php";
    params.get = "1";
  } else if (operation === "estimate") {
    endpoint = "https://smsc.ru/sys/send.php";
    params.cost = "1"; // Immutable no-send mode. Never read a cost/apply value from env.
    params.phones = phone.slice(1);
    if (!estimate || !Object.hasOwn(ESTIMATE_TEXTS, estimate.template))
      throw new Error("OPERATION_INVALID");
    params.mes = ESTIMATE_TEXTS[estimate.template];
    if (estimate.sender) params.sender = estimate.sender;
  } else {
    throw new Error("OPERATION_INVALID");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
      },
      body: new URLSearchParams(params).toString(),
      signal: controller.signal,
    });
    const raw = await response.text();
    if (raw.length > MAX_RESPONSE_CHARS)
      return { ok: false, errorCode: null, failureTag: "RESPONSE_INVALID" };
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return { ok: false, errorCode: null, failureTag: "RESPONSE_INVALID" };
    }
    if (
      !response.ok ||
      (data &&
        !Array.isArray(data) &&
        typeof data === "object" &&
        (data.error !== undefined || data.error_code !== undefined))
    ) {
      return {
        ok: false,
        errorCode: errorCode(data),
        failureTag: "PROVIDER_REJECTED",
      };
    }
    return { ok: true, data };
  } catch {
    return { ok: false, errorCode: null, failureTag: "TRANSPORT_FAILED" };
  } finally {
    clearTimeout(timeout);
  }
}

function senderProjection(result, settings) {
  if (!result.ok)
    return {
      ok: false,
      errorCode: result.errorCode,
      failureTag: result.failureTag,
    };
  if (
    !Array.isArray(result.data) ||
    result.data.length > MAX_SENDERS ||
    result.data.some(
      (row) => !row || typeof row.sender !== "string" || !row.sender.trim(),
    )
  ) {
    return { ok: false, errorCode: null, failureTag: "RESPONSE_INVALID" };
  }
  return {
    ok: true,
    approvedSenderCount: result.data.length,
    configuredSenderListed: settings.sender
      ? result.data.some((row) => row.sender === settings.sender)
      : null,
  };
}

function estimateProjection(result) {
  if (!result.ok)
    return {
      ok: false,
      errorCode: result.errorCode,
      failureTag: result.failureTag,
    };
  const data = result.data;
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    data.id !== undefined
  ) {
    return { ok: false, errorCode: null, failureTag: "RESPONSE_INVALID" };
  }
  const costValue = data.cost;
  if (
    (typeof costValue !== "number" && typeof costValue !== "string") ||
    (typeof costValue === "string" && !/^\d+(?:\.\d+)?$/.test(costValue))
  ) {
    return { ok: false, errorCode: null, failureTag: "RESPONSE_INVALID" };
  }
  const cost = Number(costValue);
  const parts = Number(data.cnt);
  if (
    !Number.isFinite(cost) ||
    cost < 0 ||
    cost > 10000 ||
    !Number.isInteger(parts) ||
    parts < 1 ||
    parts > 1000
  ) {
    return { ok: false, errorCode: null, failureTag: "RESPONSE_INVALID" };
  }
  return { ok: true, cost, parts };
}

function estimateVariants(result, senders, settings) {
  const variants = [{ senderMode: "default", sender: "" }];
  let brandSelection = "unavailable";
  let approvedBrand = "";
  if (senders.ok) {
    // Never normalize punctuation/whitespace or select a generic/foreign sender.
    const matches = [...new Set(result.data.map((row) => row.sender))].filter(
      (sender) => sender.toLowerCase() === BRAND_SENDER.toLowerCase(),
    );
    if (matches.includes(BRAND_SENDER)) {
      approvedBrand = BRAND_SENDER;
      brandSelection = "exact";
    } else if (matches.length === 1) {
      approvedBrand = matches[0];
      brandSelection = "case_unique";
    } else {
      brandSelection = matches.length ? "ambiguous" : "not_approved";
    }
  }
  const configuredAllowed = Boolean(
    approvedBrand &&
    settings.sender &&
    settings.sender.toLowerCase() === BRAND_SENDER.toLowerCase() &&
    result.data.some((row) => row.sender === settings.sender),
  );
  if (configuredAllowed)
    variants.push({ senderMode: "configured_brand", sender: settings.sender });
  if (approvedBrand && !variants.some((row) => row.sender === approvedBrand))
    variants.push({ senderMode: "approved_brand", sender: approvedBrand });
  let additionalSenderCount = 0;
  if (senders.ok) {
    // Technical price probes only, not an authorization to configure or send
    // using another business's identity. Keep names in memory, never in output.
    const seen = new Set(variants.map((row) => row.sender.toLowerCase()));
    const maxVariants = Math.floor((MAX_PROVIDER_REQUESTS - 1) / Object.keys(ESTIMATE_TEXTS).length);
    for (const row of result.data) {
      const sender = row.sender;
      const normalized = sender.toLowerCase();
      if (normalized === BRAND_SENDER.toLowerCase() || seen.has(normalized) ||
          sender !== sender.trim() || sender.length > 64 || /[\x00-\x1f\x7f]/.test(sender)) continue;
      if (additionalSenderCount >= MAX_EXTRA_APPROVED_SENDERS || variants.length >= maxVariants) break;
      seen.add(normalized);
      additionalSenderCount++;
      variants.push({ senderMode: `approved_sender_${additionalSenderCount}`, sender });
    }
  }
  return {
    variants,
    additionalSenderCount,
    brandSelection,
    approvedBrand: approvedBrand ? BRAND_SENDER : null, // Only agreed public label.
    configuredSenderStatus: !settings.sender
      ? "missing"
      : configuredAllowed
        ? "checked"
        : "skipped_not_approved_brand",
  };
}

function estimateComparison(matrix) {
  let providerResultDiffersBySender = false;
  let providerResultDiffersByTemplate = false;
  let costOrPartsDifferBySender = false;
  const known = (row) => row.ok ||
    (row.failureTag === "PROVIDER_REJECTED" && row.errorCode !== null);
  const outcome = (row) => row.ok ? "accepted" : `rejected_${row.errorCode}`;
  for (const template of Object.keys(ESTIMATE_TEXTS)) {
    const rows = matrix.filter((row) => row.template === template);
    providerResultDiffersBySender ||= new Set(rows.filter(known).map(outcome)).size > 1;
    costOrPartsDifferBySender ||= new Set(rows.filter((row) => row.ok)
      .map((row) => `${row.cost}:${row.parts}`)).size > 1;
  }
  for (const senderMode of new Set(matrix.map((row) => row.senderMode))) {
    const rows = matrix.filter((row) => row.senderMode === senderMode);
    providerResultDiffersByTemplate ||= new Set(rows.filter(known).map(outcome)).size > 1;
  }
  return {
    providerResultDiffersBySender,
    providerResultDiffersByTemplate,
    costOrPartsDifferBySender,
    conclusion: providerResultDiffersBySender && providerResultDiffersByTemplate
      ? "sender_and_template_dependent_estimate_result_observed"
      : providerResultDiffersBySender
        ? "sender_dependent_estimate_result_observed"
        : providerResultDiffersByTemplate
          ? "template_dependent_estimate_result_observed"
          : costOrPartsDifferBySender
            ? "sender_dependent_estimate_price_observed"
            : "no_sender_dependency_established",
    deliveryVerified: false,
  };
}

async function run(
  env = process.env,
  load = loadDependencies,
  emit = (value) => console.log(JSON.stringify(value)),
) {
  const phone = validatePhone(env); // Before DB/provider access; never emitted.
  const { prisma, fetch: fetchImpl } = load(env);
  try {
    const session =
      await prisma.$queryRaw`SELECT current_setting('default_transaction_read_only') AS mode`;
    if (
      !Array.isArray(session) ||
      session.length !== 1 ||
      session[0]?.mode !== "on"
    )
      throw new Error("DATABASE_NOT_READ_ONLY");
    const settings = await readSettings(prisma, env);
    if (!settings.login || !settings.apiKey) throw new Error("CONFIG_MISSING");
    let providerRequests = 0;
    const request = (...args) => {
      if (providerRequests >= MAX_PROVIDER_REQUESTS) throw new Error("REQUEST_LIMIT");
      providerRequests++;
      return requestNoSend(...args);
    };
    const senderResult = await request(
      "senders",
      settings,
      phone,
      fetchImpl,
    );
    const senders = senderProjection(senderResult, settings);
    const selection = estimateVariants(senderResult, senders, settings);
    const matrix = [];
    for (const variant of selection.variants) {
      for (const template of Object.keys(ESTIMATE_TEXTS)) {
        matrix.push({
          senderMode: variant.senderMode,
          template,
          ...estimateProjection(
            await request("estimate", settings, phone, fetchImpl, {
              sender: variant.sender,
              template,
            }),
          ),
        });
      }
    }
    // Backwards-compatible current TEST result; safe default if current is not approved.
    const currentTest =
      matrix.find(
        (row) =>
          row.senderMode === "configured_brand" && row.template === "test",
      ) || matrix[0];
    const { senderMode, template, ...estimate } = currentTest;
    const report = {
      readOnly: true,
      databaseSessionReadOnly: true,
      smsSent: false,
      providerRequests, // One sender-list plus at most ten immutable cost=1 requests.
      automaticRetry: false,
      priceEstimateOnly: true,
      senderConfigured: Boolean(settings.sender),
      defaultSenderRequested: true,
      configuredSenderStatus: selection.configuredSenderStatus,
      brandSelection: selection.brandSelection,
      approvedBrand: selection.approvedBrand,
      additionalApprovedSendersEstimated: selection.additionalSenderCount,
      additionalSenderEstimatesTechnicalOnly: true,
      additionalSenderSendingAuthorized: false,
      senderConfigurationChanged: false,
      estimateComparison: estimateComparison(matrix),
      senders,
      estimate,
      matrix,
    };
    emit(report);
    return report;
  } catch (error) {
    const allowed = ["DATABASE_NOT_READ_ONLY", "CONFIG_MISSING"];
    emit({
      readOnly: true,
      smsSent: false,
      diagnosticFailed: true,
      failureTag: allowed.includes(error?.message)
        ? error.message
        : "DIAGNOSTIC_FAILED",
    });
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

module.exports = { run, validatePhone, buildReadOnlyDatabaseUrl };
if (require.main === module) {
  run().catch(() => {
    console.error(
      "Read-only SMSC diagnostic failed; no message sent and no data changed.",
    );
    process.exitCode = 1;
  });
}
