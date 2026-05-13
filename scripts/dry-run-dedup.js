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

  // Группируем: ключ = amoParentDealId если есть, иначе amoDealId.
  const byRoot = new Map();
  for (const d of deals) {
    const root = String(d.amoParentDealId || d.amoDealId || d.id);
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push(d);
  }
  // Дополнительно — если есть Deal где amoDealId совпадает с чьим-то amoParentDealId,
  // соединяем их группы под меньшим ключом.
  const indexByAmoDealId = new Map();
  for (const d of deals) {
    if (d.amoDealId) indexByAmoDealId.set(String(d.amoDealId), d);
  }
  // Простое объединение: для каждого Deal с amoParentDealId — если parent в индексе,
  // соединяем группы.
  const finalGroups = new Map();
  const seen = new Set();
  for (const d of deals) {
    if (seen.has(d.id)) continue;
    let groupKey = String(d.amoParentDealId || d.amoDealId || d.id);
    const collected = [];
    const queue = [d];
    while (queue.length) {
      const cur = queue.shift();
      if (seen.has(cur.id)) continue;
      seen.add(cur.id);
      collected.push(cur);
      // Найти всех связанных
      for (const other of deals) {
        if (seen.has(other.id)) continue;
        const ids = [
          cur.amoDealId && String(cur.amoDealId),
          cur.amoParentDealId && String(cur.amoParentDealId),
          other.amoDealId && String(other.amoDealId),
          other.amoParentDealId && String(other.amoParentDealId),
        ].filter(Boolean);
        const sharing =
          ids.includes(String(other.amoDealId)) ||
          ids.includes(String(other.amoParentDealId));
        if (sharing) queue.push(other);
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
