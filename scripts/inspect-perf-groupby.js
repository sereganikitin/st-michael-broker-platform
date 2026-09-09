#!/usr/bin/env node
/**
 * 2026-09-09: после поезда 43 холодный список стал 44–54 с (было 19–28 с).
 * Меряем по отдельности размеры таблиц и время каждого groupBy из
 * attachOurBrokerLifetimeAggregates / ourActivityAggregates. Только чтение.
 */
async function main() {
  const { PrismaClient } = require("@st-michael/database"); const prisma = new PrismaClient();
  const t = async (label, fn) => { const s = Date.now(); try { const r = await fn(); const n = Array.isArray(r) ? r.length : (typeof r === "number" ? r : JSON.stringify(r).length); console.log(`${String(Date.now() - s).padStart(6)} мс | ${label} | ${n}`); } catch (e) { console.log(`   ERR | ${label} | ${String(e.message).slice(0, 120)}`); } };
  try {
    for (const tbl of ["clients", "meetings", "deals", "call_logs", "registry_deals", "brokers", "loyalty_call_attempts", "loyalty_engagement_events"]) {
      await t(`count ${tbl}`, async () => Number((await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM ${tbl}`))[0].n));
    }
    const FIX = { OR: [{ fixationStatus: { in: ["FIXED", "EXPIRED"] } }, { uniquenessStatus: { in: ["CONDITIONALLY_UNIQUE", "EXPIRED"] } }] };
    await t("client.groupBy lifetime (fixation where, _count,_max)", () => prisma.client.groupBy({ by: ["brokerId"], where: FIX, _count: { _all: true }, _max: { createdAt: true } }));
    await t("meeting.groupBy lifetime", () => prisma.meeting.groupBy({ by: ["brokerId"], where: { status: { in: ["CONFIRMED", "COMPLETED"] }, type: { not: "BROKER_TOUR" } }, _count: { _all: true }, _max: { date: true } }));
    await t("deal.groupBy lifetime", () => prisma.deal.groupBy({ by: ["brokerId"], where: { contractType: "DDU", amount: { gt: 0 }, status: { in: ["SIGNED", "PAID", "COMMISSION_PAID"] }, signedAt: { not: null } }, _count: { _all: true }, _max: { signedAt: true } }));
    await t("callLog.groupBy lifetime (вся таблица)", () => prisma.callLog.groupBy({ by: ["brokerId"], _count: { _all: true }, _max: { createdAt: true } }));
    await t("registryDeal.groupBy lifetime", () => prisma.registryDeal.groupBy({ by: ["brokerId"], where: { paidAt: { not: null } }, _count: { _all: true }, _max: { paidAt: true } }));
    const to = new Date(); const from = new Date(to.getTime() - 30 * 86400000);
    await t("client.groupBy период", () => prisma.client.groupBy({ by: ["brokerId"], where: { ...FIX, createdAt: { gte: from, lte: to } }, _count: { _all: true } }));
    await t("meeting.groupBy период", () => prisma.meeting.groupBy({ by: ["brokerId"], where: { status: { in: ["CONFIRMED", "COMPLETED"] }, type: { not: "BROKER_TOUR" }, date: { gte: from, lte: to } }, _count: { _all: true } }));
    await t("deal.groupBy период", () => prisma.deal.groupBy({ by: ["brokerId"], where: { contractType: "DDU", amount: { gt: 0 }, status: { in: ["SIGNED", "PAID", "COMMISSION_PAID"] }, signedAt: { gte: from, lte: to } }, _count: { _all: true }, _sum: { amount: true } }));
    const ids = (await prisma.broker.findMany({ where: { role: "BROKER", mergedIntoId: null }, select: { id: true } })).map((b) => b.id);
    await t(`broker.findMany плоский (${ids.length})`, () => prisma.broker.findMany({ where: { role: "BROKER" }, select: { id: true, fullName: true, phone: true, phones: true, brokerAgencies: { include: { agency: true } }, callLogs: { orderBy: { createdAt: "desc" }, take: 1, select: { createdAt: true, campaign: true, result: true } } } }));
    const batch = ids.slice(0, 500);
    await t("callLog.groupBy пачка 500 (in)", () => prisma.callLog.groupBy({ by: ["brokerId"], where: { brokerId: { in: batch } }, _count: { _all: true }, _max: { createdAt: true } }));
    await t("client.count пачка 500 период", () => prisma.client.count({ where: { brokerId: { in: batch }, ...FIX, createdAt: { gte: from, lte: to } } }));
    await t("loyaltyCallAttempt.findMany все (workflowCallReadModels)", () => prisma.loyaltyCallAttempt.findMany({ where: { assignment: { ourBrokerId: { in: ids } } }, select: { id: true } }));
    await t("loyaltyEngagementEvent.findMany все", () => prisma.loyaltyEngagementEvent.findMany({ where: { ourBrokerId: { in: ids } }, select: { id: true } }));
  } finally { await prisma.$disconnect(); }
}
main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
