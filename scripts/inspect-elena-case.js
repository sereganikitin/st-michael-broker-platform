#!/usr/bin/env node
/**
 * 2026-09-10: почему заявка по клиенту Елена (+7 925 376-17-85) висит
 * «на проверке», хотя карточка в amoCRM есть. Смотрим обе связанные
 * карточки amoCRM: старую (по которой уникальность уже выдана другому
 * брокеру) и новую, а также прикреплённые к ним контакты.
 * Только чтение.
 */
const LEADS = [32326897, 32326915, 32334324];

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

const PIPELINES = {
  7600542: "Колл-центр",
  7600546: "Продажи Берзарина",
  7600550: "Продажи Зорге 9",
  7600554: "Продажи Толбухина",
  10787390: "Брокеры",
};

const ts = (value) => (value ? new Date(Number(value) * 1000).toISOString().slice(0, 16).replace("T", " ") : "—");

async function main() {
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    const amo = await initAmo(prisma);
    let statuses = new Map();
    try {
      const res = await amo["request"]("/leads/pipelines");
      for (const pipeline of res?._embedded?.pipelines || []) {
        for (const status of pipeline?._embedded?.statuses || []) {
          statuses.set(`${pipeline.id}:${status.id}`, status.name);
        }
      }
    } catch (e) {
      console.error("воронки:", e?.message || e);
    }

    for (const id of LEADS) {
      let lead;
      try {
        lead = await amo["request"](`/leads/${id}?with=contacts`);
      } catch (e) {
        console.log(`\n=== Карточка ${id}: не получена (${e?.message || e}) ===`);
        continue;
      }
      const pipeline = PIPELINES[Number(lead.pipeline_id)] || `воронка ${lead.pipeline_id}`;
      const statusName = statuses.get(`${lead.pipeline_id}:${lead.status_id}`) || `статус ${lead.status_id}`;
      console.log(`\n=== Карточка ${id} ===`);
      console.log(`  название: ${lead.name}`);
      console.log(`  воронка: ${pipeline} · стадия: ${statusName} (${lead.status_id})`);
      console.log(`  создана: ${ts(lead.created_at)} · изменена: ${ts(lead.updated_at)} · закрыта: ${ts(lead.closed_at)}`);
      const contacts = lead?._embedded?.contacts || [];
      console.log(`  контактов на карточке: ${contacts.length}`);
      if (contacts.length) {
        const map = await amo.getContactsByIds(contacts.map((c) => Number(c.id)));
        for (const c of contacts) {
          const full = map.get(Number(c.id));
          console.log(`    ${c.id}${c.is_main ? " (главный)" : ""} · ${full?.name || "—"}`);
        }
      }
      for (const field of lead.custom_fields_values || []) {
        const name = String(field.field_name || "");
        if (/встреч|брокер|источник|этап/i.test(name)) {
          console.log(`    поле «${name}»: ${String(field.values?.[0]?.value ?? "").slice(0, 60)}`);
        }
      }
    }

    console.log("\n=== Заявки кабинета по этому телефону ===");
    const clients = await prisma.client.findMany({
      where: { phone: { contains: "9253761785" } },
      select: {
        id: true, fullName: true, uniquenessStatus: true, uniquenessReason: true,
        uniquenessExpiresAt: true, amoLeadId: true, createdAt: true,
        broker: { select: { fullName: true } },
        responsibleBroker: { select: { fullName: true } },
      },
      orderBy: { createdAt: "asc" },
    });
    for (const c of clients) {
      console.log(
        `  ${new Date(c.createdAt).toISOString().slice(0, 16).replace("T", " ")} · ${c.uniquenessStatus} · лид ${c.amoLeadId ?? "нет"} · кабинет: ${c.broker?.fullName} · ответственный: ${c.responsibleBroker?.fullName || "—"}`,
      );
      if (c.uniquenessReason) console.log(`      причина: ${String(c.uniquenessReason).slice(0, 160)}`);
    }

    console.log("");
    console.log("=== Карточки брокеров, участвующих в деле ===");
    const brokers = await prisma.broker.findMany({
      where: { fullName: { in: ["Екатерина брокер", "Работяева Лилия", "Кшнякин Денис"] } },
      select: { id: true, fullName: true, phone: true, status: true, amoContactId: true, mergedIntoId: true },
    });
    for (const b of brokers) {
      console.log(
        `  ${b.id} · «${b.fullName}» · ${b.phone} · статус ${b.status} · amo-контакт ${b.amoContactId ?? "НЕТ"}${b.mergedIntoId ? " · объединён" : ""}`,
      );
    }

    console.log("");
    console.log("=== Журнал по заявке (последние 20 записей) ===");
    const ids = clients.map((c) => c.id);
    const audit = await prisma.auditLog.findMany({
      where: { entity: "Client", entityId: { in: ids } },
      select: { createdAt: true, action: true, entityId: true, payload: true },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    for (const row of audit) {
      console.log(
        `  ${new Date(row.createdAt).toISOString().slice(0, 16).replace("T", " ")} · ${row.action} · ${row.entityId.slice(0, 8)} · ${JSON.stringify(row.payload).slice(0, 120)}`,
      );
    }
    if (!audit.length) console.log("  (записей нет)");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error("FATAL:", e?.stack || e?.message || e);
  process.exit(1);
});
