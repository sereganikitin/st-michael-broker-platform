#!/usr/bin/env node
/**
 * 2026-09-09: QA после поезда 41b — сводка без фильтров даёт deals 2 / 16.1M,
 * обзор — deals 3 / 92.3M за 30 дней. Смотрим все сделки периода (Deal и
 * реестр) и почему одна не попадает в выборку списка. Только чтение.
 */
async function main() {
  const { PrismaClient } = require("@st-michael/database"); const prisma = new PrismaClient();
  try {
    const to = new Date(); const from = new Date(to.getTime() - 30 * 86400000);
    const deals = await prisma.deal.findMany({ where: { contractType: "DDU", amount: { gt: 0 }, status: { in: ["SIGNED", "PAID", "COMMISSION_PAID"] }, signedAt: { gte: from, lte: to } }, select: { id: true, brokerId: true, amount: true, signedAt: true, broker: { select: { role: true, mergedIntoId: true, status: true, fullName: true } } } });
    console.log(`Deal (кабинет) за 30 дн.: ${deals.length}`);
    for (const d of deals) console.log(`  deal ${d.id.slice(0, 8)} broker ${d.brokerId?.slice(0, 8)} ${d.broker?.role}/${d.broker?.status}/merged=${d.broker?.mergedIntoId ? "yes" : "no"} amount=${d.amount} signed=${d.signedAt?.toISOString().slice(0, 10)}`);
    const reg = await prisma.registryDeal.findMany({ where: { paidAt: { gte: from, lte: to } }, select: { id: true, contractNumber: true, brokerId: true, amount: true, paidAt: true, broker: { select: { role: true, mergedIntoId: true, status: true, fullName: true, createdAt: true } } } });
    console.log(`Реестр (paidAt) за 30 дн.: ${reg.length}`);
    for (const r of reg) console.log(`  ${r.contractNumber} broker=${r.brokerId ? r.brokerId.slice(0, 8) : "—"} ${r.broker ? `${r.broker.role}/${r.broker.status}/merged=${r.broker.mergedIntoId ? "yes" : "no"}/created=${r.broker.createdAt.toISOString().slice(0, 10)}` : ""} amount=${r.amount} paid=${r.paidAt?.toISOString().slice(0, 10)}`);
    const brokerIds = [...new Set([...deals.map((d) => d.brokerId), ...reg.map((r) => r.brokerId)].filter(Boolean))];
    const inList = await prisma.broker.findMany({ where: { id: { in: brokerIds }, role: "BROKER", mergedIntoId: null }, select: { id: true } });
    const inSet = new Set(inList.map((b) => b.id));
    console.log(`Брокеров со сделками: ${brokerIds.length}; из них в выборке списка (role BROKER, не объединены): ${inSet.size}; вне: ${brokerIds.filter((id) => !inSet.has(id)).map((id) => id.slice(0, 8)).join(", ") || "—"}`);
  } finally { await prisma.$disconnect(); }
}
main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
