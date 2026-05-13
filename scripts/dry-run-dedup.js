#!/usr/bin/env node
/**
 * DRY-RUN дедупликации сделок. НИЧЕГО НЕ УДАЛЯЕТ — только выводит план действий.
 *
 * Логика та же что в amocrm.service.ts post-fix дедупа: группируем Deal'ы по
 * "корневой" сделке (через amoParentDealId/amoDealId связь) и для каждой группы
 * с >1 элементом выбираем что оставить и что удалить.
 *
 * Запуск:
 *   BROKER_ID=<uuid> node /app/scripts/dry-run-dedup.js  (для одного брокера)
 *   node /app/scripts/dry-run-dedup.js                   (для всех активных брокеров)
 *
 * Через workflow: task=dry-run-dedup
 */

let PrismaClient;
try {
  ({ PrismaClient } = require('@prisma/client'));
} catch (_) {
  ({ PrismaClient } = require('../packages/database/node_modules/@prisma/client'));
}

const STATUS_RANK = { CANCELLED: -1, PENDING: 0, SIGNED: 1, PAID: 2, COMMISSION_PAID: 3 };

async function analyzeBroker(prisma, brokerId, brokerName) {
  const deals = await prisma.deal.findMany({
    where: { brokerId },
    select: {
      id: true, amoDealId: true, amoParentDealId: true,
      project: true, amount: true, sqm: true,
      commissionRate: true, commissionAmount: true,
      status: true, signedAt: true, createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
  });
  if (deals.length === 0) return 0;

  // Точная логика соответствует amocrm.service.ts post-fix dedup:
  //   - Deal A и B группируются ТОЛЬКО если:
  //     a) A.amoDealId == B.amoDealId (дубликат по самому ID)
  //     b) A.amoDealId == B.amoParentDealId (A — parent for B)
  //     c) A.amoParentDealId == B.amoDealId (B — parent for A)
  //     d) A.amoParentDealId == B.amoParentDealId (оба child одного parent)
  // Транзитивные цепочки НЕ строим — это слишком жадно (даст ложные группы).
  function related(a, b) {
    const aD = a.amoDealId ? String(a.amoDealId) : null;
    const bD = b.amoDealId ? String(b.amoDealId) : null;
    const aP = a.amoParentDealId ? String(a.amoParentDealId) : null;
    const bP = b.amoParentDealId ? String(b.amoParentDealId) : null;
    if (aD && bD && aD === bD) return true;       // одинаковый amoDealId
    if (aD && bP && aD === bP) return true;       // A parent B
    if (aP && bD && aP === bD) return true;       // B parent A
    if (aP && bP && aP === bP) return true;       // siblings
    return false;
  }

  const finalGroups = new Map();
  const seen = new Set();
  for (const d of deals) {
    if (seen.has(d.id)) continue;
    seen.add(d.id);
    const groupKey = String(d.amoParentDealId || d.amoDealId || d.id);
    const collected = [d];
    // Только один проход — без транзитивных связей.
    for (const other of deals) {
      if (seen.has(other.id)) continue;
      if (related(d, other)) {
        collected.push(other);
        seen.add(other.id);
      }
    }
    finalGroups.set(groupKey, collected);
  }

  let dups = 0;
  let printed = false;
  for (const [key, group] of finalGroups) {
    if (group.length <= 1) continue;
    if (!printed) {
      console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`Broker: ${brokerName} (${brokerId})`);
      printed = true;
    }
    console.log(`\nГруппа root=${key} (${group.length} Deal):`);
    for (const d of group) {
      console.log(`  · id=${d.id.slice(0, 8)} amo=${d.amoDealId} parent=${d.amoParentDealId || '-'}  proj=${d.project} amount=${d.amount} sqm=${d.sqm} status=${d.status}`);
    }
    // Выбираем кого оставить:
    //   1. наибольший sqm (есть данные из child-карточки)
    //   2. при равном — финальный статус
    //   3. самый ранний (createdAt asc)
    const sorted = [...group].sort((a, b) => {
      const sqmDiff = Number(b.sqm || 0) - Number(a.sqm || 0);
      if (sqmDiff !== 0) return sqmDiff;
      const sDiff = (STATUS_RANK[b.status] || 0) - (STATUS_RANK[a.status] || 0);
      if (sDiff !== 0) return sDiff;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });
    const keep = sorted[0];
    const remove = sorted.slice(1);
    console.log(`  ✓ KEEP   id=${keep.id.slice(0, 8)} (sqm=${keep.sqm}, status=${keep.status})`);
    for (const d of remove) {
      console.log(`  ✗ DELETE id=${d.id.slice(0, 8)} (sqm=${d.sqm}, status=${d.status})`);
      dups++;
    }
  }
  return dups;
}

(async () => {
  const prisma = new PrismaClient();
  const brokerIdEnv = process.env.BROKER_ID;
  console.log('═══════════════════════════════════');
  console.log('DRY-RUN DEDUP — ничего не удаляет');
  console.log('═══════════════════════════════════');
  let total = 0;
  if (brokerIdEnv) {
    const b = await prisma.broker.findUnique({ where: { id: brokerIdEnv }, select: { id: true, fullName: true } });
    if (!b) {
      console.log('Broker not found');
      process.exit(1);
    }
    total += await analyzeBroker(prisma, b.id, b.fullName);
  } else {
    const brokers = await prisma.broker.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, fullName: true },
    });
    console.log(`Анализирую ${brokers.length} активных брокеров...`);
    for (const b of brokers) {
      total += await analyzeBroker(prisma, b.id, b.fullName);
    }
  }
  console.log(`\n═══════════════════════════════════`);
  console.log(`ИТОГО к удалению: ${total} Deal'ов`);
  console.log(`БД не изменена.`);
  console.log(`═══════════════════════════════════`);
  await prisma.$disconnect();
})().catch((e) => {
  console.error('Error:', e?.message || e);
  process.exit(1);
});
