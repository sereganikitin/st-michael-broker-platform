"use strict";

// Read-only diagnostic. Never sends Telegram messages, imports application
// schedulers, refreshes tokens, prints SQL, or prints provider response bodies.
const fs = require("node:fs");
const MAX_LOG_BYTES = 64 * 1024 * 1024;
const MAX_JSON_BYTES = 65536;
const CONSTRAINTS = ["brokers_amo_contact_id_key", "brokers_phone_key", "clients_amo_lead_id_key", "clients_broker_id_amo_lead_id_key"];
const FEED_FAILURE_CODES = new Set([
  "FEED_URL_INVALID", "FEED_TLS_CONFIGURATION_INVALID", "FEED_HTTP_ERROR", "FEED_NETWORK_ERROR", "FEED_TIMEOUT",
  "FEED_RESPONSE_INVALID", "FEED_BODY_TOO_LARGE", "FEED_BODY_INCOMPLETE", "FEED_BODY_INVALID", "FEED_RETRY_AFTER_LIMIT",
  "FEED_XML_INVALID", "FEED_OFFERS_INVALID",
]);

function classifyPostgresLine(line) {
  const severity = line.match(/\b(ERROR|FATAL|PANIC|DETAIL|STATEMENT|CONTEXT|HINT|LOG|WARNING|NOTICE|INFO|DEBUG):/);
  if (!severity || !["ERROR", "FATAL", "PANIC"].includes(severity[1])) return null;
  let category = "other_database_error";
  if (/duplicate key value violates unique constraint/i.test(line)) category = "unique_conflict";
  else if (/violates foreign key constraint/i.test(line)) category = "foreign_key_conflict";
  else if (/null value .*violates not-null constraint/i.test(line)) category = "not_null_conflict";
  else if (/invalid input (?:syntax|value)/i.test(line)) category = "invalid_input";
  else if (/statement timeout|canceling statement/i.test(line)) category = "statement_timeout";
  else if (/deadlock detected/i.test(line)) category = "deadlock";
  else if (/could not serialize access/i.test(line)) category = "serialization_conflict";
  else if (/too many clients|remaining connection slots/i.test(line)) category = "connection_limit";
  else if (/password authentication failed|no pg_hba.conf entry/i.test(line)) category = "authentication_rejected";
  else if (/no space left on device|could not extend file/i.test(line)) category = "disk_capacity";
  else if (/terminating connection|connection .*closed/i.test(line)) category = "connection_interrupted";
  return { category, constraint: category === "unique_conflict" ? CONSTRAINTS.find((name) => line.includes(`"${name}"`)) || "other" : null };
}

async function postgresReport(input) {
  const counts = {}, constraints = {};
  let bytes = 0, remainder = "", total = 0;
  const consume = (line) => {
    const entry = classifyPostgresLine(line);
    if (!entry) return;
    total++;
    counts[entry.category] = (counts[entry.category] || 0) + 1;
    if (entry.constraint) constraints[entry.constraint] = (constraints[entry.constraint] || 0) + 1;
  };
  for await (const chunk of input) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_LOG_BYTES) throw new Error("LOG_BOUND_EXCEEDED");
    remainder += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    const lines = remainder.split("\n");
    remainder = lines.pop();
    for (const line of lines) consume(line);
    if (Buffer.byteLength(remainder) > MAX_JSON_BYTES) throw new Error("LINE_BOUND_EXCEEDED");
  }
  if (remainder) consume(remainder);
  return { scope: "postgres_retained_docker_logs_24h", total, categories: counts, knownUniqueConstraints: constraints, rawSqlEmitted: false, completeInput: true };
}

