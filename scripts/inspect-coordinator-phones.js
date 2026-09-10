#!/usr/bin/env node
/**
 * 2026-09-10, гипотеза владельца: повторяющиеся телефоны у многих брокеров —
 * это телефоны координаторов (офис-менеджеров), которые в старом кабинете
 * фиксировали клиентов на других брокеров. Проверяем, не совпадает ли
 * «телефон клиента» с телефоном брокера из нашей базы. Только чтение.
 */
async function main() {
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  const q = (sql) => prisma.$queryRawUnsafe(sql);
  const show = (t, rows) => {
    console.log(`\n=== ${t} ===`);
    for (const r of rows) console.log("  " + Object.entries(r).map(([k, v]) => `${k}=${typeof v === "bigint" ? Number(v) : v}`).join(" · "));
    if (!rows.length) console.log("  (пусто)");
  };
  try {
    show("Гипотеза: телефон клиента = телефон брокера из нашей базы", await q(`
      WITH dubl AS (
        SELECT phone, COUNT(*)::int AS zapisey, COUNT(DISTINCT broker_id)::int AS brokerov
        FROM clients WHERE phone IS NOT NULL AND phone <> '' GROUP BY phone HAVING COUNT(*) > 1)
      SELECT COUNT(*)::int AS vsego_dubl_telefonov,
             COUNT(*) FILTER (WHERE b.id IS NOT NULL)::int AS eto_telefon_brokera,
             COUNT(*) FILTER (WHERE b.is_coordinator)::int AS iz_nih_koordinatory,
             SUM(d.zapisey) FILTER (WHERE b.id IS NOT NULL)::int AS zapisey_pod_telefonom_brokera,
             SUM(d.zapisey) FILTER (WHERE b.id IS NULL)::int AS zapisey_obychnyh_klientov
      FROM dubl d LEFT JOIN brokers b ON b.phone = d.phone`));
    show("Телефоны у 3+ брокеров: чей это номер", await q(`
      WITH dubl AS (
        SELECT phone, COUNT(*)::int AS zapisey, COUNT(DISTINCT broker_id)::int AS brokerov
        FROM clients WHERE phone IS NOT NULL AND phone <> '' GROUP BY phone HAVING COUNT(DISTINCT broker_id) >= 3)
      SELECT COUNT(*)::int AS telefonov_u_3plus_brokerov,
             COUNT(*) FILTER (WHERE b.id IS NOT NULL)::int AS iz_nih_telefon_brokera,
             COUNT(*) FILTER (WHERE b.is_coordinator)::int AS iz_nih_koordinator,
             SUM(d.zapisey)::int AS vsego_zapisey,
             SUM(d.zapisey) FILTER (WHERE b.id IS NOT NULL)::int AS zapisey_pod_brokerskim_nomerom
      FROM dubl d LEFT JOIN brokers b ON b.phone = d.phone`));
    show("Топ-10 таких номеров (маска) с признаком координатора", await q(`
      WITH dubl AS (
        SELECT phone, COUNT(*)::int AS zapisey, COUNT(DISTINCT broker_id)::int AS brokerov,
               COUNT(*) FILTER (WHERE comment LIKE '%[old-cabinet:%')::int AS iz_starogo
        FROM clients WHERE phone IS NOT NULL AND phone <> '' GROUP BY phone HAVING COUNT(DISTINCT broker_id) >= 3)
      SELECT CONCAT(LEFT(d.phone, 4), '***', RIGHT(d.phone, 2)) AS telefon,
             d.zapisey, d.brokerov, d.iz_starogo,
             CASE WHEN b.id IS NULL THEN 'нет в базе брокеров'
                  WHEN b.is_coordinator THEN CONCAT('КООРДИНАТОР: ', b.full_name)
                  ELSE CONCAT('брокер: ', b.full_name) END AS chey_nomer
      FROM dubl d LEFT JOIN brokers b ON b.phone = d.phone
      ORDER BY d.brokerov DESC, d.zapisey DESC LIMIT 10`));
    show("Делегированные фиксации (координатор фиксирует на другого)", await q(`
      SELECT COUNT(*)::int AS vsego_klientov,
             COUNT(*) FILTER (WHERE responsible_broker_id IS NOT NULL)::int AS s_otvetstvennym,
             COUNT(*) FILTER (WHERE responsible_broker_id IS NOT NULL AND responsible_broker_id <> broker_id)::int AS delegirovannye,
             COUNT(DISTINCT broker_id) FILTER (WHERE responsible_broker_id IS NOT NULL AND responsible_broker_id <> broker_id)::int AS koordinatorov_delegirovalo
      FROM clients`));
    show("Сколько всего координаторов в базе брокеров", await q(`
      SELECT COUNT(*) FILTER (WHERE is_coordinator)::int AS koordinatorov,
             COUNT(*) FILTER (WHERE is_coordinator AND role='BROKER' AND merged_into_id IS NULL)::int AS aktivnyh_koordinatorov,
             COUNT(*)::int AS vsego_brokerov
      FROM brokers`));
    show("Записи под телефоном брокера: старый кабинет и статусы", await q(`
      SELECT COUNT(*)::int AS zapisey,
             COUNT(*) FILTER (WHERE c.comment LIKE '%[old-cabinet:%')::int AS iz_starogo_kabineta,
             COUNT(*) FILTER (WHERE c.amo_lead_id IS NULL)::int AS bez_lida_amo,
             COUNT(DISTINCT c.broker_id)::int AS raznyh_brokerov
      FROM clients c JOIN brokers b ON b.phone = c.phone`));
  } finally { await prisma.$disconnect(); }
}
main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
