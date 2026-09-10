#!/usr/bin/env node
/**
 * 2026-09-10 (три вопроса владельца по карточкам колл-центра):
 *   1) 739 спорных: были ли остальные кандидаты НЕ действующими на дату встречи;
 *   2) 2 011 без совпадения: что за источник у этих клиентов (самоход, реклама…);
 *   3) 1 464 «кандидата в туры»: сколько там настоящих туров, а сколько встреч,
 *      ошибочно принятых за тур из-за слова «брокер».
 * Только чтение: ни одной записи в базу и в amoCRM.
 */
const KC_PIPELINE_ID = 7600542;
const KC_MEETING_HELD_STATUS = 142;
const AMO_PAUSE_MS = 280;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function phoneKeyCandidates(raw) {
  const keys = new Set();
  let badFormat = false;
  const chunks = String(raw || "").split(/[,;\/]|\s(?:или|и)\s/);
  for (const chunk of chunks) {
    const digits = chunk.replace(/\D/g, "");
    if (!digits) continue;
    if (digits.length === 10) keys.add(digits);
    else if (digits.length === 11 && (digits[0] === "7" || digits[0] === "8")) keys.add(digits.slice(1));
    else if (digits.length > 11 && (digits[0] === "7" || digits[0] === "8")) keys.add(digits.slice(1, 11));
    else badFormat = true;
  }
  return { keys: [...keys], badFormat };
}

const leadCustomField = (lead, name) => {
  const f = (lead?.custom_fields_values || []).find((x) => x.field_name === name);
  return f?.values?.[0]?.value ?? null;
};

