#!/usr/bin/env node
/**
 * 2026-07-22: Отчёт «кто был на брокер-туре» ПРЯМО ИЗ amoCRM (read-only).
 *
 * В БД платформы тур-поля пустые у всех — реальные отметки живут в amo:
 * поле контакта «Был на брокер-туре» (842303) и «Дата брокер-тура» (842305).
 * Скрипт постранично обходит все контакты amo, берёт всех с галочкой тура
 * и сопоставляет их с нашей БД (по amo_contact_id и телефону) и с
 * уникальными фиксациями (clients.uniqueness_status = CONDITIONALLY_UNIQUE).
 *
 * Ничего не пишет ни в amo, ни в БД. Телефоны в выводе маскируются.
 *
 * Запуск в контейнере api (workflow report-broker-tour-amo.yml):
 *   node /app/scripts/report-broker-tour-from-amo.js
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const last10 = (p) => String(p || '').replace(/\D/g, '').slice(-10);
const mask = (p) => {
  const d = String(p || '').replace(/\D/g, '');
  return d ? '***' + d.slice(-4) : '(нет)';
};

function cfRaw(contact, fieldId) {
  const f = (contact.custom_fields_values || []).find((x) => x.field_id === fieldId);
  return f?.values?.[0]?.value ?? null;
}

function contactPhones(contact) {
  const f = (contact.custom_fields_values || []).find((x) => x.field_code === 'PHONE');
  return (f?.values || []).map((v) => String(v.value || '')).filter(Boolean);
}

function fmtTourDate(raw) {
  if (raw == null) return '(без даты)';
  if (typeof raw === 'number' || /^\d{9,}$/.test(String(raw))) {
    const d = new Date(Number(raw) * 1000);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  const d = new Date(String(raw));
  return isNaN(d.getTime()) ? String(raw) : d.toISOString().slice(0, 10);
}

(async () => {
  const { NestFactory } = require('@nestjs/core');
  let AppModule;
  try {
    ({ AppModule } = require('/app/apps/api/dist/app.module'));
  } catch (e) {
    console.error('Cannot load Nest:', e?.message);
    process.exit(1);
  }
  const { AmoCrmAdapter } = require('/app/packages/integrations/dist/amo-crm.adapter');
  const { AMO_CONTACT_FIELDS } = require('/app/packages/integrations/dist/amo-crm.fields');
  const { PrismaClient } = require('@st-michael/database');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const prisma = new PrismaClient();
  const amo = new AmoCrmAdapter();

  try {
    const TOUR_VISITED = AMO_CONTACT_FIELDS.BROKER_TOUR_VISITED; // 842303
    const TOUR_DATE = AMO_CONTACT_FIELDS.BROKER_TOUR_DATE; // 842305

    // ─── 1. Обходим все контакты amo ───
    const tourists = [];
    let page = 1;
    let scanned = 0;
    for (;;) {
      let res;
      try {
        res = await amo['request'](`/api/v4/contacts?page=${page}&limit=250`);
      } catch (e) {
        console.error(`Страница ${page}: ${e?.message || e} — стоп.`);
        break;
      }
      const list = res?._embedded?.contacts || [];
      if (list.length === 0) break;
      scanned += list.length;
      for (const c of list) {
        const v = cfRaw(c, TOUR_VISITED);
        const visited = v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true';
        if (!visited) continue;
        tourists.push({
          amoId: c.id,
          name: String(c.name || '').trim() || '(без имени)',
          phones: contactPhones(c),
          tourDate: fmtTourDate(cfRaw(c, TOUR_DATE)),
        });
      }
      if (page % 10 === 0) console.log(`— прогресс: ${scanned} контактов, с туром: ${tourists.length} —`);
      if (!res?._links?.next) break;
      page++;
      await sleep(300);
    }

    console.log('═══════════════════════════════════════════');
    console.log(`Контактов в amo просмотрено: ${scanned}`);
    console.log(`С отметкой «Был на брокер-туре»: ${tourists.length}`);
    console.log('═══════════════════════════════════════════');

    // ─── 2. Готовим сопоставление с БД ───
    const brokers = await prisma.$queryRaw`
      SELECT b.id, b.full_name, b.phone, b.amo_contact_id::text AS amo_contact_id,
             count(c.id)::int AS clients_total,
             count(c.id) FILTER (WHERE c.uniqueness_status = 'CONDITIONALLY_UNIQUE')::int AS unique_fix,
             count(c.id) FILTER (WHERE c.fixation_status = 'FIXED')::int AS fixed_fix
      FROM brokers b
      LEFT JOIN clients c ON c.broker_id = b.id
      WHERE b.merged_into_id IS NULL
      GROUP BY b.id, b.full_name, b.phone, b.amo_contact_id
    `;
    const byAmoId = new Map();
    const byPhone = new Map();
    for (const b of brokers) {
      if (b.amo_contact_id) byAmoId.set(String(b.amo_contact_id), b);
      const p = last10(b.phone);
      if (p) byPhone.set(p, b);
    }

    // ─── 3. Список «туристов» + их фиксации ───
    console.log('');
    console.log('КТО БЫЛ НА БРОКЕР-ТУРЕ (по amo), и что у них в нашей БД:');
    console.log('имя | телефон | дата тура | в БД платформы | уникальных фиксаций');
    console.log('───────────────────────────────────────────');
    let withFix = 0;
    let inDb = 0;
    const fixNames = [];
    for (const t of tourists.sort((a, b) => a.name.localeCompare(b.name, 'ru'))) {
      let b = byAmoId.get(String(t.amoId)) || null;
      if (!b) {
        for (const ph of t.phones) {
          b = byPhone.get(last10(ph)) || null;
          if (b) break;
        }
      }
      if (b) inDb++;
      const fix = b ? b.unique_fix : 0;
      if (fix > 0) {
        withFix++;
        fixNames.push(`${t.name} — ${fix}`);
      }
      const phone = mask(t.phones[0]);
      console.log(`${t.name} | ${phone} | ${t.tourDate} | ${b ? 'да' : 'НЕТ'} | ${fix > 0 ? fix : '—'}`);
    }

    console.log('───────────────────────────────────────────');
    console.log('ИТОГО:');
    console.log(`  было на брокер-туре (по amo):     ${tourists.length}`);
    console.log(`  из них найдены в БД платформы:    ${inDb}`);
    console.log(`  из них с уникальными фиксациями:  ${withFix}`);
    if (fixNames.length) {
      console.log('  Кто именно зафиксировал:');
      for (const n of fixNames) console.log(`    - ${n}`);
    }

    // ─── 4. Обратная проверка: у кого фиксации есть, а тура нет ───
    const tourAmoIds = new Set(tourists.map((t) => String(t.amoId)));
    const tourPhones = new Set(tourists.flatMap((t) => t.phones.map(last10)));
    console.log('');
    console.log('Брокеры с уникальными фиксациями БЕЗ отметки тура в amo:');
    for (const b of brokers.filter((x) => x.unique_fix > 0)) {
      const marked =
        (b.amo_contact_id && tourAmoIds.has(String(b.amo_contact_id))) ||
        tourPhones.has(last10(b.phone));
      if (!marked) console.log(`  - ${b.full_name} (${mask(b.phone)}) — фиксаций: ${b.unique_fix}`);
    }
    console.log('');
    console.log('=== Конец отчёта ===');
  } finally {
    await prisma.$disconnect();
    await app.close();
  }
})().catch((e) => {
  console.error('Fatal:', e?.message || e);
  if (e?.stack) console.error(e.stack);
  process.exit(1);
});
