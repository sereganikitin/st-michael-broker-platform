"use strict";
// Invoked inside the existing API container. Imports only Prisma, without Nest jobs.
const crypto = require("node:crypto");
const TARGET_AGENCY_ID = "372fa09f-373d-4c13-9ee2-484b75f4f3be";
const SAFE_CODES = new Set([
  "INVALID_INPUT",
  "HTTP_FAILED",
  "INVALID_RESPONSE",
  "HEALTH_MISMATCH",
  "NOT_READY",
  "NO_ADMIN",
  "SYNC_INCOMPLETE",
  "SOURCE_INCOMPLETE",
]);
function fail(code) {
  const error = new Error(code);
  error.safeCode = code;
  throw error;
}
function inputs(env) {
  const mode = env.MODE || "dry-run";
  if (
    !/^[0-9a-f]{40}$/.test(env.EXPECTED_DEPLOYED_SHA || "") ||
    !["apply", "dry-run"].includes(mode)
  )
    fail("INVALID_INPUT");
  if (mode === "apply" && env.CONFIRM_APPLY !== "true") fail("INVALID_INPUT");
  if (env.GIT_SHA !== env.EXPECTED_DEPLOYED_SHA || !env.JWT_SECRET)
    fail("INVALID_INPUT");
  return { mode, sha: env.EXPECTED_DEPLOYED_SHA };
}
function signJwt(admin, secret, now = Date.now()) {
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const data = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: admin.id, role: "ADMIN", type: "access", authVersion: admin.authVersion, iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 1800 })}`;
  return `${data}.${crypto.createHmac("sha256", secret).update(data).digest("base64url")}`;
}
async function http(fetchImpl, method, path, token, body, timeoutMs = 30000) {
  let response;
  try {
    response = await fetchImpl(`http://127.0.0.1:4000/api${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) fail("HTTP_FAILED");
    const text = await response.text();
    if (text.length > 1024 * 1024) fail("INVALID_RESPONSE");
    return JSON.parse(text);
  } catch (error) {
    if (SAFE_CODES.has(error?.safeCode)) throw error;
    fail("HTTP_FAILED");
  }
}
const COUNT_KEYS = [
  "total",
  "remainingAtStart",
  "attempted",
  "processed",
  "linked",
  "conflicts",
  "notFound",
  "invalidInn",
  "cycleInvalidInn",
  "errors",
  "lookups",
  "deduplicatedLookups",
  "pagesRead",
  "changed",
  "unchanged",
  "written",
  "deferred",
  "durationMs",
];
function syncReceipt(result, mode, global) {
  const stats = result?.stats;
  if (
    !stats ||
    COUNT_KEYS.some(
      (key) => !Number.isSafeInteger(stats[key]) || stats[key] < 0,
    )
  )
    fail("INVALID_RESPONSE");
  const counts = Object.fromEntries(COUNT_KEYS.map((key) => [key, stats[key]]));
  if (
    result.status !== "SUCCEEDED" ||
    result.errorCode !== null ||
    !stats.scopeComplete ||
    stats.deferred ||
    stats.errors ||
    (!global && (stats.invalidInn || stats.cycleInvalidInn)) ||
    stats.processed !== stats.remainingAtStart ||
    (global && !stats.cycleComplete) ||
    (mode === "dry-run" && stats.written !== 0)
  )
    fail("SYNC_INCOMPLETE");
  return {
    status: "SUCCEEDED",
    mode,
    scopeComplete: true,
    cycleComplete: stats.cycleComplete === true,
    counts,
  };
}
function sourceCounts(rows, now = Date.now()) {
  const counts = {
    total: rows.length,
    validInn: 0,
    missingConfirmedInn: 0,
    invalidNotClassified: 0,
    current: 0,
    notFound: 0,
    missing: 0,
    errors: 0,
    identityMismatch: 0,
    stale: 0,
    conflicts: 0,
  };
  for (const row of rows) {
    const snapshot = row.amoCompanySync;
    const inn = String(row.inn || "").replace(/\D/g, "");
    if (!/^\d{10}$|^\d{12}$/.test(inn)) {
      counts.missingConfirmedInn++;
      if (snapshot?.errorCode !== "INVALID_INN") counts.invalidNotClassified++;
      continue;
    }
    counts.validInn++;
    if (snapshot?.errorCode === "COMPANY_NOT_FOUND") {
      const at = new Date(snapshot.lastAttemptAt || "").getTime();
      if (!Number.isFinite(at) || now - at > 36 * 3600000 || at > now + 1000)
        counts.stale++;
      else counts.notFound++;
      continue;
    }
    if (snapshot?.errorCode) {
      counts.errors++;
      continue;
    }
    if (!snapshot?.lastSuccessAt) {
      counts.missing++;
      continue;
    }
    if (snapshot.profile?._sourceInn !== inn) {
      counts.identityMismatch++;
      continue;
    }
    const at = new Date(snapshot.lastSuccessAt).getTime();
    if (!Number.isFinite(at) || now - at > 36 * 3600000 || at > now + 1000) {
      counts.stale++;
      continue;
    }
    if (snapshot.linkStatus === "CONFLICT") counts.conflicts++;
    counts.current++;
  }
  return counts;
}
function detailReceipt(response) {
  const item = response?.item;
  if (!item || item.id !== TARGET_AGENCY_ID || !item.sourceFreshness)
    fail("INVALID_RESPONSE");
  const attributes = item.attributes || {};
  const numeric = (key) =>
    Number.isSafeInteger(attributes[key]) && attributes[key] >= 0
      ? attributes[key]
      : null;
  const status = item.sourceFreshness.status;
  if (!["CURRENT", "STALE", "ERROR", "NOT_SYNCED"].includes(status))
    fail("INVALID_RESPONSE");
  return {
    sourceStatus: status,
    brokerCount: numeric("brokerCount"),
    activeBrokers: numeric("activeBrokers"),
    activeBrokerWindowDays: numeric("activeBrokerWindowDays"),
    lastContractDate: /^\d{4}-\d{2}-\d{2}$/.test(
      attributes.lastContractDate || "",
    )
      ? attributes.lastContractDate
      : null,
    websiteAvailable: item.fieldAvailability?.website?.status === "AVAILABLE",
  };
}
async function run(deps = {}) {
  const env = deps.env || process.env;
  const config = inputs(env);
  const fetchImpl = deps.fetch || fetch;
  const health = await http(fetchImpl, "GET", "/health");
  if (health.deployedSha !== config.sha) fail("HEALTH_MISMATCH");
  const ready = await http(fetchImpl, "GET", "/health/ready");
  if (
    ready.status !== "ok" ||
    ready.checks?.postgresql !== "ok" ||
    ready.checks?.redis !== "ok"
  )
    fail("NOT_READY");
  const prisma =
    deps.prisma || new (require("@st-michael/database").PrismaClient)();
  try {
    const admin = await prisma.broker.findFirst({
      where: {
        role: "ADMIN",
        status: "ACTIVE",
        mergedIntoId: null,
        passwordHash: { not: null },
      },
      select: { id: true, authVersion: true },
      orderBy: { createdAt: "asc" },
    });
    if (
      !admin ||
      !Number.isSafeInteger(admin.authVersion) ||
      admin.authVersion < 0
    )
      fail("NO_ADMIN");
    const token = signJwt(admin, env.JWT_SECRET);
    const dry = await http(
      fetchImpl,
      "POST",
      "/amocrm/agency-profiles/sync",
      token,
      { mode: "dry-run", agencyId: TARGET_AGENCY_ID },
      5 * 60000,
    );
    const receipt = {
      mode: config.mode,
      deployedSha: config.sha,
      targetDryRun: syncReceipt(dry, "dry-run", false),
    };
    if (config.mode === "apply") {
      const applied = await http(
        fetchImpl,
        "POST",
        "/amocrm/agency-profiles/sync-all",
        token,
        { mode: "apply" },
        25 * 60000,
      );
      receipt.applied = syncReceipt(applied, "apply", true);
      const rows = await prisma.agency.findMany({
        select: {
          inn: true,
          amoCompanySync: {
            select: {
              lastSuccessAt: true,
              lastAttemptAt: true,
              errorCode: true,
              profile: true,
              linkStatus: true,
            },
          },
        },
      });
      receipt.sources = sourceCounts(rows);
      if (
        receipt.sources.total !== receipt.applied.counts.total ||
        receipt.sources.current + receipt.sources.notFound !==
          receipt.sources.validInn ||
        receipt.sources.invalidNotClassified ||
        receipt.applied.counts.cycleInvalidInn !==
          receipt.sources.missingConfirmedInn
      )
        fail("SOURCE_INCOMPLETE");
    }
    receipt.target = detailReceipt(
      await http(
        fetchImpl,
        "GET",
        `/loyalty-base/ours/agencies/${TARGET_AGENCY_ID}`,
        token,
        undefined,
        120000,
      ),
    );
    if (config.mode === "apply" && receipt.target.sourceStatus !== "CURRENT")
      fail("SOURCE_INCOMPLETE");
    const after = await http(fetchImpl, "GET", "/health");
    if (after.deployedSha !== config.sha) fail("HEALTH_MISMATCH");
    (deps.emit || console.log)(
      JSON.stringify({ agencyProfileRefresh: receipt }),
    );
    return receipt;
  } finally {
    await prisma.$disconnect();
  }
}
function reportFailure(error) {
  console.error(
    JSON.stringify({
      agencyProfileRefresh: {
        status: "FAILED",
        code: SAFE_CODES.has(error?.safeCode) ? error.safeCode : "UNEXPECTED",
      },
    }),
  );
}
module.exports = {
  run,
  reportFailure,
  inputs,
  signJwt,
  syncReceipt,
  sourceCounts,
  detailReceipt,
  TARGET_AGENCY_ID,
};

process.env.MODE="dry-run";
process.env.EXPECTED_DEPLOYED_SHA="19250ccb45bf8ba78639ac6c549df077d54c629c";
run({fetch: async (url, options) => {
  const response=await fetch(url,options);
  return {ok:response.ok,text:async()=>{
    const body=await response.text();
    let json; try{json=JSON.parse(body);}catch{}
    console.log("AGENCY_REFRESH_DIAGNOSTIC "+JSON.stringify({route:new URL(url).pathname,status:response.status,bytes:Buffer.byteLength(body),keys:json&&typeof json==="object"?Object.keys(json):[],hasItem:Boolean(json?.item),itemIdMatches:json?.item?.id===TARGET_AGENCY_ID,sourceStatus:json?.item?.sourceFreshness?.status,stats:json?.stats?Object.fromEntries(COUNT_KEYS.map(key=>[key,json.stats[key]??null])):null}));
    return body;
  }};
}}).catch(error=>{reportFailure(error);process.exitCode=1;});
