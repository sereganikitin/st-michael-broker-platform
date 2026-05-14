#!/usr/bin/env node
/**
 * Печатает список ВСЕХ лидов из amoCRM для каждого ACTIVE-брокера в БД.
 * Колонки: leadId | название лида | pipeline_id | status_id | created_at.
 *
 * Помогает найти leadId для task=inspect-lead, когда удалённые из БД сделки
 * больше нельзя посмотреть в кабинете.
 *
 * Запуск через workflow: task=list-broker-leads
 */

(async () => {
  const { NestFactory } = require('@nestjs/core');
  let AppModule, AmocrmService, PrismaClient;
  try {
    ({ AppModule } = require('/app/apps/api/dist/app.module'));
    ({ AmocrmService } = require('/app/apps/api/dist/amocrm/amocrm.service'));
    ({ PrismaClient } = require('/app/packages/database/node_modules/@prisma/client'));
  } catch (e) {
    console.error('Cannot load modules:', e?.message);
    process.exit(1);
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  const prisma = app.get('PrismaClient', { strict: false });

  // Если не получилось через DI — создаём напрямую.
  let db;
  try {
    db = prisma || new PrismaClient();
  } catch (_) {
    db = new PrismaClient();
  }

  try {
    const brokers = await db.broker.findMany({
      where: { status: 'ACTIVE', amoContactId: { not: null } },
      select: { id: true, fullName: true, phone: true, amoContactId: true },
      orderBy: { fullName: 'asc' },
    });

    const amoSvc = app.get(AmocrmService);
    const { AmoCrmAdapter } = require('/app/packages/integrations/dist/amo-crm.adapter');
    const amo = new AmoCrmAdapter();

    for (const broker of brokers) {
      console.log(`\n═══════════════════════════════════`);
      console.log(`Брокер: ${broker.fullName}  (${broker.phone})  amoContactId=${broker.amoContactId}`);
      console.log(`───────────────────────────────────`);
      try {
        const fullContact = await amo.getContact(Number(broker.amoContactId));
        const linkedLeads = fullContact?._embedded?.leads || [];
        if (linkedLeads.length === 0) {
          console.log('  (нет лидов)');
          continue;
        }
        console.log(`leadId    | pipeline | status   | created_at          | name`);
        for (const leadRef of linkedLeads) {
          try {
            const lead = await amo.getLead(leadRef.id);
            if (!lead) {
              console.log(`${String(leadRef.id).padEnd(9)} | (lead not found)`);
              continue;
            }
            const created = lead.created_at ? new Date(lead.created_at * 1000).toISOString().slice(0, 10) : '—';
            const pip = String(lead.pipeline_id || '-').padEnd(8);
            const st = String(lead.status_id || '-').padEnd(8);
            const nm = String(lead.name || '').slice(0, 60);
            console.log(`${String(lead.id).padEnd(9)} | ${pip} | ${st} | ${created.padEnd(19)} | ${nm}`);
          } catch (e) {
            console.log(`${String(leadRef.id).padEnd(9)} | ERROR: ${e?.message}`);
          }
        }
      } catch (e) {
        console.log(`  ERROR fetching contact: ${e?.message}`);
      }
    }

    console.log(`\n═══════════════════════════════════`);
    console.log(`Pipelines reference:`);
    console.log(`  7600542 = КЦ (колл-центр) — у этих лидов Deal не создаётся`);
    console.log(`  7600546 = Берзарина (Серебряный Бор)`);
    console.log(`  7600550 = Зорге9`);
    console.log(`  7600554 = Толбухина`);
    console.log(`  10787390 = Воронка брокеров (про самих брокеров)`);
    console.log(`Status 143 = "Закрыто и не реализовано" — Deal удаляется`);
    console.log(`Status 142 = "Успешно реализовано" — Deal остаётся (если pipeline != КЦ)`);
  } finally {
    await app.close();
  }
})().catch((e) => {
  console.error('Error:', e?.message || e);
  if (e?.stack) console.error(e.stack);
  process.exit(1);
});
