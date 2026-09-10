#!/usr/bin/env node
/**
 * 2026-09-10 (владелец разрешил проверку): у 447 брокеров в amoCRM стоит
 * галочка «был на брокер-туре», но поле даты пустое — встречу создать не
 * из чего. Гипотеза: дату можно взять из истории изменений amoCRM (когда
 * галочку поставили). Проверяем на тех, у кого дата есть: насколько день
 * простановки галочки совпадает с реальной датой тура.
 * Заодно перечитываем поле даты прямо из amo — вдруг синхронизация его
 * просто не донесла.
 * Только чтение.
 */
const FIELD_TOUR_VISITED = 842303;
const FIELD_TOUR_DATE = 842305;
const AMO_PAUSE_MS = 260;
const SAMPLE_WITH_DATE = Number(process.env.SAMPLE || 400);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dayKey = (d) => new Date(d).toISOString().slice(0, 10);

async function initAmo(prisma) {
  const { AmoCrmAdapter, setAmoTokens, setAmoTokenRefreshHook } = require("/app/packages/integrations/dist/amo-crm.adapter");
  const rows = await prisma.systemSetting.findMany({
    where: { key: { in: ["AMO_ACCESS_TOKEN", "AMO_REFRESH_TOKEN"] } },
    select: { key: true, value: true },
  });
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  setAmoTokens(byKey.get("AMO_ACCESS_TOKEN") || "", byKey.get("AMO_REFRESH_TOKEN") || "");
  setAmoTokenRefreshHook(async (tokens) => {
    for (const [key, value] of [["AMO_ACCESS_TOKEN", tokens.access], ["AMO_REFRESH_TOKEN", tokens.refresh]]) {
      await prisma.systemSetting.upsert({ where: { key }, update: { value, updatedBy: "inspect" }, create: { key, value, updatedBy: "inspect" } });
    }
  });
  return new AmoCrmAdapter();
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

/** События изменения полей контакта пачками. */
async function fetchFieldEvents(amo, contactIds) {
  const byContact = new Map();
  for (let i = 0; i < contactIds.length; i += 40) {
    const chunk = contactIds.slice(i, i + 40);
    const filter = chunk.map((id) => `filter[entity_id][]=${id}`).join("&");
    let page = 1;
    for (;;) {
      let res;
      try {
        res = await amo["request"](`/events?filter[entity][]=contact&filter[type][]=custom_field_value_changed&${filter}&page=${page}&limit=100`);
      } catch (e) {
        console.error(`события ${i}/${page}: ${e?.message || e}`);
        break;
      }
      const list = res?._embedded?.events || [];
      for (const ev of list) {
        const fields = [...(ev.value_after || []), ...(ev.value_before || [])];
        const touchesVisited = fields.some((v) => Number(v?.custom_field_value?.field_id) === FIELD_TOUR_VISITED);
        if (!touchesVisited) continue;
        const id = String(ev.entity_id);
        if (!byContact.has(id)) byContact.set(id, []);
        byContact.get(id).push(ev);
      }
      if (!res?._links?.next || list.length < 100) break;
      page++;
      await sleep(AMO_PAUSE_MS);
    }
    await sleep(AMO_PAUSE_MS);
  }
  return byContact;
}

const contactFieldValue = (contact, fieldId) => {
  const f = (contact?.custom_fields_values || []).find((x) => Number(x.field_id) === fieldId);
  return f?.values?.[0]?.value ?? null;
};

function asDate(value) {
  const num = Number(value);
  if (Number.isFinite(num) && num > 1000000) return new Date(num * 1000);
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

async function main() {
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    const amo = await initAmo(prisma);

    const withDate = await prisma.broker.findMany({
      where: { mergedIntoId: null, brokerTourDate: { not: null }, amoContactId: { not: null } },
      select: { id: true, amoContactId: true, brokerTourDate: true },
    });
    const withoutDate = await prisma.broker.findMany({
      where: { mergedIntoId: null, brokerTourVisited: true, brokerTourDate: null },
      select: { id: true, amoContactId: true },
    });
    const withoutDateLinked = withoutDate.filter((b) => b.amoContactId !== null && b.amoContactId !== undefined);

    console.log(`Брокеров с датой тура: ${withDate.length} (сверяем на них)`);
    console.log(`Брокеров с галочкой без даты: ${withoutDate.length}, из них с контактом в amoCRM: ${withoutDateLinked.length}`);

    // ---------- 1. проверка гипотезы на тех, у кого дата есть
    const sample = withDate.slice(0, SAMPLE_WITH_DATE);
    const sampleIds = sample.map((b) => String(b.amoContactId));
    const events = await fetchFieldEvents(amo, sampleIds);

    const diffBuckets = new Map();
    let noEvent = 0, matched = 0;
    let within0 = 0, within3 = 0, within7 = 0, within30 = 0, far = 0;
    for (const broker of sample) {
      const list = events.get(String(broker.amoContactId)) || [];
      if (!list.length) { noEvent++; continue; }
      matched++;
      const evDates = list.map((ev) => new Date(Number(ev.created_at) * 1000)).sort((a, b) => a - b);
      const real = new Date(broker.brokerTourDate);
      const best = evDates.reduce((acc, d) => {
        const diff = Math.abs(Math.round((d - real) / 86400000));
        return acc === null || diff < acc ? diff : acc;
      }, null);
      if (best === 0) within0++;
      else if (best <= 3) within3++;
      else if (best <= 7) within7++;
      else if (best <= 30) within30++;
      else far++;
      bump(diffBuckets, best <= 0 ? "день в день" : best <= 3 ? "1–3 дня" : best <= 7 ? "4–7 дней" : best <= 30 ? "8–30 дней" : "больше месяца");
    }

    table("1. Совпадение даты простановки галочки с реальной датой тура", [
      ["Проверено брокеров (у кого дата есть)", sample.length],
      ["Событие простановки найдено в amoCRM", matched],
      ["Истории изменений нет", noEvent, "восстановить нечем"],
      ["Совпало день в день", within0],
      ["Расхождение 1–3 дня", within3],
      ["Расхождение 4–7 дней", within7],
      ["Расхождение 8–30 дней", within30],
      ["Расхождение больше месяца", far, "так восстанавливать нельзя"],
    ], sample.length);
    table("1б. Разброс расхождения", topOf(diffBuckets, 8), matched);

    // ---------- 2. может, дата просто не доехала синхронизацией
    const recheckIds = withoutDateLinked.slice(0, 500).map((b) => Number(b.amoContactId));
    const contacts = await amo.getContactsByIds(recheckIds);
    let hasDateInAmo = 0, hasVisitedInAmo = 0, nothing = 0;
    const examples = [];
    for (const broker of withoutDateLinked.slice(0, 500)) {
      const contact = contacts.get(Number(broker.amoContactId));
      if (!contact) { nothing++; continue; }
      const date = asDate(contactFieldValue(contact, FIELD_TOUR_DATE));
      const visited = contactFieldValue(contact, FIELD_TOUR_VISITED);
      if (date) { hasDateInAmo++; if (examples.length < 10) examples.push(`${broker.id} → ${dayKey(date)}`); }
      if (visited) hasVisitedInAmo++;
    }
    table("2. Перечитали поле даты прямо из amoCRM (у кого её нет в кабинете)", [
      ["Проверено карточек", Math.min(withoutDateLinked.length, 500)],
      ["Дата в amoCRM всё-таки заполнена", hasDateInAmo, "синхронизация не донесла"],
      ["Галочка в amoCRM стоит", hasVisitedInAmo],
      ["Контакт в amoCRM не найден", nothing],
    ], Math.min(withoutDateLinked.length, 500));
    if (examples.length) {
      console.log("  примеры найденных дат:");
      for (const e of examples) console.log(`    ${e}`);
    }

    // ---------- 3. сколько из «без даты» вообще имеют историю изменений
    const noDateIds = withoutDateLinked.slice(0, 300).map((b) => String(b.amoContactId));
    const noDateEvents = await fetchFieldEvents(amo, noDateIds);
    let recoverable = 0;
    for (const id of noDateIds) if ((noDateEvents.get(id) || []).length) recoverable++;
    table("3. Восстановимость даты для тех, у кого её нет", [
      ["Проверено карточек", noDateIds.length],
      ["Есть событие простановки галочки", recoverable, "дату можно взять из истории"],
      ["Истории нет", noDateIds.length - recoverable],
    ], noDateIds.length);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error("FATAL:", e?.stack || e?.message || e);
  process.exit(1);
});
