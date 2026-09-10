#!/usr/bin/env node
/**
 * 2026-09-10 (владелец: «что делать с 739 карточками, где телефон совпал с
 * несколькими клиентами»): смотрим природу неоднозначности. Только чтение.
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
    show("Телефоны клиентов, встречающиеся более одного раза", await q(`
      WITH d AS (
        SELECT phone, COUNT(*)::int AS zapisey, COUNT(DISTINCT broker_id)::int AS brokerov
        FROM clients WHERE phone IS NOT NULL AND phone <> '' GROUP BY phone HAVING COUNT(*) > 1)
      SELECT COUNT(*)::int AS telefonov_s_dublyami,
             SUM(zapisey)::int AS vsego_zapisey,
             COUNT(*) FILTER (WHERE brokerov = 1)::int AS odin_broker,
             COUNT(*) FILTER (WHERE brokerov > 1)::int AS raznye_brokery,
             MAX(brokerov)::int AS max_brokerov_na_telefon
      FROM d`));
    show("Разброс: сколько брокеров на один повторяющийся телефон", await q(`
      WITH d AS (
        SELECT phone, COUNT(DISTINCT broker_id)::int AS brokerov
        FROM clients WHERE phone IS NOT NULL AND phone <> '' GROUP BY phone HAVING COUNT(*) > 1)
      SELECT brokerov AS brokerov_na_telefon, COUNT(*)::int AS telefonov
      FROM d GROUP BY 1 ORDER BY 1 LIMIT 10`));
    show("Из них: дубли внутри одного брокера (можно объединять)", await q(`
      WITH d AS (
        SELECT phone, COUNT(*)::int AS zapisey, COUNT(DISTINCT broker_id)::int AS brokerov,
               COUNT(DISTINCT amo_lead_id)::int AS lidov
        FROM clients WHERE phone IS NOT NULL AND phone <> '' GROUP BY phone HAVING COUNT(*) > 1)
      SELECT COUNT(*) FILTER (WHERE brokerov = 1)::int AS telefonov_odin_broker,
             SUM(zapisey) FILTER (WHERE brokerov = 1)::int AS zapisey_odin_broker,
             COUNT(*) FILTER (WHERE brokerov = 1 AND lidov > 1)::int AS iz_nih_raznye_lidy
      FROM d`));
    show("Исторические (старый кабинет) среди дублей", await q(`
      WITH d AS (SELECT phone FROM clients WHERE phone IS NOT NULL AND phone <> ''
                 GROUP BY phone HAVING COUNT(*) > 1)
      SELECT COUNT(*)::int AS vsego_zapisey_s_dubl_telefonom,
             COUNT(*) FILTER (WHERE c.comment LIKE '%[old-cabinet:%')::int AS iz_starogo_kabineta,
             COUNT(*) FILTER (WHERE c.amo_lead_id IS NULL)::int AS bez_lida_amo,
             COUNT(*) FILTER (WHERE c.uniqueness_status = 'EXPIRED')::int AS istekshie,
             COUNT(*) FILTER (WHERE c.uniqueness_status = 'REJECTED')::int AS otklonennye
      FROM clients c JOIN d ON d.phone = c.phone`));
    show("Топ-10 телефонов по числу брокеров (маска)", await q(`
      SELECT CONCAT(LEFT(phone, 4), '***', RIGHT(phone, 2)) AS telefon,
             COUNT(*)::int AS zapisey, COUNT(DISTINCT broker_id)::int AS brokerov,
             COUNT(DISTINCT amo_lead_id)::int AS lidov
      FROM clients WHERE phone IS NOT NULL AND phone <> ''
      GROUP BY phone HAVING COUNT(DISTINCT broker_id) > 1
      ORDER BY 3 DESC, 2 DESC LIMIT 10`));
  } finally { await prisma.$disconnect(); }
}
main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
