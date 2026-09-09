#!/usr/bin/env node
/**
 * 2026-09-09 (v2): QA после поезда 41b — сводка без фильтров даёт deals 2 / 16.1M,
 * обзор — deals 3 / 92.3M за 30 дней. Вызываем оба эндпоинта через API с ОДНИМ
 * периодом (как QA) и печатаем точные метки времени спорных строк реестра,
 * состав выборки сводки и результат при разных границах периода. Только чтение.
 */
const crypto = require("node:crypto");
const API_BASE = `http://localhost:${process.env.API_PORT || 4000}/api`;
const b64url = (input) => Buffer.from(input).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
function signJwt(payload, secret) {
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 900 }));
  const data = `${head}.${body}`;
  return `${data}.${b64url(crypto.createHmac("sha256", secret).update(data).digest())}`;
}
async function main() {
  const { PrismaClient } = require("@st-michael/database"); const prisma = new PrismaClient();
  try {
    const to = new Date(); const from = new Date(to.getTime() - 30 * 86400000);
    const reg = await prisma.registryDeal.findMany({ where: { OR: [{ paidAt: { gte: new Date(from.getTime() - 3 * 86400000), lte: to } }, { dvouPaidAt: { gte: from, lte: to } }] }, select: { id: true, contractNumber: true, brokerId: true, amount: true, paidAt: true, dvouPaidAt: true, signedAt: true, agencyCanonical: true, agencyNameRaw: true, broker: { select: { role: true, mergedIntoId: true, status: true, fullName: true } } } });
    console.log(`Период QA: ${from.toISOString()} — ${to.toISOString()}`);
    console.log(`Реестр (paidAt за 33 дн. или dvouPaidAt за 30 дн.): ${reg.length}`);
    for (const r of reg) console.log(`  ${r.contractNumber} broker=${r.brokerId ? r.brokerId.slice(0, 8) : "—"} ${r.broker ? `${r.broker.role}/${r.broker.status}/merged=${r.broker.mergedIntoId ? "yes" : "no"}` : ""} amount=${r.amount} paidAt=${r.paidAt?.toISOString()} dvou=${r.dvouPaidAt?.toISOString()} signed=${r.signedAt?.toISOString()} inQA=${r.paidAt && r.paidAt >= from && r.paidAt <= to}`);
    const secret = process.env.JWT_SECRET; if (!secret) throw new Error("нет JWT_SECRET");
    const admin = await prisma.broker.findFirst({ where: { role: "ADMIN" }, select: { id: true, phone: true }, orderBy: { createdAt: "asc" } });
    const token = signJwt({ sub: admin.id, phone: admin.phone, role: "ADMIN" }, secret);
    const http = async (method, path, body) => { const res = await fetch(`${API_BASE}${path}`, { method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined }); const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {} return { status: res.status, body: json, text }; };
    const period = { from: from.toISOString(), to: to.toISOString() };
    const ov = await http("GET", `/loyalty-base/ours/overview?from=${encodeURIComponent(period.from)}&to=${encodeURIComponent(period.to)}`);
    console.log(`Обзор HTTP ${ov.status}: period=${JSON.stringify(ov.body?.period)} activities=${JSON.stringify(ov.body?.activities)} dealAmount=${ov.body?.dealAmount} meta.registry=${JSON.stringify(ov.body?.kpiMetadata?.["activities.deals"]?.details || ov.body?.activities?.registry || null)}`);
    const summary = async (label, body) => { const t0 = Date.now(); const s = await http("POST", `/loyalty-base/ours/brokers/activity-summary`, { page: 1, pageSize: 1, archived: "exclude", sortBy: "name", sortOrder: "asc", filter: {}, columns: {}, summaryPeriod: period, ...body }); console.log(`Сводка [${label}] HTTP ${s.status} ${Date.now() - t0} мс: period=${JSON.stringify(s.body?.period)} selection=${JSON.stringify(s.body?.selection)} activities=${JSON.stringify(s.body?.activities)} dealAmount=${s.body?.dealAmount}${s.status >= 400 ? " " + s.text.slice(0, 300) : ""}`); return s; };
    await summary("как QA", {});
    await summary("archived=include", { archived: "include" });
    const brokerIds = [...new Set(reg.map((r) => r.brokerId).filter(Boolean))];
    for (const id of brokerIds) {
      const b = await prisma.broker.findUnique({ where: { id }, select: { id: true, fullName: true, role: true, status: true, mergedIntoId: true, phone: true } });
      const s = await http("POST", `/loyalty-base/ours/brokers/search`, { page: 1, pageSize: 5, archived: "exclude", sortBy: "name", sortOrder: "asc", filter: { search: b.phone || b.fullName }, columns: {} });
      const found = (s.body?.items || []).find((i) => i.id === id);
      console.log(`Брокер ${id.slice(0, 8)} «${b.fullName}» ${b.role}/${b.status}: в списке (поиск по телефону) — ${found ? "да" : "НЕТ"}; metrics.deals=${found?.metrics?.deals} dealAmount=${found?.metrics?.dealAmount}`);
      await summary(`только брокер ${id.slice(0, 8)}`, { filter: { search: b.phone || b.fullName } });
    }
  } finally { await prisma.$disconnect(); }
}
main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
