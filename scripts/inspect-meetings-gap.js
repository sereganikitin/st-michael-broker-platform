#!/usr/bin/env node
/**
 * 2026-09-10 (владелец: «есть сделки и встречи тоже были; проверь карточки в
 * воронке колл-центра со статусом успешно реализовано»): меряем, почему у
 * брокеров со сделками показывается «0 встр.». Только чтение.
 */
async function main() {
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  const q = (sql) => prisma.$queryRawUnsafe(sql);
  const show = (title, rows) => {
    console.log(`\n=== ${title} ===`);
    for (const r of rows) console.log("  " + Object.entries(r).map(([k, v]) => `${k}=${typeof v === "bigint" ? Number(v) : v}`).join(" · "));
    if (!rows.length) console.log("  (пусто)");
  };
  try {
    show("Встречи: тип · статус · есть ли клиент", await q(`
      SELECT type, status, COUNT(*)::int AS cnt,
             COUNT(*) FILTER (WHERE client_id IS NULL)::int AS bez_klienta,
             COUNT(*) FILTER (WHERE date < now())::int AS v_proshlom,
             MIN(date)::date AS s, MAX(date)::date AS po
      FROM meetings GROUP BY 1,2 ORDER BY cnt DESC`));
    show("Встречи по правилу базы лояльности", await q(`
      SELECT COUNT(*)::int AS vsego,
        COUNT(*) FILTER (WHERE status IN ('CONFIRMED','COMPLETED'))::int AS podtverzhdeny,
        COUNT(*) FILTER (WHERE status IN ('CONFIRMED','COMPLETED') AND type <> 'BROKER_TOUR')::int AS schitaetsya,
        COUNT(*) FILTER (WHERE status IN ('CONFIRMED','COMPLETED') AND type = 'BROKER_TOUR')::int AS ischerpano_turami,
        COUNT(*) FILTER (WHERE status = 'PENDING' AND date < now())::int AS zavisli_pending,
        COUNT(DISTINCT broker_id)::int AS brokerov
      FROM meetings`));
    show("Импорт из КЦ (по метке в комментарии)", await q(`
      SELECT type, status, COUNT(*)::int AS cnt FROM meetings
      WHERE comment LIKE 'Импорт из amoCRM (КЦ%' GROUP BY 1,2 ORDER BY cnt DESC`));
    show("Источник встреч (догадка по комментарию/слоту)", await q(`
      SELECT CASE
        WHEN comment LIKE 'Импорт из amoCRM (КЦ%' THEN 'бэкфилл КЦ'
        WHEN comment LIKE '%[amo:статус не подтверждён]%' THEN 'amo, статус не подтверждён'
        WHEN comment LIKE 'Клиент:%' THEN 'синк amo по полю встречи'
        WHEN slot_id IS NOT NULL THEN 'форма кабинета (слот)'
        WHEN comment IS NULL THEN 'без комментария (импорт/форма)'
        ELSE 'прочее' END AS istochnik,
        COUNT(*)::int AS cnt,
        COUNT(*) FILTER (WHERE type='BROKER_TOUR')::int AS iz_nih_tury,
        COUNT(*) FILTER (WHERE status='PENDING')::int AS iz_nih_pending
      FROM meetings GROUP BY 1 ORDER BY cnt DESC`));
    show("Брокеры со сделками и нулём засчитанных встреч (агрегат)", await q(`
      SELECT
        (SELECT COUNT(*) FROM registry_deals rd WHERE rd.broker_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM meetings m WHERE m.broker_id=rd.broker_id
             AND m.status IN ('CONFIRMED','COMPLETED') AND m.type<>'BROKER_TOUR'))::int AS sdelok_reestra_u_takih,
        (SELECT COUNT(DISTINCT rd.broker_id) FROM registry_deals rd WHERE rd.broker_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM meetings m WHERE m.broker_id=rd.broker_id
             AND m.status IN ('CONFIRMED','COMPLETED') AND m.type<>'BROKER_TOUR'))::int AS brokerov_takih`));
    show("Топ-10 брокеров: сделки есть, засчитанных встреч нет", await q(`
      WITH c AS (SELECT broker_id, COUNT(*)::int n FROM meetings
                 WHERE status IN ('CONFIRMED','COMPLETED') AND type<>'BROKER_TOUR' GROUP BY 1),
           a AS (SELECT broker_id, COUNT(*)::int n_any,
                        COUNT(*) FILTER (WHERE type='BROKER_TOUR')::int n_tour,
                        COUNT(*) FILTER (WHERE status='PENDING')::int n_pending FROM meetings GROUP BY 1),
           rd AS (SELECT broker_id, COUNT(*)::int n FROM registry_deals WHERE broker_id IS NOT NULL GROUP BY 1)
      SELECT b.full_name AS broker, COALESCE(rd.n,0) AS sdelok_reestra,
             COALESCE(a.n_any,0) AS vstrech_vsego, COALESCE(a.n_tour,0) AS iz_nih_tury,
             COALESCE(a.n_pending,0) AS iz_nih_pending
      FROM brokers b JOIN rd ON rd.broker_id=b.id LEFT JOIN c ON c.broker_id=b.id LEFT JOIN a ON a.broker_id=b.id
      WHERE b.role='BROKER' AND b.merged_into_id IS NULL AND COALESCE(c.n,0)=0
      ORDER BY COALESCE(rd.n,0) DESC LIMIT 10`));
  } finally { await prisma.$disconnect(); }
}
main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
