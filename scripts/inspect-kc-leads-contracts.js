#!/usr/bin/env node
/**
 * 2026-09-10 (идея владельца): у карточки колл-центра есть поле
 * cc_id_daughter — дочерний лид в воронке продаж, а у него «№ договора».
 * Через номер договора карточка КЦ связывается со строкой реестра ДДУ,
 * где уже известны брокер и канал продажи (DIRECT/BROKER). Значит часть
 * спорных карточек можно закрыть не гаданием по фиксациям, а фактом
 * сделки — а прямые продажи вообще снять с разбора.
 * Только чтение: ни одной записи в базу и в amoCRM.
 */
const KC_PIPELINE_ID = 7600542;
const KC_MEETING_HELD_STATUS = 142;
const AMO_PAUSE_MS = 280;
const CONTRACT_FIELD_ID = 558577; // «№ договора» в лиде

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
const topOf = (map, limit = 15) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);

function table(title, rows, total) {
  console.log(`\n=== ${title} ===`);
  if (!rows.length) return console.log("  (пусто)");
  for (const [label, value, note] of rows) {
    const share = total && typeof value === "number" ? `  ${Math.round((value / total) * 100)}%` : "";
    console.log(`  ${String(label).padEnd(50)} ${String(value).padStart(6)}${share}${note ? "  · " + note : ""}`);
  }
}