async function apiReport(input) {
  const report = { scope: "api_current_container_retained_logs_1h", totalErrorLines: 0, databaseErrorLines: 0, telegramDeliveryErrorLines: 0, catalogSyncErrorLines: 0, otherErrorLines: 0, rawLinesEmitted: false, completeInput: true };
  let bytes = 0, remainder = "";
  const consume = (raw) => {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, "");
    const prefix = line.match(/^\[Nest\]\s+\d+\s+-\s+/);
    if (!prefix) return;
    const severity = line.slice(prefix[0].length).match(/\b(LOG|ERROR|WARN|DEBUG|VERBOSE|FATAL)\b/);
    if (severity?.[1] !== "ERROR") return;
    report.totalErrorLines++;
    if (/\[database\] request (?:failed|rejected)/.test(line)) report.databaseErrorLines++;
    else if (/\[OpsAlertService\].*Failed to deliver alert/.test(line)) report.telegramDeliveryErrorLines++;
    else if (/\[SchedulerService\].*Catalog sync failed/.test(line)) report.catalogSyncErrorLines++;
    else report.otherErrorLines++;
  };
  for await (const chunk of input) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_LOG_BYTES) throw new Error("LOG_BOUND_EXCEEDED");
    remainder += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    const lines = remainder.split("\n"); remainder = lines.pop();
    for (const line of lines) consume(line);
    if (Buffer.byteLength(remainder) > MAX_JSON_BYTES) throw new Error("LINE_BOUND_EXCEEDED");
  }
  if (remainder) consume(remainder);
  return report;
}

async function boundedGet(url, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetchImpl(url, { method: "GET", redirect: "error", signal: controller.signal });
    const chunks = [];
    let bytes = 0;
    if (!response.body?.getReader) return { category: "invalid_response", status: response.status };
    const reader = response.body.getReader();
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > MAX_JSON_BYTES) { await reader.cancel(); return { category: "response_too_large", status: response.status }; }
        chunks.push(Buffer.from(part.value));
      }
    } finally { reader.releaseLock(); }
    let payload;
    try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return { category: "invalid_response", status: response.status }; }
    const code = Number.isInteger(payload?.error_code) ? payload.error_code : response.status;
    const category = response.ok && payload?.ok === true ? "ok" : code === 401 ? "authentication_rejected" : code === 403 ? "access_denied" : code === 400 ? "request_rejected" : code === 429 ? "rate_limited" : code >= 500 ? "upstream_unavailable" : "invalid_response";
    return { category, status: response.status, payload };
  } catch { return { category: controller.signal.aborted ? "timeout" : "network_failure" }; }
  finally { clearTimeout(timer); }
}

function telegramBase(environment) {
  const raw = String(environment.TELEGRAM_API_BASE || "https://api.telegram.org").replace(/\/+$/, "");
  if (!["https://api.telegram.org", "http://172.18.0.1:8081"].includes(raw)) throw new Error("TELEGRAM_BASE_REFUSED");
  return raw;
}

async function telegramReport(environment, fetchImpl = fetch) {
  const base = telegramBase(environment);
  const token = String(environment.OPS_TELEGRAM_BOT_TOKEN || "").trim() || String(environment.TELEGRAM_BOT_TOKEN || "").trim();
  const chats = [...new Set([environment.OPS_ALERT_CHAT_IDS, environment.OPS_ALERT_CHAT_ID].flatMap((value) => String(value || "").split(/[\s,;]+/)).filter(Boolean))];
  if (chats.length > 10 || chats.some((chat) => !/^-?[1-9][0-9]{0,18}$/.test(chat))) throw new Error("TELEGRAM_CHAT_CONFIG_REFUSED");
  if (!token || !chats.length) return { configured: false, messagesSent: 0 };
  if (!/^[0-9]+:[A-Za-z0-9_-]+$/.test(token)) throw new Error("TELEGRAM_TOKEN_CONFIG_REFUSED");
  const me = await boundedGet(`${base}/bot${token}/getMe`, fetchImpl);
  const out = { configured: true, relayConfigured: base.startsWith("http:"), botCheck: me.category, messagesSent: 0, chats: [] };
  if (me.category !== "ok" || !Number.isSafeInteger(me.payload?.result?.id)) return out;
  for (let index = 0; index < chats.length; index++) {
    const chat = chats[index];
    const info = await boundedGet(`${base}/bot${token}/getChat?${new URLSearchParams({ chat_id: chat })}`, fetchImpl);
    const result = { ordinal: index + 1, chatRead: info.category, membershipRead: "not_attempted", membership: "not_proven" };
    if (info.category === "ok") {
      const member = await boundedGet(`${base}/bot${token}/getChatMember?${new URLSearchParams({ chat_id: chat, user_id: String(me.payload.result.id) })}`, fetchImpl);
      result.membershipRead = member.category;
      if (member.category === "ok" && ["creator", "administrator", "member", "restricted", "left", "kicked"].includes(member.payload?.result?.status)) result.membership = member.payload.result.status;
      if (member.category === "ok") for (const flag of ["can_post_messages", "can_send_messages", "is_member"]) {
        if (typeof member.payload?.result?.[flag] === "boolean") result[flag] = member.payload.result[flag];
      }
    }
    out.chats.push(result);
  }
  // Read permissions are not proof that a message was delivered.
  return out;
}

