#!/usr/bin/env node
/**
 * 2026-09-10 (владелец: «фильтр дат ничего не меняет, а „нет сделок“ даёт
 * ноль — проверь по базе»): считаем те же числа напрямую из таблиц, чтобы
 * сверить с тем, что показывает список базы лояльности.
 *   1) сколько брокеров без сделок, в том числе с фиксациями и встречами;
 *   2) сколько брокеров звонили в разные периоды 2026 года — меняется ли
 *      выборка при сдвиге дат.
 * Только чтение.
 */
const PERIODS = [
  ["01.01.2026 — 10.09.2026", "2026-01-01", "2026-09-10"],
  ["01.03.2026 — 10.09.2026", "2026-03-01", "2026-09-10"],
  ["01.06.2026 — 10.09.2026", "2026-06-01", "2026-09-10"],
  ["01.08.2026 — 10.09.2026", "2026-08-01", "2026-09-10"],
  ["01.09.2026 — 10.09.2026", "2026-09-01", "2026-09-10"],
];

function table(title, rows) {
  console.log(`\n=== ${title} ===`);
  for (const [label, value, note] of rows) {
    console.log(`  ${String(label).padEnd(56)} ${String(value).padStart(7)}${note ? "  · " + note : ""}`);
  }
}

async function main() {
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    const brokerWhere = { mergedIntoId: null };
    const total = await prisma.broker.count({ where: brokerWhere });

    const dealGroups = await prisma.deal.groupBy({ by: ["brokerId"], _count: { _all: true } });
    const registryGroups = await prisma.registryDeal.groupBy({
      by: ["brokerId"],
      where: { brokerId: { not: null } },
      _count: { _all: true },
    });
    const meetingGroups = await prisma.meeting.groupBy({
      by: ["brokerId"],
      where: { status: { in: ["CONFIRMED", "COMPLETED"] }, type: { not: "BROKER_TOUR" } },
      _count: { _all: true },
    });
    const clientGroups = await prisma.client.groupBy({ by: ["brokerId"], _count: { _all: true } });

    const withDeals = new Set();
    for (const g of dealGroups) if (g.brokerId) withDeals.add(String(g.brokerId));
    for (const g of registryGroups) if (g.brokerId) withDeals.add(String(g.brokerId));
    const withMeetings = new Set(meetingGroups.filter((g) => g.brokerId).map((g) => String(g.brokerId)));
    const withFixations = new Set(clientGroups.filter((g) => g.brokerId).map((g) => String(g.brokerId)));

    const ids = (await prisma.broker.findMany({ where: brokerWhere, select: { id: true } })).map((b) => String(b.id));
    const noDeals = ids.filter((id) => !withDeals.has(id));
    const noDealsWithFix = noDeals.filter((id) => withFixations.has(id));
    const noDealsWithMeetings = noDeals.filter((id) => withMeetings.has(id));
    const noDealsWithBoth = noDeals.filter((id) => withFixations.has(id) && withMeetings.has(id));

    table("1. Сделки у брокеров нашей базы", [
      ["Брокеров всего (без объединённых)", total],
      ["С хотя бы одной сделкой (кабинет + реестр)", withDeals.size],
      ["БЕЗ сделок", noDeals.length, "фильтр «Нет сделок» должен показывать столько"],
      ["  из них с фиксациями", noDealsWithFix.length],
      ["  из них со встречами", noDealsWithMeetings.length],
      ["  из них и с фиксациями, и со встречами", noDealsWithBoth.length, "случай владельца"],
    ]);

    console.log("\n  примеры брокеров с фиксациями и встречами, но без сделок:");
    for (const id of noDealsWithBoth.slice(0, 8)) {
      const b = await prisma.broker.findUnique({ where: { id }, select: { fullName: true, phone: true } });
      console.log(`    ${id} · ${b?.fullName || "—"}`);
    }

    const rows = [];
    for (const [label, from, to] of PERIODS) {
      const where = { createdAt: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T23:59:59Z`) } };
      const calls = await prisma.callLog.count({ where });
      const groups = await prisma.callLog.groupBy({ by: ["brokerId"], where, _count: { _all: true } });
      const brokers = new Set(groups.filter((g) => g.brokerId).map((g) => String(g.brokerId)));
      rows.push([label, brokers.size, `звонков ${calls}`]);
    }
    table("2. Звонки по периодам: сколько брокеров звонили", rows);

    const first = await prisma.callLog.findFirst({ orderBy: { createdAt: "asc" }, select: { createdAt: true } });
    const last = await prisma.callLog.findFirst({ orderBy: { createdAt: "desc" }, select: { createdAt: true } });
    const totalCalls = await prisma.callLog.count();
    table("3. Журнал звонков целиком", [
      ["Записей о звонках", totalCalls],
      ["Первый звонок", first?.createdAt ? new Date(first.createdAt).toISOString().slice(0, 10) : "—"],
      ["Последний звонок", last?.createdAt ? new Date(last.createdAt).toISOString().slice(0, 10) : "—"],
    ]);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error("FATAL:", e?.stack || e?.message || e);
  process.exit(1);
});
