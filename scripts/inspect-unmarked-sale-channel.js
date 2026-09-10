#!/usr/bin/env node
/**
 * 2026-09-10: строки реестра ДДУ, у которых не определён канал продажи
 * (sale_channel IS NULL). Печатает их списком, чтобы сопоставить с
 * гугл-таблицей реестра (комиссия брокера, источник обращения) локально.
 * Только чтение.
 */
async function main() {
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.registryDeal.findMany({
      where: { saleChannel: null },
      select: {
        contractNumber: true, project: true, source: true, agencyNameRaw: true,
        agencyCanonical: true, brokerId: true, amoLeadId: true, paidAt: true, amount: true,
      },
      orderBy: [{ project: "asc" }, { contractNumber: "asc" }],
    });
    console.log(`Строк без канала продажи: ${rows.length}`);
    console.log("  проект | № договора | источник строки | агентство | брокер | лид amo | дата оплаты | сумма");
    for (const r of rows) {
      console.log(
        `  ROW\t${r.project || "—"}\t${r.contractNumber}\t${r.source}\t${r.agencyNameRaw || r.agencyCanonical || "—"}\t` +
        `${r.brokerId ? "есть" : "—"}\t${r.amoLeadId ?? "—"}\t${r.paidAt ? new Date(r.paidAt).toISOString().slice(0, 10) : "—"}\t${r.amount ?? "—"}`,
      );
    }
    const paid = rows.filter((r) => r.paidAt).length;
    console.log(`\nИз них с датой оплаты ДДУ (то есть настоящие сделки): ${paid}`);
    console.log(`Со связкой с amoCRM: ${rows.filter((r) => r.amoLeadId !== null && r.amoLeadId !== undefined).length}`);
    console.log(`С агентством в строке: ${rows.filter((r) => r.agencyNameRaw || r.agencyCanonical).length}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error("FATAL:", e?.stack || e?.message || e);
  process.exit(1);
});