function feedUrls(environment, compiledText) {
  return ["ZORGE", "SILVER"].map((project) => {
    const key = `PROFITBASE_FEED_${project}`;
    const match = compiledText.match(new RegExp(`process\\.env\\.${key}\\s*\\|\\|\\s*['\"]([^'\"]+)['\"]`));
    const url = new URL(environment[key] || match?.[1] || "");
    if (url.protocol !== "https:" || !/^(?:[a-z0-9-]+\.)?profitbase\.ru$/i.test(url.hostname) || url.username || url.password || url.port || !/^\/export\/profitbase_xml\/[a-z0-9]+$/i.test(url.pathname)) throw new Error("FEED_SCOPE_REFUSED");
    return { project, url };
  });
}

async function feedReport(environment, compiledText, fetchImpl = fetch) {
  const results = [];
  for (const { project, url } of feedUrls(environment, compiledText)) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetchImpl(url, { method: "GET", redirect: "error", signal: controller.signal });
      await response.body?.cancel?.();
      results.push({ project, httpStatus: response.status, category: response.ok ? "http_reachable_not_xml_validated" : response.status >= 500 ? "upstream_unavailable" : response.status === 429 ? "rate_limited" : "request_rejected", hardenedScopeCompatible: url.hostname === "pb7828.profitbase.ru" && /^\/export\/profitbase_xml\/[a-f0-9]{32}$/.test(url.pathname) && url.search === "?scheme=https" });
    } catch { results.push({ project, category: controller.signal.aborted ? "timeout" : "network_failure" }); }
    finally { clearTimeout(timer); }
  }
  return results;
}

async function validatedFeedReport(environment, compiledText, compiledCatalogPath, dependencies = {}) {
  // Only the reviewed pure sibling loader, never CatalogService/app bootstrap.
  // Fixed runtime image paths are not caller-controlled module import targets.
  const helperPath = compiledCatalogPath === "/app/apps/api/dist/catalog/catalog.service.js" ? "/app/apps/api/dist/catalog/profitbase-feed.js"
    : compiledCatalogPath === "/app/apps/api/dist/src/catalog/catalog.service.js" ? "/app/apps/api/dist/src/catalog/profitbase-feed.js" : null;
  if (!helperPath) throw new Error("COMPILED_FEED_SCOPE_REFUSED");
  const feeds = feedUrls(environment, compiledText);
  const existsSync = dependencies.existsSync || fs.existsSync;
  const loadModule = dependencies.loadModule || require;
  if (!existsSync(helperPath)) return feeds.map(({ project }) => ({ project, validated: false, failureCode: "not_available" }));
  let helper;
  try {
    helper = loadModule(helperPath);
    if (typeof helper?.loadProfitbaseOffers !== "function") throw new Error("VALIDATOR_EXPORT_REFUSED");
  } catch {
    return feeds.map(({ project }) => ({ project, validated: false, failureCode: "FEED_VALIDATOR_LOAD_FAILED" }));
  }
  const results = [];
  for (const { project, url } of feeds) {
    try {
      // GET-only loader bounds retries/body/time and validates the complete XML
      // plus mapped DB-field ranges, but performs no catalog or other writes.
      const offers = await helper.loadProfitbaseOffers(String(url));
      results.push(Array.isArray(offers) && offers.length > 0 && offers.length <= 50_000
        ? { project, validated: true, offerCount: offers.length }
        : { project, validated: false, failureCode: "FEED_RESULT_INVALID" });
    } catch (error) {
      // Never copy a URL, XML, provider body, status message or unknown code.
      results.push({ project, validated: false, failureCode: FEED_FAILURE_CODES.has(error?.code) ? error.code : "FEED_UNKNOWN_FAILURE" });
    }
  }
  return results;
}

