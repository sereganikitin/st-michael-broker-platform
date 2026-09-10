#!/usr/bin/env node
/**
 * 2026-09-10, уточнения владельца:
 *   1) делегированные фиксации — это старый кабинет или новый (в старом поля
 *      «ответственный брокер» не было вовсе);
 *   2) перепроверить число координаторов;
 *   3) гипотеза: телефон, разбросанный по многим брокерам, — это номер
 *      агентства (офиса), брокеры приходят и уходят, а номер остаётся.
 * Только чтение.
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
    show("1. Делегированные фиксации: старый кабинет или новый", await q(`
      SELECT COUNT(*)::int AS delegirovannyh,
             COUNT(*) FILTER (WHERE comment LIKE '%[old-cabinet:%')::int AS iz_starogo_kabineta,
             COUNT(*) FILTER (WHERE comment NOT LIKE '%[old-cabinet:%' OR comment IS NULL)::int AS novyy_kabinet,
             MIN(created_at)::date AS pervaya, MAX(created_at)::date AS poslednyaya,
             COUNT(DISTINCT broker_id)::int AS kto_oformlyal,
             COUNT(DISTINCT responsible_broker_id)::int AS na_kogo_oformlyali
      FROM clients WHERE responsible_broker_id IS NOT NULL AND responsible_broker_id <> broker_id`));
    show("1б. Есть ли поле «ответственный» у записей старого кабинета вообще", await q(`
      SELECT COUNT(*)::int AS zapisey_starogo_kabineta,
             COUNT(*) FILTER (WHERE responsible_broker_id IS NOT NULL)::int AS s_otvetstvennym
      FROM clients WHERE comment LIKE '%[old-cabinet:%'`));
    show("2. Координаторы: перепроверка", await q(`
      SELECT COUNT(*)::int AS vsego_s_priznakom_koordinatora,
             COUNT(*) FILTER (WHERE role = 'BROKER')::int AS rol_broker,
             COUNT(*) FILTER (WHERE merged_into_id IS NOT NULL)::int AS obedinennyh,
             COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS aktivnyh
      FROM brokers WHERE is_coordinator = true`));
    show("2б. Координаторы: сколько заявок оформили", await q(`
      SELECT b.full_name AS koordinator,
             (SELECT COUNT(*)::int FROM clients c WHERE c.broker_id = b.id) AS zayavok,
             (SELECT COUNT(*)::int FROM clients c WHERE c.broker_id = b.id AND c.responsible_broker_id IS NOT NULL AND c.responsible_broker_id <> b.id) AS iz_nih_na_drugogo
      FROM brokers b WHERE b.is_coordinator = true
      ORDER BY 2 DESC LIMIT 10`));
    show("3. Гипотеза «номер агентства»: телефоны у 3+ брокеров", await q(`
      WITH dubl AS (
        SELECT phone, COUNT(*)::int AS zapisey, COUNT(DISTINCT broker_id)::int AS brokerov
        FROM clients WHERE phone IS NOT NULL AND phone <> '' GROUP BY phone HAVING COUNT(DISTINCT broker_id) >= 3),
      agentstva AS (
        SELECT d.phone,
               (SELECT COUNT(DISTINCT ba.agency_id) FROM clients c
                  JOIN broker_agencies ba ON ba.broker_id = c.broker_id
                 WHERE c.phone = d.phone)::int AS agentstv_u_brokerov
        FROM dubl d)
      SELECT COUNT(*)::int AS telefonov_u_3plus,
             COUNT(*) FILTER (WHERE a.agentstv_u_brokerov = 1)::int AS brokery_iz_odnogo_agentstva,
             COUNT(*) FILTER (WHERE a.agentstv_u_brokerov > 1)::int AS brokery_iz_raznyh_agentstv,
             COUNT(*) FILTER (WHERE a.agentstv_u_brokerov = 0)::int AS brokery_bez_agentstva
      FROM dubl d JOIN agentstva a ON a.phone = d.phone`));
    show("3б. Совпадает ли такой телефон с телефоном агентства", await q(`
      WITH dubl AS (
        SELECT phone, COUNT(DISTINCT broker_id)::int AS brokerov
        FROM clients WHERE phone IS NOT NULL AND phone <> '' GROUP BY phone HAVING COUNT(DISTINCT broker_id) >= 3)
      SELECT COUNT(*)::int AS telefonov_u_3plus,
             COUNT(*) FILTER (WHERE ag.id IS NOT NULL)::int AS eto_telefon_agentstva
      FROM dubl d LEFT JOIN agencies ag ON ag.phone = d.phone`));
    show("3в. Топ-10 номеров у 3+ брокеров: из скольких агентств эти брокеры", await q(`
      WITH dubl AS (
        SELECT phone, COUNT(*)::int AS zapisey, COUNT(DISTINCT broker_id)::int AS brokerov
        FROM clients WHERE phone IS NOT NULL AND phone <> '' GROUP BY phone HAVING COUNT(DISTINCT broker_id) >= 3)
      SELECT CONCAT(LEFT(d.phone, 4), '***', RIGHT(d.phone, 2)) AS telefon, d.zapisey, d.brokerov,
             (SELECT COUNT(DISTINCT ba.agency_id) FROM clients c JOIN broker_agencies ba ON ba.broker_id = c.broker_id
               WHERE c.phone = d.phone)::int AS agentstv,
             (SELECT STRING_AGG(DISTINCT LEFT(ag.name, 18), ' | ') FROM clients c
                JOIN broker_agencies ba ON ba.broker_id = c.broker_id
                JOIN agencies ag ON ag.id = ba.agency_id WHERE c.phone = d.phone) AS nazvaniya
      FROM dubl d ORDER BY d.brokerov DESC LIMIT 10`));
  } finally { await prisma.$disconnect(); }
}
main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
