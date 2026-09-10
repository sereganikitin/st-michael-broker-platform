#!/usr/bin/env node
/**
 * 2026-09-10 (вопрос владельца): «насколько качественно все договоры
 * приведены к единому знаменателю и может ли номер договора служить ID
 * для сквозной аналитики».
 * Проверяет реестр ДДУ: разнобой в написании, дубли номеров, пригодность
 * номера как ключа, покрытие связкой с amoCRM и разметкой канала продажи.
 * Только чтение.
 */

/** Номер договора без различий латиница/кириллица, регистра и пробелов. */
function contractKey(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[abcekmhopxyt]/g, (ch) => ({ a: "а", b: "в", c: "с", e: "е", k: "к", m: "м", h: "н", o: "о", p: "р", x: "х", y: "у", t: "т" })[ch] || ch)
    .replace(/\s+/g, "")
    .trim();
}

/** Более жёсткая нормализация: убираем ещё и разделители. */
const hardKey = (value) => contractKey(value).replace(/[^0-9а-яa-z]/g, "");

function shape(value) {
  const s = String(value ?? "").trim();
  if (!s) return "(пусто)";
  return s
    .replace(/[0-9]+/g, "9")
    .replace(/[А-ЯЁа-яё]+/g, "Б")
    .replace(/[A-Za-z]+/g, "L")
    .replace(/\s+/g, "_");
}

const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);
const topOf = (map, limit = 15) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);

function table(title, rows, total) {
  console.log(`\n=== ${title} ===`);
  if (!rows.length) return console.log("  (пусто)");
  for (const [label, value, note] of rows) {
    const share = total && typeof value === "number" ? `  ${Math.round((value / total) * 100)}%` : "";
    console.log(`  ${String(label).padEnd(48)} ${String(value).padStart(6)}${share}${note ? "  · " + note : ""}`);
  }
}

async function main() {
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.registryDeal.findMany({
      select: {
        id: true, rowKey: true, source: true, contractNumber: true, project: true,
        amount: true, paidAt: true, signedAt: true, amoLeadId: true, brokerId: true,
        saleChannel: true, agencyCanonical: true,
      },
    });
    const total = rows.length;
    console.log(`Строк в реестре ДДУ: ${total}`);

    // ---------- 1. качество написания
    const shapes = new Map();
    let empty = 0, latin = 0, spaces = 0, upperLower = 0, weird = 0;
    for (const r of rows) {
      const raw = String(r.contractNumber ?? "");
      if (!raw.trim()) empty++;
      if (/[A-Za-z]/.test(raw)) latin++;
      if (/\s/.test(raw)) spaces++;
      if (/[А-ЯЁ]/.test(raw) && /[а-яё]/.test(raw)) upperLower++;
      if (/[^0-9A-Za-zА-Яа-яЁё\s\/\-.№]/.test(raw)) weird++;
      bump(shapes, shape(raw));
    }

    // ---------- 2. дубли
    const bySoft = new Map();
    const byHard = new Map();
    const byProjectSoft = new Map();
    for (const r of rows) {
      const soft = contractKey(r.contractNumber);
      const hard = hardKey(r.contractNumber);
      if (!bySoft.has(soft)) bySoft.set(soft, []);
      bySoft.get(soft).push(r);
      if (!byHard.has(hard)) byHard.set(hard, []);
      byHard.get(hard).push(r);
      const pk = `${r.project || "—"}|${soft}`;
      if (!byProjectSoft.has(pk)) byProjectSoft.set(pk, []);
      byProjectSoft.get(pk).push(r);
    }
    const dupSoft = [...bySoft.values()].filter((v) => v.length > 1);
    const dupHard = [...byHard.values()].filter((v) => v.length > 1);
    const dupProject = [...byProjectSoft.values()].filter((v) => v.length > 1);

    // сколько дублей — это одна и та же сделка (совпадает сумма и дата оплаты)
    let sameDeal = 0, differentDeal = 0;
    for (const group of dupProject) {
      const keys = new Set(group.map((r) => `${r.amount ?? "—"}|${r.paidAt ? new Date(r.paidAt).toISOString().slice(0, 10) : "—"}`));
      if (keys.size === 1) sameDeal++;
      else differentDeal++;
    }

    // ---------- 3. пригодность как ID и покрытие
    const withLead = rows.filter((r) => r.amoLeadId !== null && r.amoLeadId !== undefined).length;
    const withBroker = rows.filter((r) => r.brokerId).length;
    const channel = new Map();
    for (const r of rows) bump(channel, r.saleChannel || "(не размечен)");
    const bySource = new Map();
    for (const r of rows) bump(bySource, r.source || "(нет)");

    table("1. Разнобой в написании номеров", [
      ["Всего строк", total],
      ["Пустой номер договора", empty, "нельзя использовать как ключ"],
      ["Содержит латинские буквы", latin, "приводится подменой букв"],
      ["Содержит пробелы", spaces, "приводится обрезкой"],
      ["Символы вне «цифры/буквы/№ / - .»", weird, "требует ручного взгляда"],
      ["Разных форм записи (шаблонов)", shapes.size],
    ], total);

    table("1б. Самые частые формы записи (9=цифры, Б=кириллица, L=латиница)", topOf(shapes, 15), total);

    table("2. Дубли номеров договоров", [
      ["Уникальных номеров после приведения", bySoft.size],
      ["Номеров, встречающихся более одного раза", dupSoft.length, "внутри всего реестра"],
      ["То же при жёсткой нормализации (без «/» и «-»)", dupHard.length, "если разделители не значимы"],
      ["Повторов внутри одного проекта", dupProject.length, "самый опасный случай"],
      ["Из них одна и та же сделка (сумма и дата совпали)", sameDeal, "похоже на дубль строки"],
      ["Из них разные сделки под одним номером", differentDeal, "номер НЕ уникален"],
    ], total);

    console.log("\n  Примеры повторов внутри проекта:");
    for (const group of dupProject.slice(0, 10)) {
      const g = group.map((r) => `${r.amount ?? "—"} ₽ · ${r.paidAt ? new Date(r.paidAt).toISOString().slice(0, 10) : "без даты"} · ${r.source} · лид ${r.amoLeadId ?? "—"}`).join(" | ");
      console.log(`    ${group[0].project || "—"} «${group[0].contractNumber}» ×${group.length}: ${g}`);
    }

    table("3. Пригодность для сквозной аналитики", [
      ["Строк со связкой с amoCRM (лид)", withLead, `${Math.round((withLead / total) * 100)}% покрытия`],
      ["Строк с привязанным брокером", withBroker],
      ["Строк без номера договора", empty],
    ], total);

    table("3б. Канал продажи", topOf(channel, 6), total);
    table("3в. Источник строки", topOf(bySource, 6), total);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error("FATAL:", e?.stack || e?.message || e);
  process.exit(1);
});