function compiledValidationGate(error, helperPath) {
  if (typeof error?.stack !== "string") return null;
  for (const line of error.stack.split("\n")) {
    const frame = line.match(/\bat (?:Object\.)?parseValidatedProfitbaseOffers \((\/app\/apps\/api\/dist\/(?:src\/)?catalog\/profitbase-feed\.js):([0-9]{1,5}):[0-9]{1,5}\)/);
    if (frame && frame[1] === helperPath) return Number(frame[2]);
  }
  return null;
}

function numericFieldShapes(xml) {
  // Only fixed schema fields and reason counts; never values, IDs, project names
  // or XML fragments. This is diagnostic-only and does not normalize the feed.
  if (typeof xml !== "string" || Buffer.byteLength(xml) > 64 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(xml)) return null;
  const { XMLParser, XMLValidator } = require("fast-xml-parser");
  let offers;
  try {
    if (XMLValidator.validate(xml) !== true) return null;
    offers = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", maxNestedTags: 64, isArray: (name) => ["offer", "image", "custom-field", "special-offer"].includes(name) }).parse(xml)?.["realty-feed"]?.offer;
  } catch { return null; }
  if (!Array.isArray(offers) || offers.length < 1 || offers.length > 50_000) return null;
  const counts = {};
  for (const offer of offers) for (const field of ["area", "price", "price-meter"]) {
    const container = offer?.[field];
    if (container === undefined) continue;
    let reason;
    if (container === "") reason = "empty_container";
    else if (container === null || typeof container !== "object" || Array.isArray(container)) reason = "container_type";
    else {
      const value = container.value;
      if (value === undefined) reason = "missing_value";
      else if (typeof value === "string" && !value.trim()) reason = "empty_value";
      else if (!["number", "string"].includes(typeof value)) reason = "non_scalar_value";
      else if (!Number.isFinite(Number(value))) reason = "nonnumeric_value";
      else if (Number(value) < 0) reason = "negative_value";
    }
    if (reason) {
      counts[field] ||= {};
      counts[field][reason] = (counts[field][reason] || 0) + 1;
    }
  }
  return counts;
}

function blankNumericCompatibility(xml, helper, helperPath) {
  // Read-only candidate preflight: blank numeric values and literal zero have
  // identical effects in the existing Number(value || 0)/price-meter fallback.
  // Revalidate the WHOLE privately rebuilt feed with the deployed pure parser;
  // never return the XML, offers, their values, or raw exceptions.
  if (typeof xml !== "string" || Buffer.byteLength(xml) > 64 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(xml)) return { validated: false, failureCode: "FEED_XML_INVALID" };
  const { XMLParser, XMLBuilder, XMLValidator } = require("fast-xml-parser");
  let normalizedBlankValues = 0;
  try {
    if (XMLValidator.validate(xml) !== true) return { validated: false, failureCode: "FEED_XML_INVALID" };
    const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", maxNestedTags: 64, isArray: (name) => ["offer", "image", "custom-field", "special-offer"].includes(name) }).parse(xml);
    const offers = parsed?.["realty-feed"]?.offer;
    if (!Array.isArray(offers) || offers.length < 1 || offers.length > 50_000) return { validated: false, failureCode: "FEED_OFFERS_INVALID" };
    for (const offer of offers) for (const field of ["area", "price", "price-meter"]) {
      const container = offer?.[field];
      if (container && typeof container === "object" && !Array.isArray(container) && typeof container.value === "string" && !container.value.trim()) {
        container.value = 0;
        normalizedBlankValues++;
      }
    }
    if (!normalizedBlankValues) return { validated: false, failureCode: "NO_BLANK_NUMERIC_VALUES" };
    const candidateXml = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: "@_" }).build(parsed);
    if (Buffer.byteLength(candidateXml) > 64 * 1024 * 1024) return { validated: false, failureCode: "DIAGNOSTIC_BODY_TOO_LARGE" };
    const roundTrip = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", maxNestedTags: 64, isArray: (name) => ["offer", "image", "custom-field", "special-offer"].includes(name) }).parse(candidateXml);
    if (!require("node:util").isDeepStrictEqual(parsed, roundTrip)) return { validated: false, failureCode: "ROUNDTRIP_MISMATCH" };
    const validated = helper.parseValidatedProfitbaseOffers(candidateXml);
    if (!Array.isArray(validated) || validated.length !== offers.length) return { validated: false, failureCode: "FEED_RESULT_INVALID" };
    return { validated: true, offerCount: validated.length, normalizedBlankValues };
  } catch (error) {
    const result = { validated: false, failureCode: FEED_FAILURE_CODES.has(error?.code) ? error.code : "FEED_UNKNOWN_FAILURE" };
    const gate = compiledValidationGate(error, helperPath);
    if (gate !== null) result.compiledGateLine = gate;
    return result;
  }
}