function leadMeetingDate(lead) {
  const raw = leadCustomField(lead, "Дата и время встречи");
  for (const candidate of [raw, lead?.closed_at, lead?.created_at]) {
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
    for (const v of field.values || []) {
      for (const key of phoneKeyCandidates(v?.value).keys) out.add(key);
    }
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

const table = (title, rows) => {
  console.log(`\n=== ${title} ===`);
  if (!rows.length) return console.log("  (пусто)");
  for (const [label, value, note] of rows) {
    console.log(`  ${String(label).padEnd(52)} ${String(value).padStart(7)}${note ? "  · " + note : ""}`);
  }
};

const topOf = (map, limit = 12) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);

async function main() {
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    const amo = await initAmo(prisma);

    // ---------- 1. карточки КЦ со статусом «встреча проведена»
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

    // ---------- 2. контакты и клиенты
    const contactIdByLead = new Map();
    for (const lead of leads) {
      const contacts = lead?._embedded?.contacts || [];
      const main = contacts.find((c) => c.is_main) || contacts[0];
      if (main?.id) contactIdByLead.set(lead.id, Number(main.id));
    }
    const contactMap = await amo.getContactsByIds([...new Set(contactIdByLead.values())]);
    const clients = await prisma.client.findMany({
      select: {
        id: true, phone: true, brokerId: true, amoLeadId: true, createdAt: true,
        uniquenessStatus: true, uniquenessExpiresAt: true, comment: true,
      },
    });
    const byPhone = new Map();
    for (const c of clients) {
      for (const key of phoneKeyCandidates(c.phone).keys) {
        if (!byPhone.has(key)) byPhone.set(key, []);
        byPhone.get(key).push(c);
      }
    }

    // ---------- 3. разбор
    const ambiguous = { total: 0, active0: 0, active1: 0, active2plus: 0, byLead: 0, oldOnly: 0 };
    const unmatchedFields = new Map();   // имя поля → счётчик
    const unmatchedValues = new Map();   // «поле = значение» → счётчик
    let unmatchedTotal = 0;
    const tourField = new Map();         // значение поля «Встреча» → счётчик
    const tour = { total: 0, slovoTur: 0, tolkoBroker: 0 };

    const isActiveOn = (client, when) => {
      if (!when) return false;
      if (String(client.uniquenessStatus) === "REJECTED") return false;
      const from = client.createdAt ? new Date(client.createdAt).getTime() : 0;
      const to = client.uniquenessExpiresAt ? new Date(client.uniquenessExpiresAt).getTime() : 0;
      if (!to) return false;
      const t = when.getTime();
      return t >= from - 86400000 && t <= to + 86400000;
    };

    for (const lead of leads) {
      const contact = contactMap.get(contactIdByLead.get(lead.id));
      const when = leadMeetingDate(lead);
      const keys = contact ? contactPhoneKeys(contact) : [];
      const candidates = [];
      for (const key of keys) {
        for (const c of byPhone.get(key) || []) if (!candidates.some((x) => x.id === c.id)) candidates.push(c);
      }

      if (!candidates.length) {
        unmatchedTotal++;
        for (const f of lead?.custom_fields_values || []) {
          const name = String(f.field_name || "").trim();
          if (!name) continue;
          unmatchedFields.set(name, (unmatchedFields.get(name) || 0) + 1);
          const value = String(f.values?.[0]?.value ?? "").trim().slice(0, 40);
          if (value) {
            const key = `${name} = ${value}`;
            unmatchedValues.set(key, (unmatchedValues.get(key) || 0) + 1);
          }
        }
        continue;
      }

      if (candidates.length > 1) {
        ambiguous.total++;
        const byLeadMatch = candidates.find((c) => c.amoLeadId && String(c.amoLeadId) === String(lead.id));
        if (byLeadMatch) ambiguous.byLead++;
        const active = candidates.filter((c) => isActiveOn(c, when));
        if (active.length === 0) ambiguous.active0++;
        else if (active.length === 1) ambiguous.active1++;
        else ambiguous.active2plus++;
        if (candidates.every((c) => String(c.comment || "").includes("[old-cabinet:"))) ambiguous.oldOnly++;
      }

      // мнимые туры: поле «Встреча»
      const meetingField = String(leadCustomField(lead, "Встреча") || "").toLowerCase();
      if (meetingField.includes("тур") || meetingField.includes("брокер")) {
        tour.total++;
        if (meetingField.includes("тур")) tour.slovoTur++;
        else tour.tolkoBroker++;
        const raw = String(leadCustomField(lead, "Встреча") || "").trim().slice(0, 45);
        tourField.set(raw, (tourField.get(raw) || 0) + 1);
      }
    }

    table("1. Спорные карточки: сколько кандидатов было действующими на дату встречи", [
      ["Спорных карточек (кандидатов больше одного)", ambiguous.total],
      ["Ни один кандидат не был действующим", ambiguous.active0, "встречу привязывать не к кому"],
      ["РОВНО ОДИН действующий кандидат", ambiguous.active1, "спор снимается, можно привязать"],
      ["Действующих двое и больше", ambiguous.active2plus, "остаётся на ваше решение"],
      ["Совпадение прямо по номеру карточки amoCRM", ambiguous.byLead, "самый надёжный признак"],
      ["Все кандидаты только из старого кабинета", ambiguous.oldOnly],
    ]);

    table("2. Карточки без совпадения: какие поля заполнены", topOf(unmatchedFields, 14).map(([k, v]) => [k, v, `${Math.round((v / Math.max(unmatchedTotal, 1)) * 100)}%`]));
    table("2б. Частые значения полей (сюда смотрим для источника)", topOf(unmatchedValues, 20).map(([k, v]) => [k, v]));
    console.log(`\n  Всего карточек без совпадения: ${unmatchedTotal}`);

    table("3. Мнимые брокер-туры: что в поле «Встреча»", [
      ["Карточек, помеченных как тур", tour.total],
      ["Из них со словом «тур» — настоящие туры", tour.slovoTur],
      ["Из них только со словом «брокер» — вероятно встречи", tour.tolkoBroker, "их мы теряем зря"],
    ]);
    table("3б. Конкретные значения поля «Встреча»", topOf(tourField, 15).map(([k, v]) => [k || "(пусто)", v]));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error("FATAL:", e?.stack || e?.message || e);
  process.exit(1);
});
