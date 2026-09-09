#!/usr/bin/env node
/**
 * 2026-09-09: профиль холодного и тёплого запроса списка «наша база» внутри
 * контейнера api: строим LoyaltyBaseService напрямую из dist (как в spec —
 * только prisma), оборачиваем методы таймерами и вызываем list() дважды.
 * Только чтение; ничего не пишет.
 */
const fs = require("node:fs");
const { execSync } = require("node:child_process");

function findDist() {
  const candidates = [
    "/app/apps/api/dist/src/loyalty-base/loyalty-base.service.js",
    "/app/apps/api/dist/loyalty-base/loyalty-base.service.js",
    "/app/dist/apps/api/src/loyalty-base/loyalty-base.service.js",
    "/app/dist/src/loyalty-base/loyalty-base.service.js",
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  try {
    const out = execSync('find /app -name "loyalty-base.service.js" -not -path "*/node_modules/*" 2>/dev/null | head -3', { encoding: "utf8" }).trim();
    console.log("найдено:", out || "(ничего)");
    return out.split("\n")[0] || null;
  } catch { return null; }
}

async function main() {
  const servicePath = findDist();
  if (!servicePath) throw new Error("dist сервиса не найден");
  console.log("сервис:", servicePath);
  const dtoPath = servicePath.replace("loyalty-base.service.js", "loyalty-base.dto.js");
  const { LoyaltyBaseService } = require(servicePath);
  const { LoyaltyListQueryDto } = require(dtoPath);
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  const service = new LoyaltyBaseService(prisma);

  const totals = new Map();
  const counts = new Map();
  const wrap = (name) => {
    const proto = Object.getPrototypeOf(service);
    const original = proto[name];
    if (typeof original !== "function") { console.log("нет метода", name); return; }
    service[name] = function (...args) {
      const started = process.hrtime.bigint();
      const done = () => {
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        totals.set(name, (totals.get(name) || 0) + ms);
        counts.set(name, (counts.get(name) || 0) + 1);
      };
      const result = original.apply(this, args);
      if (result && typeof result.then === "function") return result.finally(done);
      done();
      return result;
    };
  };
  for (const name of [
    "listOurBrokers", "ourBrokerPeriodMetrics", "mapOurBroker", "matchesOurBroker", "sortLoyaltyCandidates",
    "attachOurDealAmounts", "attachOurLinkedAnna", "oursListEnvelope", "loyaltyFacets", "listActivitySummary",
    "ourActivityAggregates", "attachOurBrokerLifetimeAggregates", "attachOurBrokerRegistryDeals",
    "workflowCallReadModels", "engagementReadModels", "attachWorkflowCallReadModels", "attachEngagementReadModels",
    "normalizeListFilter", "assertFilterForEntity", "linkedAnnaTargetIds", "ourCalls", "ourBrokerStatusCodes",
    "ourDataQualityCodes", "ourLastCallLifetime", "listFilterHash",
  ]) wrap(name);

  const to = new Date(); const from = new Date(to.getTime() - 30 * 86400000);
  const makeQuery = () => Object.assign(new LoyaltyListQueryDto(), {
    page: 1, pageSize: 30, archived: "exclude", sortBy: "name", sortOrder: "asc",
    filter: {}, columns: {}, withActivitySummary: true, summaryPeriod: { from: from.toISOString(), to: to.toISOString() },
  });
  const report = (label, ms) => {
    console.log(`=== ${label}: всего ${Math.round(ms)} мс ===`);
    const rows = [...totals.entries()].sort((a, b) => b[1] - a[1]);
    for (const [name, total] of rows) console.log(`${String(Math.round(total)).padStart(7)} мс | ${String(counts.get(name)).padStart(6)} выз. | ${name}`);
    totals.clear(); counts.clear();
  };
  const mem = () => `rss ${Math.round(process.memoryUsage().rss / 1048576)} МБ, heap ${Math.round(process.memoryUsage().heapUsed / 1048576)} МБ`;
  console.log("память до:", mem());
  let started = Date.now();
  const first = await service.list("ours", "BROKER", makeQuery(), undefined, undefined, false);
  report(`холодный запрос (total ${first.total})`, Date.now() - started);
  console.log("память после холодного:", mem());
  started = Date.now();
  const second = await service.list("ours", "BROKER", makeQuery(), undefined, undefined, false);
  report(`тёплый запрос (кэш; total ${second.total})`, Date.now() - started);
  console.log("память после тёплого:", mem());
  await prisma.$disconnect();
}
main().catch((e) => { console.error("FATAL:", e?.stack || e?.message || e); process.exit(1); });
