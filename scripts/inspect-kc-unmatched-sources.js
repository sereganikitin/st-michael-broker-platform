#!/usr/bin/env node
/**
 * 2026-09-10 (просьба владельца: «разложи их по источникам — самоход,
 * купивший по рекламе»): карточки воронки колл-центра со статусом
 * «встреча проведена», телефон которых не найден среди клиентов кабинета.
 * Показывает полное распределение по полям источника и сводку по группам.
 * Дополнительно проверяет, есть ли среди карточек КЦ брокер-туры по
 * названию лида (поле «Встреча» их не содержит — проверено 10.09).
 * Только чтение: ни одной записи в базу и в amoCRM.
 */
const KC_PIPELINE_ID = 7600542;
const KC_MEETING_HELD_STATUS = 142;
const AMO_PAUSE_MS = 280;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function phoneKeyCandidates(raw) {
  const keys = new Set();
  const chunks = String(raw || "").split(/[,;\/]|\s(?:или|и)\s/);
  for (const chunk of chunks) {
    const digits = chunk.replace(/\D/g, "");
    if (!digits) continue;
    if (digits.length === 10) keys.add(digits);
    else if (digits.length === 11 && (digits[0] === "7" || digits[0] === "8")) keys.add(digits.slice(1));
    else if (digits.length > 11 && (digits[0] === "7" || digits[0] === "8")) keys.add(digits.slice(1, 11));
  }
  return [...keys];
}

const leadCustomField = (lead, name) => {
  const f = (lead?.custom_fields_values || []).find((x) => x.field_name === name);
  return f?.values?.[0]?.value ?? null;
};

function contactPhoneKeys(contact) {
  const out = new Set();
  for (const field of contact?.custom_fields_values || []) {
    if (String(field.field_code || "").toUpperCase() !== "PHONE") continue;
    for (const v of field.values || []) for (const key of phoneKeyCandidates(v?.value)) out.add(key);
  }
  return [...out];
}

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

function table(title, rows, total) {
  console.log(`\n=== ${title} ===`);
  if (!rows.length) return console.log("  (пусто)");
  for (const [label, value] of rows) {
    const share = total ? `  ${Math.round((value / total) * 100)}%` : "";
    console.log(`  ${String(label).padEnd(46)} ${String(value).padStart(6)}${share}`);
  }
}

const topOf = (map, limit = 20) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);

/** Группа источника: как объяснять владельцу, откуда пришёл клиент. */
function sourceGroup(lead) {
  const createdFrom = String(leadCustomField(lead, "Создана из") || "").toLowerCase();
  const contactType = String(leadCustomField(lead, "Тип обращения") || "").toLowerCase();
  const fromBroker = String(leadCustomField(lead, "От брокера") || "").toLowerCase();
  const docSource = String(leadCustomField(lead, "источник для документов") || "").toLowerCase();

  if (fromBroker.includes("да")) return "От брокера (по карточке), но телефона нет в кабинете";
  if (createdFrom.includes("calltouch") || createdFrom.includes("callt")) return "Реклама: звонок с рекламы (Calltouch)";
  if (createdFrom.includes("сайт") || createdFrom.includes("site") || createdFrom.includes("форм")) return "Реклама: заявка с сайта";
  if (createdFrom.includes("авито") || createdFrom.includes("циан") || createdFrom.includes("cian") || createdFrom.includes("яндекс")) return "Реклама: площадки объявлений";
  if (createdFrom.includes("whatsapp") || createdFrom.includes("telegram") || createdFrom.includes("чат")) return "Мессенджеры и чат";
  if (contactType.includes("звонок")) return "Входящий звонок (источник не размечен)";
  if (contactType.includes("визит") || contactType.includes("офис")) return "Самоход: пришёл в офис продаж";
  if (docSource.includes("внутрен")) return "Внутренний источник (без разметки рекламы)";
  if (createdFrom) return `Прочее: ${createdFrom}`;
  return "Источник не заполнен";
}

async function main() {
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    const amo = await initAmo(prisma);

    const leads = [];
    let page = 1;
    for (;;) {
      let res;
      try {
        res = await amo["request"](`/leads?filter[pipeline_id]=${KC_PIPELINE_ID}&page=${page}&limit=250&with=contacts`);
      } catch (e) {
        console.error(`страница ${page}: ${e?.message || e}`);
        break;
      }
      const list = res?._embedded?.leads || [];
      if (!list.length) break;
      for (const lead of list) if (Number(lead.status_id) === KC_MEETING_HELD_STATUS) leads.push(lead);
      if (!res?._links?.next) break;
      page++;
      await sleep(AMO_PAUSE_MS);
    }
    console.log(`Карточек колл-центра со статусом «встреча проведена»: ${leads.length}`);

    const contactIdByLead = new Map();
    for (const lead of leads) {
      const contacts = lead?._embedded?.contacts || [];
      const main = contacts.find((c) => c.is_main) || contacts[0];
      if (main?.id) contactIdByLead.set(lead.id, Number(main.id));
    }
    const contactMap = await amo.getContactsByIds([...new Set(contactIdByLead.values())]);

    const clients = await prisma.client.findMany({ select: { phone: true } });
    const known = new Set();
    for (const c of clients) for (const key of phoneKeyCandidates(c.phone)) known.add(key);

    const groups = new Map();
    const createdFrom = new Map();
    const contactType = new Map();
    const docSource = new Map();
    const managers = new Map();
    const meetingField = new Map();
    let unmatched = 0;
    let noContact = 0;
    let tourByName = 0;

    for (const lead of leads) {
      if (String(lead?.name || "").toLowerCase().includes("тур")) tourByName++;
      const contact = contactMap.get(contactIdByLead.get(lead.id));
      const keys = contact ? contactPhoneKeys(contact) : [];
      if (!contact) noContact++;
      if (keys.some((k) => known.has(k))) continue;

      unmatched++;
      bump(groups, sourceGroup(lead));
      bump(createdFrom, String(leadCustomField(lead, "Создана из") || "(не заполнено)").trim().slice(0, 40));
      bump(contactType, String(leadCustomField(lead, "Тип обращения") || "(не заполнено)").trim().slice(0, 40));
      bump(docSource, String(leadCustomField(lead, "источник для документов") || "(не заполнено)").trim().slice(0, 40));
      bump(managers, String(leadCustomField(lead, "Ответственный КЦ") || "(не заполнено)").trim().slice(0, 40));
      bump(meetingField, String(leadCustomField(lead, "Встреча") || "(не заполнено)").trim().slice(0, 40));
    }

    console.log(`\nБез совпадения по телефону: ${unmatched} (из них без контакта в amoCRM: ${noContact})`);
    table("1. Откуда пришли эти клиенты (сводка по группам)", topOf(groups, 20), unmatched);
    table("2. Поле «Создана из»", topOf(createdFrom, 20), unmatched);
    table("3. Поле «Тип обращения»", topOf(contactType, 15), unmatched);
    table("4. Поле «источник для документов»", topOf(docSource, 15), unmatched);
    table("5. Поле «Встреча» (где проходила)", topOf(meetingField, 15), unmatched);
    table("6. Ответственный колл-центра", topOf(managers, 15), unmatched);
    console.log(`\nКарточек КЦ со словом «тур» в названии лида: ${tourByName} (из ${leads.length})`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error("FATAL:", e?.stack || e?.message || e);
  process.exit(1);
});
