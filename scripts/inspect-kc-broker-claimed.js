#!/usr/bin/env node
/**
 * 2026-09-10 (задачи владельца):
 *   1) 85 карточек колл-центра, где стоит «От брокера: Да», а телефона
 *      клиента в кабинете нет. Владелец: «данные клиента ты сможешь найти
 *      по номеру договора и сопоставить с amo». Выводим по каждой карточке
 *      дочернюю сделку, номер договора, строку реестра, брокера и канал.
 *   2) Поле «Ответственный КЦ» по годам: мусорные значения и разнобой в
 *      написании ФИО важны только если встречаются в свежих карточках.
 * Только чтение.
 */
const KC_PIPELINE_ID = 7600542;
const KC_MEETING_HELD_STATUS = 142;
const AMO_PAUSE_MS = 280;
const CONTRACT_FIELD_ID = 558577;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dayKey = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "—");

function contractKey(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[abcekmhopxyt]/g, (ch) => ({ a: "а", b: "в", c: "с", e: "е", k: "к", m: "м", h: "н", o: "о", p: "р", x: "х", y: "у", t: "т" })[ch] || ch)
    .replace(/\s+/g, "")
    .trim();
}

function phoneKeyCandidates(raw) {
  const keys = new Set();
  for (const chunk of String(raw || "").split(/[,;\/]|\s(?:или|и)\s/)) {
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
const leadFieldById = (lead, id) => {
  const f = (lead?.custom_fields_values || []).find((x) => Number(x.field_id) === id);
  return f?.values?.[0]?.value ?? null;
};

function leadMeetingDate(lead) {
  for (const candidate of [leadCustomField(lead, "Дата и время встречи"), lead?.closed_at, lead?.created_at]) {
    const num = Number(candidate);
    if (Number.isFinite(num) && num > 0) {
      const d = new Date(num * 1000);
      if (!isNaN(d.getTime())) return d;
    }
  }
  return null;
}

function contactPhones(contact) {
  const out = [];
  for (const field of contact?.custom_fields_values || []) {
    if (String(field.field_code || "").toUpperCase() !== "PHONE") continue;
    for (const v of field.values || []) if (v?.value) out.push(String(v.value));
  }
  return out;
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

    // ---------- «Ответственный КЦ» по годам
    const byYear = new Map();
    for (const lead of leads) {
      const when = leadMeetingDate(lead);
      const year = when ? String(when.getUTCFullYear()) : "без даты";
      const value = String(leadCustomField(lead, "Ответственный КЦ") || "(не заполнено)").trim();
      if (!byYear.has(year)) byYear.set(year, new Map());
      bump(byYear.get(year), value);
    }
    console.log("\n=== 1. Поле «Ответственный КЦ» по годам ===");
    for (const year of [...byYear.keys()].sort().reverse()) {
      const values = [...byYear.get(year).entries()].sort((a, b) => b[1] - a[1]);
      const total = values.reduce((s, [, v]) => s + v, 0);
      console.log(`  ${year} (карточек ${total}):`);
      for (const [name, count] of values.slice(0, 12)) console.log(`      ${String(name).padEnd(44)} ${String(count).padStart(5)}`);
    }

    // ---------- карточки «От брокера: Да» без клиента в кабинете
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

    const claimed = [];
    for (const lead of leads) {
      const fromBroker = String(leadCustomField(lead, "От брокера") || "").toLowerCase();
      const createdFrom = String(leadCustomField(lead, "Создана из") || "").toLowerCase();
      if (!fromBroker.includes("да") && !createdFrom.includes("брокер")) continue;
      const contact = contactMap.get(contactIdByLead.get(lead.id));
      const phones = contact ? contactPhones(contact) : [];
      const keys = phones.flatMap((p) => phoneKeyCandidates(p));
      if (keys.some((k) => known.has(k))) continue;
      claimed.push({ lead, contact, phones });
    }
    console.log(`\nКарточек «от брокера», где клиента нет в кабинете: ${claimed.length}`);

    // дочерние сделки
    const daughterIds = [];
    for (const item of claimed) {
      const raw = String(leadCustomField(item.lead, "cc_id_daughter") || "").replace(/\D/g, "");
      item.daughterId = raw || null;
      if (raw) daughterIds.push(raw);
    }
    const daughters = new Map();
    const uniqueDaughters = [...new Set(daughterIds)];
    for (let i = 0; i < uniqueDaughters.length; i += 200) {
      const query = uniqueDaughters.slice(i, i + 200).map((id) => `filter[id][]=${id}`).join("&");
      try {
        const res = await amo["request"](`/leads?${query}&limit=250`);
        for (const lead of res?._embedded?.leads || []) daughters.set(String(lead.id), lead);
      } catch (e) {
        console.error(`дочерние ${i}: ${e?.message || e}`);
      }
      await sleep(AMO_PAUSE_MS);
    }

    const registry = await prisma.registryDeal.findMany({
      select: { contractNumber: true, project: true, brokerId: true, saleChannel: true, amoLeadId: true, paidAt: true, amount: true },
    });
    const registryByContract = new Map();
    const registryByLead = new Map();
    for (const r of registry) {
      const key = contractKey(r.contractNumber);
      if (key) {
        if (!registryByContract.has(key)) registryByContract.set(key, []);
        registryByContract.get(key).push(r);
      }
      if (r.amoLeadId !== null && r.amoLeadId !== undefined) registryByLead.set(String(r.amoLeadId), r);
    }
    const brokerIds = [...new Set(registry.map((r) => r.brokerId).filter(Boolean))];
    const brokerRows = await prisma.broker.findMany({ where: { id: { in: brokerIds } }, select: { id: true, fullName: true, phone: true } });
    const brokerById = new Map(brokerRows.map((b) => [b.id, b]));

    let withDeal = 0, withBroker = 0, direct = 0;
    console.log("\n=== 2. Карточки «от брокера» без фиксации: детали ===");
    console.log("  лид | дата встречи | клиент | телефон | сделка | № договора | реестр | брокер сделки | канал");
    for (const item of claimed) {
      const when = leadMeetingDate(item.lead);
      const daughter = item.daughterId ? daughters.get(item.daughterId) : null;
      const contractRaw = daughter ? leadFieldById(daughter, CONTRACT_FIELD_ID) : null;
      let deal = item.daughterId ? registryByLead.get(item.daughterId) : null;
      if (!deal && contractRaw) deal = (registryByContract.get(contractKey(contractRaw)) || [])[0] || null;
      if (deal) withDeal++;
      const broker = deal?.brokerId ? brokerById.get(deal.brokerId) : null;
      if (broker) withBroker++;
      if (deal?.saleChannel === "DIRECT") direct++;
      console.log(
        `  ${item.lead.id} | ${dayKey(when)} | ${String(item.contact?.name || "—").slice(0, 28)} | ${item.phones.join(" ") || "—"} | ` +
        `${item.daughterId || "—"} | ${contractRaw || "—"} | ${deal ? `${deal.project || "—"} ${dayKey(deal.paidAt)} ${deal.amount ?? "—"}₽` : "нет"} | ` +
        `${broker ? broker.fullName : "—"} | ${deal?.saleChannel || "—"}`,
      );
    }

    console.log("\n=== 3. Итог по карточкам «от брокера» без фиксации ===");
    console.log(`  всего: ${claimed.length}`);
    console.log(`  дошли до сделки в реестре: ${withDeal}`);
    console.log(`  в сделке указан брокер: ${withBroker}`);
    console.log(`  сделка оказалась прямой продажей: ${direct}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error("FATAL:", e?.stack || e?.message || e);
  process.exit(1);
});