async function feedCompatibilityReport(environment, compiledText, compiledCatalogPath, dependencies = {}) {
  const helperPath = compiledCatalogPath === "/app/apps/api/dist/catalog/catalog.service.js" ? "/app/apps/api/dist/catalog/profitbase-feed.js"
    : compiledCatalogPath === "/app/apps/api/dist/src/catalog/catalog.service.js" ? "/app/apps/api/dist/src/catalog/profitbase-feed.js" : null;
  if (!helperPath) throw new Error("COMPILED_FEED_SCOPE_REFUSED");
  const feeds = feedUrls(environment, compiledText), cap = 64 * 1024 * 1024;
  if (!(dependencies.existsSync || fs.existsSync)(helperPath)) return feeds.map(({ project }) => ({ project, failureCode: "not_available" }));
  let helper;
  try {
    helper = (dependencies.loadModule || require)(helperPath);
    if (typeof helper?.validateProfitbaseFeedUrl !== "function" || typeof helper?.parseValidatedProfitbaseOffers !== "function") throw new Error("VALIDATOR_EXPORT_REFUSED");
  } catch { return feeds.map(({ project }) => ({ project, failureCode: "FEED_VALIDATOR_LOAD_FAILED" })); }
  const results = [], fetchImpl = dependencies.fetchImpl || fetch;
  for (const { project, url } of feeds) {
    const out = { project, decodedBytes: 0, declaredBytes: null }, controller = new AbortController();
    let reader, response, timer, xml;
    const failure = (code) => Object.assign(new Error(code), { code });
    const expired = new Promise((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(failure("FEED_TIMEOUT")); }, 30_000); });
    try {
      // A separate diagnostic-only cap measures legitimate feed size. This does
      // not alter the production loader limit or perform any catalog updates.
      await Promise.race([expired, (async () => {
        if (environment.NODE_TLS_REJECT_UNAUTHORIZED === "0" || process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") throw failure("FEED_TLS_CONFIGURATION_INVALID");
        const canonical = helper.validateProfitbaseFeedUrl(String(url));
        response = await fetchImpl(canonical, { method: "GET", redirect: "error", signal: controller.signal });
        if (controller.signal.aborted) throw failure("FEED_TIMEOUT");
        if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599 || response.redirected || (response.url && response.url !== canonical)) throw failure("FEED_RESPONSE_INVALID");
        if (response.status < 200 || response.status >= 300) throw failure("FEED_HTTP_ERROR");
        const length = response.headers.get("content-length");
        if (length !== null && /^[0-9]+$/.test(length.trim()) && Number.isSafeInteger(Number(length))) out.declaredBytes = Number(length);
        if (out.declaredBytes > cap) throw failure("DIAGNOSTIC_BODY_TOO_LARGE");
        if (!response.body?.getReader) throw failure("FEED_BODY_INVALID");
        reader = response.body.getReader();
        const chunks = [];
        while (true) {
          const part = await reader.read();
          if (controller.signal.aborted) throw failure("FEED_TIMEOUT");
          if (part.done) break;
          if (!(part.value instanceof Uint8Array)) throw failure("FEED_BODY_INVALID");
          out.decodedBytes += part.value.byteLength;
          if (out.decodedBytes > cap) throw failure("DIAGNOSTIC_BODY_TOO_LARGE");
          chunks.push(part.value);
        }
        const encoding = response.headers.get("content-encoding")?.trim().toLowerCase();
        if ((!encoding || encoding === "identity") && out.declaredBytes !== null && out.decodedBytes !== out.declaredBytes) throw failure("FEED_BODY_INCOMPLETE");
        try { xml = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); } catch { throw failure("FEED_BODY_INVALID"); }
        const offers = helper.parseValidatedProfitbaseOffers(xml);
        if (!Array.isArray(offers) || offers.length < 1 || offers.length > 50_000) throw failure("FEED_OFFERS_INVALID");
        out.xmlFieldsValidated = true; out.offerCount = offers.length;
      })()]);
    } catch (error) {
      out.xmlFieldsValidated = false;
      out.failureCode = FEED_FAILURE_CODES.has(error?.code) || error?.code === "DIAGNOSTIC_BODY_TOO_LARGE" ? error.code : "FEED_UNKNOWN_FAILURE";
      const gate = compiledValidationGate(error, helperPath);
      if (gate !== null && ["FEED_XML_INVALID", "FEED_OFFERS_INVALID"].includes(out.failureCode)) out.compiledGateLine = gate;
      // Deployed 23e188's emitted line105 is exactly the area/price/price-meter
      // container/value gate. Other errors are not interpreted as this shape.
      if (out.failureCode === "FEED_OFFERS_INVALID" && gate === 105) {
        const shapes = numericFieldShapes(xml);
        if (shapes !== null) out.numericFieldShapes = shapes;
        out.blankNumericCompatibility = blankNumericCompatibility(xml, helper, helperPath);
      }
    } finally {
      clearTimeout(timer); controller.abort();
      try { (reader ? reader.cancel() : response?.body?.cancel())?.catch(() => {}); reader?.releaseLock(); } catch {}
    }
    results.push(out);
  }
  return results;
}

