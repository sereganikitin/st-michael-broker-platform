#!/usr/bin/env node
/**
 * 2026-09-10 (правило владельца: «имя не важно, главное чтобы номер был
 * сопоставлен»): проверяем именно сопоставление по номеру.
 *   1) у скольких карточек брокеров нет связи с amoCRM и важны ли они
 *      (есть ли у них фиксации, встречи, сделки, звонки);
 *   2) нет ли одного и того же номера на разных карточках — из-за разного
 *      написания (+7 / 8 / без кода) аналитика по номеру разъезжается;
 *   3) карточки вообще без номера — их сопоставить нечем.
 * Только чтение.
 */
const digits = (raw) => {
  const d = String(raw || "").replace(/\D/g, "");
  if (d.length === 11 && (d[0] === "7" || d[0] === "8")) return d.slice(1);
  if (d.length > 11) return d.slice(1, 11);
  return d;
};

function table(title, rows, total) {
  console.log(`\n=== ${title} ===`);
  for (const [label, value, note] of rows) {
    const share = total && typeof value === "number" ? `  ${Math.round((value / total) * 100)}%` : "";
    console.log(`  ${String(label).padEnd(54)} ${String(value).padStart(7)}${share}${note ? "  · " + note : ""}`);
  }
}

async function main() {
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    const brokers = await prisma.broker.findMany({
      where: { mergedIntoId: null },
      select: { id: true, fullName: true, displayName: true, phone: true, status: true, amoContactId: true, source: true, createdAt: true },
    });
    const total = brokers.length;
    const linked = brokers.filter((b) => b.amoContactId !== null && b.amoContactId !== undefined);
    const unlinked = brokers.filter((b) => b.amoContactId === null || b.amoContactId === undefined);

    const clientGroups = await prisma.client.groupBy({ by: ["brokerId"], _count: { _all: true } });
    const meetingGroups = await prisma.meeting.groupBy({ by: ["brokerId"], _count: { _all: true } });
    const dealGroups = await prisma.deal.groupBy({ by: ["brokerId"], _count: { _all: true } });
    const registryGroups = await prisma.registryDeal.groupBy({ by: ["brokerId"], where: { brokerId: { not: null } }, _count: { _all: true } });
    const callGroups = await prisma.callLog.groupBy({ by: ["brokerId"], _count: { _all: true } });
    const setOf = (groups) => new Set(groups.filter((g) => g.brokerId).map((g) => String(g.brokerId)));
    const withFix = setOf(clientGroups);
    const withMeet = setOf(meetingGroups);
    const withDeal = new Set([...setOf(dealGroups), ...setOf(registryGroups)]);
    const withCall = setOf(callGroups);
    const active = (id) => withFix.has(id) || withMeet.has(id) || withDeal.has(id) || withCall.has(id);

    table("1. Связь карточек брокеров с amoCRM", [
      ["Карточек всего (без объединённых)", total],
      ["Связаны с контактом amoCRM", linked.length],
      ["НЕ связаны", unlinked.length, "по ним аналитика из amo не подтянется"],
      ["  из них с фиксациями", unlinked.filter((b) => withFix.has(b.id)).length],
      ["  из них со встречами", unlinked.filter((b) => withMeet.has(b.id)).length],
      ["  из них со сделками", unlinked.filter((b) => withDeal.has(b.id)).length],
      ["  из них со звонками", unlinked.filter((b) => withCall.has(b.id)).length],
      ["  из них вообще без активности", unlinked.filter((b) => !active(b.id)).length, "спящие карточки"],
    ], total);

    const byStatus = new Map();
    const bySource = new Map();
    for (const b of unlinked) {
      byStatus.set(b.status || "—", (byStatus.get(b.status || "—") || 0) + 1);
      bySource.set(b.source || "—", (bySource.get(b.source || "—") || 0) + 1);
    }
    table("1б. Несвязанные карточки по статусу", [...byStatus.entries()].sort((a, b) => b[1] - a[1]), unlinked.length);
    table("1в. Несвязанные карточки по источнику", [...bySource.entries()].sort((a, b) => b[1] - a[1]), unlinked.length);

    console.log("\n  Несвязанные карточки С активностью — первые 20:");
    for (const b of unlinked.filter((x) => active(x.id)).slice(0, 20)) {
      console.log(
        `    ${b.id} · «${b.displayName || b.fullName}» · ${b.phone} · ${b.status} · фикс ${withFix.has(b.id) ? "да" : "—"} · встр ${withMeet.has(b.id) ? "да" : "—"} · сделки ${withDeal.has(b.id) ? "да" : "—"}`,
      );
    }

    // ---------- 2. один номер на разных карточках
    const extra = await prisma.brokerPhone.findMany({ select: { brokerId: true, phone: true } });
    const byKey = new Map();
    const push = (key, brokerId, where) => {
      if (!key) return;
      if (!byKey.has(key)) byKey.set(key, new Map());
      const owners = byKey.get(key);
      if (!owners.has(brokerId)) owners.set(brokerId, where);
    };
    for (const b of brokers) push(digits(b.phone), b.id, "основной");
    const brokerById = new Map(brokers.map((b) => [b.id, b]));
    for (const row of extra) if (brokerById.has(row.brokerId)) push(digits(row.phone), row.brokerId, "доп.");

    const collisions = [...byKey.entries()].filter(([, owners]) => owners.size > 1);
    table("2. Один и тот же номер на разных карточках", [
      ["Разных номеров всего", byKey.size],
      ["Номеров, встречающихся у разных карточек", collisions.length, "аналитика по такому номеру разъезжается"],
    ], byKey.size);
    for (const [key, owners] of collisions.slice(0, 15)) {
      const names = [...owners.entries()]
        .map(([id, where]) => `«${brokerById.get(id)?.displayName || brokerById.get(id)?.fullName}» (${where}, ${brokerById.get(id)?.status})`)
        .join(" | ");
      console.log(`    ${key}: ${names}`);
    }

    const noPhone = brokers.filter((b) => !digits(b.phone));
    table("3. Карточки без номера", [
      ["Без номера телефона", noPhone.length, "сопоставить нечем"],
      ["  из них с активностью", noPhone.filter((b) => active(b.id)).length],
    ], total);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error("FATAL:", e?.stack || e?.message || e);
  process.exit(1);
});
