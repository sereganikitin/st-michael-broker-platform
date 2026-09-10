#!/usr/bin/env node
/**
 * 2026-09-09 (владелец: «всех прочекал, это все прямые»): пометка канала продажи
 * в реестре. Файл /app/registry-direct-sales.json ({contracts:[{contractNumber,
 * project, basis}]}) → registry_deals.sale_channel = 'DIRECT' для строк с тем же
 * проектом и нормализованным номером договора (contractKey из
 * apply-registry-deal-links.js) и БЕЗ брокера. Строки с брокером в списке —
 * пропуск с отчётом. WITH_BROKER=1 (по умолчанию) дополнительно ставит 'BROKER'
 * всем строкам с broker_id и пустым каналом. DRY_RUN=1 по умолчанию.
 *
 * 2026-09-10: у элемента списка может быть своё поле saleChannel ('DIRECT' |
 * 'BROKER'); без него по-прежнему DIRECT. Записи с saleChannel='BROKER'
 * помечают строку BROKER независимо от того, привязан ли брокер — так
 * размечаются сделки, где брокер известен только по гугл-таблице (комиссия
 * или название агентства). Меняется ТОЛЬКО пустой канал.
 */
const fs = require("node:fs");
const { contractKey } = require("./apply-registry-deal-links");

async function main() {
  const dryRun = process.env.DRY_RUN !== "0";
  const withBroker = process.env.WITH_BROKER !== "0";
  const file = process.argv[2] || "/app/registry-direct-sales.json";
  const payload = JSON.parse(fs.readFileSync(file, "utf8"));
  const contracts = Array.isArray(payload.contracts) ? payload.contracts : [];
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    console.log(`=== Режим: ${dryRun ? "DRY-RUN" : "APPLY"} · договоров в списке: ${contracts.length} · WITH_BROKER=${withBroker ? 1 : 0} ===`);
    const rows = await prisma.registryDeal.findMany({ select: { id: true, contractNumber: true, project: true, brokerId: true, saleChannel: true, paidAt: true } });
    const index = new Map();
    for (const r of rows) {
      const key = `${r.project || ""}|${contractKey(r.contractNumber)}`;
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(r);
    }
    const stats = { matched: 0, toDirect: 0, alreadyDirect: 0, hasBroker: 0, notFound: 0, multi: 0, toBroker: 0, toBrokerFromList: 0, alreadyMarked: 0 };
    const directIds = [];
    const brokerFromList = [];
    const notFound = [];
    for (const c of contracts) {
      const key = `${c.project || ""}|${contractKey(c.contractNumber)}`;
      const found = index.get(key) || [];
      if (!found.length) { stats.notFound++; notFound.push(c.contractNumber); continue; }
      if (found.length > 1) stats.multi++;
      const wanted = c.saleChannel === "BROKER" ? "BROKER" : "DIRECT";
      for (const r of found) {
        stats.matched++;
        if (wanted === "BROKER") {
          if (r.saleChannel) { stats.alreadyMarked++; continue; }
          brokerFromList.push(r.id);
          stats.toBrokerFromList++;
          continue;
        }
        if (r.brokerId) { stats.hasBroker++; continue; }
        if (r.saleChannel === "DIRECT") { stats.alreadyDirect++; continue; }
        directIds.push(r.id);
        stats.toDirect++;
      }
    }
    const brokerIds = withBroker ? rows.filter((r) => r.brokerId && !r.saleChannel).map((r) => r.id) : [];
    stats.toBroker = brokerIds.length;
    for (const id of brokerFromList) if (!brokerIds.includes(id)) brokerIds.push(id);
    console.log("Статистика:", JSON.stringify(stats));
    if (notFound.length) console.log(`Не найдены в реестре (${notFound.length}): ${notFound.slice(0, 20).join(", ")}${notFound.length > 20 ? " …" : ""}`);
    const paidDirect = rows.filter((r) => directIds.includes(r.id) && r.paidAt).length;
    console.log(`К пометке DIRECT: ${directIds.length} (с датой оплаты ДДУ ${paidDirect}); к пометке BROKER: ${brokerIds.length}`);
    if (dryRun) { console.log("DRY-RUN: изменений нет"); return; }
    let updated = 0;
    for (let i = 0; i < directIds.length; i += 200) {
      const batch = directIds.slice(i, i + 200);
      const res = await prisma.registryDeal.updateMany({ where: { id: { in: batch }, brokerId: null }, data: { saleChannel: "DIRECT" } });
      updated += res.count;
    }
    let updatedBroker = 0;
    for (let i = 0; i < brokerIds.length; i += 200) {
      const batch = brokerIds.slice(i, i + 200);
      const res = await prisma.registryDeal.updateMany({ where: { id: { in: batch }, saleChannel: null }, data: { saleChannel: "BROKER" } });
      updatedBroker += res.count;
    }
    const totals = await prisma.registryDeal.groupBy({ by: ["saleChannel"], _count: { _all: true } });
    console.log(`Записано: DIRECT ${updated}, BROKER ${updatedBroker}. Итог по каналам: ${totals.map((t) => `${t.saleChannel || "не определён"}=${t._count._all}`).join(", ")}`);
    console.log(`RESULT ${JSON.stringify({ direct: updated, broker: updatedBroker, stats })}`);
  } finally { await prisma.$disconnect(); }
}
main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
