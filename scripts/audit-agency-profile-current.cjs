"use strict";
const crypto = require("node:crypto");
const { PrismaClient } = require("@st-michael/database");
const RULE = "amo-agency-company-v1";
const TARGET = "372fa09f-373d-4c13-9ee2-484b75f4f3be";
const countKeys = ["total", "remainingAtStart", "attempted", "processed", "linked", "conflicts", "notFound", "invalidInn", "cycleInvalidInn", "cycleEligibleRead", "errors", "lookups", "deduplicatedLookups", "pagesRead", "changed", "unchanged", "written", "deferred", "resumed", "scopeComplete", "cycleComplete", "durationMs"];
const safeCounts = value => Object.fromEntries(["mode", ...countKeys].flatMap(key => {
  const entry = value?.[key];
  return typeof entry === "boolean" || (typeof entry === "number" && Number.isFinite(entry)) || (key === "mode" && ["apply", "dry-run"].includes(entry)) ? [[key, entry]] : [];
}));
const iso = value => value ? new Date(value).toISOString() : null;
const freshness = (row, now) => row.errorCode ? "ERROR" : !row.lastSuccessAt ? "NOT_SYNCED" : now.getTime() - new Date(row.lastSuccessAt).getTime() > 36 * 3600000 ? "STALE" : "CURRENT";
const fail = safeCode => { const error = new Error(safeCode); error.safeCode = safeCode; throw error; };
async function main() {
  console.log("AGENCY_NIGHTLY_AUDIT_STARTED");
  const prisma = new PrismaClient({ log: [] });
  try {
    await prisma.$connect();
    const now = new Date();
    const [runs, snapshots, agencies, target, stateSetting] = await Promise.all([
      prisma.loyaltySyncRun.findMany({ where: { source: "AMOCRM", ruleVersion: RULE }, orderBy: { startedAt: "desc" }, take: 8, select: { id: true, status: true, ruleVersion: true, startedAt: true, completedAt: true, errorCode: true, counts: true } }),
      prisma.agencyAmoCompanySync.findMany({ select: { lastAttemptAt: true, lastSuccessAt: true, sourceUpdatedAt: true, errorCode: true, linkStatus: true } }),
      prisma.agency.findMany({ select: { inn: true } }),
      prisma.agency.findUnique({ where: { id: TARGET }, select: { id: true, amoCompanySync: true, _count: { select: { brokerAgencies: { where: { broker: { is: { role: "BROKER", mergedIntoId: null } } } } } } } }),
      prisma.systemSetting.findUnique({ where: { key: "AMO_AGENCY_COMPANY_SYNC_STATE" }, select: { value: true } }),
    ]);
    console.log("AGENCY_NIGHTLY_AUDIT_DB_READ");
    const todayMoscow = new Date(now.getTime() + 10800000).toISOString().slice(0, 10);
    const dayStart = new Date(`${todayMoscow}T00:00:00+03:00`);
    const bucket = { CURRENT: 0, STALE: 0, ERROR: 0, NOT_SYNCED: 0 };
    const links = {};
    const errorCodes = {};
    const successfulDates = [];
    let attemptedToday = 0, succeededToday = 0;
    for (const row of snapshots) {
      bucket[freshness(row, now)]++;
      const link = ["LINKED", "NOT_FOUND", "CONFLICT"].includes(row.linkStatus) ? row.linkStatus : "OTHER";
      links[link] = (links[link] || 0) + 1;
      if (row.errorCode) { const code = /^[A-Z0-9_]{1,100}$/.test(row.errorCode) ? row.errorCode : "OTHER"; errorCodes[code] = (errorCodes[code] || 0) + 1; }
      if (row.lastAttemptAt && row.lastAttemptAt >= dayStart) attemptedToday++;
      if (row.lastSuccessAt) {
        successfulDates.push(iso(row.lastSuccessAt));
        if (row.lastSuccessAt >= dayStart) succeededToday++;
      }
    }
    successfulDates.sort();
    let state = null;
    if (stateSetting) {
      const raw = JSON.parse(stateSetting.value);
      state = { version: raw.version, cycleStartedAt: raw.cycleStartedAt, lastCompleteAt: raw.lastCompleteAt, lastErrorCode: raw.lastErrorCode, pendingSourceFailure: raw.pendingSourceFailure, cycleInvalidInn: raw.cycleInvalidInn, cycleEligibleRead: raw.cycleEligibleRead, cursorPresent: Boolean(raw.cursor) };
    }
    const admin = await prisma.broker.findFirst({ where: { role: "ADMIN", status: "ACTIVE", mergedIntoId: null, passwordHash: { not: null } }, select: { id: true, authVersion: true }, orderBy: { createdAt: "asc" } });
    if (!admin || !process.env.JWT_SECRET) fail("READ_AUTH_UNAVAILABLE");
    const enc = value => Buffer.from(JSON.stringify(value)).toString("base64url");
    const issued = Math.floor(Date.now() / 1000);
    const unsigned = `${enc({ alg: "HS256", typ: "JWT" })}.${enc({ sub: admin.id, role: "ADMIN", type: "access", authVersion: admin.authVersion, iat: issued, exp: issued + 300 })}`;
    const token = `${unsigned}.${crypto.createHmac("sha256", process.env.JWT_SECRET).update(unsigned).digest("base64url")}`;
    const get = async path => {
      const response = await fetch(`http://127.0.0.1:4000/api${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(120000) });
      if (!response.ok) fail(`HTTP_${response.status}`);
      return response.json();
    };
    const health = await get("/health");
    const ready = await get("/health/ready");
    const detail = await get(`/loyalty-base/ours/agencies/${TARGET}`);
    if (detail.item?.id !== TARGET) fail("TARGET_MISMATCH");
    const snapshot = target?.amoCompanySync;
    const item = detail.item;
    console.log("AGENCY_NIGHTLY_AUDIT_RESULT " + JSON.stringify({
      checkedAt: now.toISOString(), todayMoscow, deployedSha: process.env.GIT_SHA,
      health: { deployedSha: health.deployedSha, status: health.status, readiness: ready.status, postgresql: ready.checks?.postgresql, redis: ready.checks?.redis },
      schedule: { timeMoscow: "01:00", enabled: !/^(0|false|off)$/i.test(String(process.env.AMO_AGENCY_COMPANY_SYNC_ENABLED || "").trim()) },
      runs: runs.map(run => ({ id: run.id, status: run.status, ruleVersion: run.ruleVersion, startedAt: iso(run.startedAt), completedAt: iso(run.completedAt), errorCode: run.errorCode, counts: safeCounts(run.counts) })),
      scope: { agencies: agencies.length, validInn: agencies.filter(row => /^(\d{10}|\d{12})$/.test(String(row.inn || "").replace(/\D/g, ""))).length, snapshots: snapshots.length, missingSnapshots: Math.max(0, agencies.length - snapshots.length), freshness: bucket, linkStatuses: links, errorCodes, attemptedToday, succeededToday, oldestSuccessAt: successfulDates[0] || null, newestSuccessAt: successfulDates.at(-1) || null },
      state,
      target: { id: TARGET, found: Boolean(target), brokerCountLocal: target?._count?.brokerAgencies, snapshot: snapshot ? { linkStatus: snapshot.linkStatus, freshness: freshness(snapshot, now), lastAttemptAt: iso(snapshot.lastAttemptAt), lastSuccessAt: iso(snapshot.lastSuccessAt), sourceUpdatedAt: iso(snapshot.sourceUpdatedAt), errorCode: snapshot.errorCode, companyCount: Array.isArray(snapshot.companyIds) ? snapshot.companyIds.length : 0, lastContractDate: snapshot.profile?.lastContractDate || null, websitePresent: Boolean(snapshot.profile?.website), conflictFields: Object.keys(snapshot.conflicts || {}), contracts: Array.isArray(snapshot.contracts) ? snapshot.contracts.length : 0 } : null, http: { sourceStatus: item.sourceFreshness?.status, lastSuccessAt: item.sourceFreshness?.lastSuccessAt, brokerCount: item.attributes?.brokerCount, activeBrokers: item.attributes?.activeBrokers, activeBrokerWindowDays: item.attributes?.activeBrokerWindowDays, lastContractDate: item.attributes?.lastContractDate, websitePresent: Boolean(item.attributes?.website) } },
      businessWrites: 0, syncTriggered: false,
    }));
  } finally { await prisma.$disconnect(); }
}
const keepAlive = setInterval(() => {}, 1000);
main().catch(error => { console.error("AGENCY_NIGHTLY_AUDIT_FAILED " + (error.safeCode || /^[A-Z0-9_]+$/.test(error.code || "") && error.code || "UNEXPECTED")); process.exitCode = 1; }).finally(() => clearInterval(keepAlive));