async function main() {
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    const amo = await initAmo(prisma);

    // ---------- 1. карточки КЦ «встреча проведена»
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

    // ---------- 2. дочерние лиды воронки продаж
    const daughterByLead = new Map();
    for (const lead of leads) {
      const raw = String(leadCustomField(lead, "cc_id_daughter") || "").replace(/\D/g, "");
      if (raw) daughterByLead.set(lead.id, raw);
    }
    const daughterIds = [...new Set(daughterByLead.values())];
    console.log(`Из них с ссылкой на дочернюю сделку (cc_id_daughter): ${daughterByLead.size}, разных сделок ${daughterIds.length}`);

    const daughters = new Map();
    for (let i = 0; i < daughterIds.length; i += 200) {
      const chunk = daughterIds.slice(i, i + 200);
      const query = chunk.map((id) => `filter[id][]=${id}`).join("&");
      try {
        const res = await amo["request"](`/leads?${query}&limit=250`);
        for (const lead of res?._embedded?.leads || []) daughters.set(String(lead.id), lead);
      } catch (e) {
        console.error(`дочерние ${i}: ${e?.message || e}`);
      }
      await sleep(AMO_PAUSE_MS);
    }
    console.log(`Дочерних сделок загружено: ${daughters.size}`);

    // ---------- 3. реестр ДДУ
    const registry = await prisma.registryDeal.findMany({
      select: { id: true, contractNumber: true, project: true, brokerId: true, saleChannel: true, amoLeadId: true, paidAt: true, amount: true },
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

    const clients = await prisma.client.findMany({
      select: { id: true, phone: true, brokerId: true, amoLeadId: true, createdAt: true, uniquenessStatus: true, uniquenessExpiresAt: true, comment: true },
    });
    const byPhone = new Map();
    for (const c of clients) {
      for (const key of phoneKeyCandidates(c.phone)) {
        if (!byPhone.has(key)) byPhone.set(key, []);
        byPhone.get(key).push(c);
      }
    }

    // телефоны брокеров: сама карточка + дополнительные номера
    const brokers = await prisma.broker.findMany({ where: { mergedIntoId: null }, select: { id: true, phone: true } });
    const extraPhones = await prisma.brokerPhone.findMany({ select: { brokerId: true, phone: true } });
    const brokerByPhone = new Map();
    for (const b of brokers) for (const key of phoneKeyCandidates(b.phone)) brokerByPhone.set(key, b.id);
    for (const ph of extraPhones) for (const key of phoneKeyCandidates(ph.phone)) if (!brokerByPhone.has(key)) brokerByPhone.set(key, ph.brokerId);

    const contactIdByLead = new Map();
    const allContactIdsByLead = new Map();
    for (const lead of leads) {
      const contacts = lead?._embedded?.contacts || [];
      const main = contacts.find((c) => c.is_main) || contacts[0];
      if (main?.id) contactIdByLead.set(lead.id, Number(main.id));
      allContactIdsByLead.set(lead.id, contacts.map((c) => Number(c.id)).filter(Boolean));
    }
    const everyContactId = new Set();
    for (const ids of allContactIdsByLead.values()) for (const id of ids) everyContactId.add(id);
    const contactMap = await amo.getContactsByIds([...everyContactId]);
    console.log(`Контактов у карточек: ${everyContactId.size} (главных ${contactIdByLead.size})`);

    const isActiveOn = (client, when) => {
      if (!when) return false;
      if (String(client.uniquenessStatus) === "REJECTED") return false;
      const from = client.createdAt ? new Date(client.createdAt).getTime() : 0;
      const to = client.uniquenessExpiresAt ? new Date(client.uniquenessExpiresAt).getTime() : 0;
      if (!to) return false;
      const t = when.getTime();
      return t >= from - 86400000 && t <= to + 86400000;
    };

    // ---------- 4. разбор
    const groupCounts = new Map();
    const stats = {
      withDaughter: 0, daughterFound: 0, withContract: 0,
      registryByContract: 0, registryByLead: 0, registryAny: 0,
    };
    const noneActive = { total: 0, deal: 0, direct: 0, broker: 0, unmarked: 0, brokerMatchesCandidate: 0, brokerOther: 0,
      contactBroker: 0, contactBrokerAmongCandidates: 0, contactBrokerOther: 0 };
    const brokerContactStats = { leadsWithBrokerContact: 0, leadsWithClientAndBroker: 0 };
    const unmatched = { total: 0, deal: 0, direct: 0, broker: 0, unmarked: 0 };
    const ambiguousActive1 = { total: 0, deal: 0, agreeWithActive: 0, disagree: 0 };
    const contractShapes = new Map();

    for (const lead of leads) {
      const contact = contactMap.get(contactIdByLead.get(lead.id));
      const when = leadMeetingDate(lead);
      const keys = contact ? contactPhoneKeys(contact) : [];
      const candidates = [];
      for (const key of keys) for (const c of byPhone.get(key) || []) if (!candidates.some((x) => x.id === c.id)) candidates.push(c);
      const active = candidates.filter((c) => isActiveOn(c, when));

      // брокер, прикреплённый к карточке вторым контактом
      const brokerIdsOnLead = new Set();
      for (const cid of allContactIdsByLead.get(lead.id) || []) {
        const c = contactMap.get(cid);
        if (!c) continue;
        for (const key of contactPhoneKeys(c)) {
          const bid = brokerByPhone.get(key);
          if (bid) brokerIdsOnLead.add(bid);
        }
      }
      if (brokerIdsOnLead.size) brokerContactStats.leadsWithBrokerContact++;
      if (brokerIdsOnLead.size && candidates.length) brokerContactStats.leadsWithClientAndBroker++;

      const group = !candidates.length ? "нет клиента с таким телефоном"
        : candidates.length === 1 ? "один клиент — привязано"
        : active.length === 1 ? "спорно, но действующий один"
        : active.length === 0 ? "спорно, действующих нет"
        : "спорно, действующих несколько";
      bump(groupCounts, group);

      // сделка
      const daughterId = daughterByLead.get(lead.id);
      if (daughterId) stats.withDaughter++;
      const daughter = daughterId ? daughters.get(daughterId) : null;
      if (daughter) stats.daughterFound++;
      const contractRaw = daughter ? leadFieldById(daughter, CONTRACT_FIELD_ID) : null;
      if (contractRaw) {
        stats.withContract++;
        bump(contractShapes, String(contractRaw).trim().replace(/[0-9]+/g, "9").slice(0, 24));
      }
      let deal = null;
      if (daughterId && registryByLead.has(daughterId)) { deal = registryByLead.get(daughterId); stats.registryByLead++; }
      if (!deal && contractRaw) {
        const hit = registryByContract.get(contractKey(contractRaw)) || [];
        if (hit.length) { deal = hit[0]; stats.registryByContract++; }
      }
      if (deal) stats.registryAny++;

      const channelOf = (d) => (d.saleChannel === "DIRECT" ? "direct" : d.saleChannel === "BROKER" ? "broker" : "unmarked");

      if (group === "спорно, действующих нет") {
        noneActive.total++;
        if (brokerIdsOnLead.size) {
          noneActive.contactBroker++;
          if ([...brokerIdsOnLead].some((bid) => candidates.some((c) => c.brokerId === bid))) noneActive.contactBrokerAmongCandidates++;
          else noneActive.contactBrokerOther++;
        }
        if (deal) {
          noneActive.deal++;
          noneActive[channelOf(deal)]++;
          if (deal.brokerId) {
            if (candidates.some((c) => c.brokerId === deal.brokerId)) noneActive.brokerMatchesCandidate++;
            else noneActive.brokerOther++;
          }
        }
      } else if (group === "нет клиента с таким телефоном") {
        unmatched.total++;
        if (deal) { unmatched.deal++; unmatched[channelOf(deal)]++; }
      } else if (group === "спорно, но действующий один") {
        ambiguousActive1.total++;
        if (deal) {
          ambiguousActive1.deal++;
          if (deal.brokerId && active[0]?.brokerId) {
            if (deal.brokerId === active[0].brokerId) ambiguousActive1.agreeWithActive++;
            else ambiguousActive1.disagree++;
          }
        }
      }
    }

    table("1. Карточки КЦ по группам", topOf(groupCounts, 8), leads.length);

    table("2. Мост «карточка КЦ → сделка → реестр»", [
      ["Есть ссылка на дочернюю сделку", stats.withDaughter],
      ["Дочерняя сделка найдена в amoCRM", stats.daughterFound],
      ["У сделки заполнен № договора", stats.withContract],
      ["Нашлась строка реестра по номеру лида", stats.registryByLead],
      ["Нашлась строка реестра по номеру договора", stats.registryByContract],
      ["ИТОГО связано с реестром", stats.registryAny],
    ], leads.length);

    table("3. Спорные, где действующих фиксаций не было", [
      ["Таких карточек", noneActive.total],
      ["Из них дошли до сделки в реестре", noneActive.deal],
      ["  прямая продажа (брокер не нужен)", noneActive.direct, "снимаются с разбора"],
      ["  сделка с брокером", noneActive.broker],
      ["  канал не размечен", noneActive.unmarked],
      ["  брокер сделки есть среди кандидатов", noneActive.brokerMatchesCandidate, "ответ найден фактом сделки"],
      ["  брокер сделки не из кандидатов", noneActive.brokerOther],
      ["К карточке прикреплён брокер вторым контактом", noneActive.contactBroker, "прямое указание"],
      ["  этот брокер есть среди кандидатов", noneActive.contactBrokerAmongCandidates, "ответ найден"],
      ["  брокер не из кандидатов по телефону", noneActive.contactBrokerOther],
    ], noneActive.total);

    table("3б. Брокер вторым контактом — по всем карточкам КЦ", [
      ["Карточек, где среди контактов есть брокер", brokerContactStats.leadsWithBrokerContact],
      ["Из них есть и клиент кабинета", brokerContactStats.leadsWithClientAndBroker],
    ], leads.length);

    table("4. Карточки без клиента в кабинете", [
      ["Таких карточек", unmatched.total],
      ["Из них дошли до сделки в реестре", unmatched.deal],
      ["  прямая продажа", unmatched.direct],
      ["  сделка с брокером", unmatched.broker],
      ["  канал не размечен", unmatched.unmarked],
    ], unmatched.total);

    table("5. Проверка правила «действующая фиксация» фактом сделки", [
      ["Спорных с одним действующим", ambiguousActive1.total],
      ["Из них дошли до сделки", ambiguousActive1.deal],
      ["  брокер сделки совпал с действующим", ambiguousActive1.agreeWithActive, "правило подтверждается"],
      ["  брокер сделки другой", ambiguousActive1.disagree, "правило ошибается"],
    ], ambiguousActive1.total);

    table("6. Формы записи № договора в дочерних сделках", topOf(contractShapes, 12), stats.withContract);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error("FATAL:", e?.stack || e?.message || e);
  process.exit(1);
});