function readOnlyUrl(raw) {
  const url = new URL(raw);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || url.pathname !== "/broker_platform") throw new Error("DATABASE_SCOPE_REFUSED");
  url.searchParams.append("options", "-c default_transaction_read_only=on -c statement_timeout=15000");
  return String(url);
}

async function liveReport(environment = process.env) {
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient({ datasources: { db: { url: readOnlyUrl(environment.DATABASE_URL) } }, log: [] });
  try {
    const rows = await prisma.$queryRaw`SELECT current_database() AS database_name, current_setting('default_transaction_read_only') AS mode`;
    if (rows.length !== 1 || rows[0].database_name !== "broker_platform" || rows[0].mode !== "on") throw new Error("DATABASE_READ_ONLY_REFUSED");
    const tokenSetting = await prisma.systemSetting.findUnique({ where: { key: "TELEGRAM_API_BASE" }, select: { value: true } });
    // Production OpsAlertService uses the environment, not this setting. Report
    // only whether a misleading separate setting exists, never its value.
    const compiledPath = "/app/apps/api/dist/catalog/catalog.service.js";
    const fallbackPath = "/app/apps/api/dist/src/catalog/catalog.service.js";
    const compiledCatalogPath = fs.existsSync(compiledPath) ? compiledPath : fallbackPath;
    const compiledText = fs.readFileSync(compiledCatalogPath, "utf8");
    return { scope: "runtime_readonly_no_send", databaseReadOnly: true, separateTelegramBaseSettingPresent: Boolean(tokenSetting?.value), telegram: await telegramReport(environment), feeds: await feedReport(environment, compiledText), validatedFeeds: await validatedFeedReport(environment, compiledText, compiledCatalogPath), feedCompatibility: await feedCompatibilityReport(environment, compiledText, compiledCatalogPath), applicationWrites: 0 };
  } finally { await prisma.$disconnect(); }
}

module.exports = { classifyPostgresLine, postgresReport, apiReport, boundedGet, telegramBase, telegramReport, feedUrls, feedReport, validatedFeedReport, feedCompatibilityReport, compiledValidationGate, numericFieldShapes, blankNumericCompatibility, readOnlyUrl, liveReport };
if (require.main === module) {
  const action = process.argv[2];
  Promise.resolve().then(() => action === "--postgres" ? postgresReport(process.stdin) : action === "--api" ? apiReport(process.stdin) : action === "--live" ? liveReport() : Promise.reject(new Error("MODE_REFUSED")))
    .then((report) => process.stdout.write(`${JSON.stringify(report)}\n`))
    .catch(() => { process.stderr.write("runtime_diagnostic_refused=true\n"); process.exitCode = 1; });
}
