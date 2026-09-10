#!/usr/bin/env node
/**
 * 2026-09-10 (разбор обращений от Алины): три конкретных случая.
 *   1) телефон брокера 9252212177 — форма говорит, что он занят другой
 *      карточкой; проверяем, чья это карточка и есть ли отдельная карточка
 *      «Субоч Евгений»;
 *   2) клиент Андрей 9639758274 — заведён ли, на кого;
 *   3) клиент Елена 9253761785 — почему заявка долго «на проверке».
 * Только чтение.
 */
const BROKER_PHONES = ["9252212177"];
const BROKER_NAMES = ["субоч", "ковалева анастасия"];
const CLIENT_PHONES = ["9639758274", "9253761785"];

const phoneKeys = (raw) => {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.length === 10) return [digits];
  if (digits.length === 11 && (digits[0] === "7" || digits[0] === "8")) return [digits.slice(1)];
  if (digits.length > 11) return [digits.slice(1, 11)];
  return digits ? [digits] : [];
};

const day = (d) => (d ? new Date(d).toISOString().slice(0, 16).replace("T", " ") : "—");

async function main() {
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    console.log("=== 1. Карточки брокеров по телефону 9252212177 ===");
    const brokers = await prisma.broker.findMany({
      select: {
        id: true, fullName: true, displayName: true, phone: true, email: true, status: true,
        role: true, amoContactId: true, mergedIntoId: true, createdAt: true, funnelStage: true,
      },
    });
    const extra = await prisma.brokerPhone.findMany({ select: { brokerId: true, phone: true, isPrimary: true } });
    const extraByBroker = new Map();
    for (const row of extra) {
      if (!extraByBroker.has(row.brokerId)) extraByBroker.set(row.brokerId, []);
      extraByBroker.get(row.brokerId).push(row.phone);
    }
    const wanted = new Set(BROKER_PHONES.flatMap(phoneKeys));
    const byPhone = brokers.filter((b) => {
      const own = phoneKeys(b.phone);
      const more = (extraByBroker.get(b.id) || []).flatMap(phoneKeys);
      return [...own, ...more].some((key) => wanted.has(key));
    });
    for (const b of byPhone) {
      console.log(
        `  BROKER ${b.id} · «${b.fullName}»${b.displayName ? ` (для работы: ${b.displayName})` : ""} · ${b.phone} · статус ${b.status} · роль ${b.role} · amo ${b.amoContactId ?? "нет"} · создан ${day(b.createdAt)}${b.mergedIntoId ? " · ОБЪЕДИНЁН в " + b.mergedIntoId : ""}`,
      );
      const more = extraByBroker.get(b.id) || [];
      if (more.length) console.log(`         доп. номера: ${more.join(", ")}`);
    }
    if (!byPhone.length) console.log("  (карточек с таким номером нет)");

    console.log("\n=== 1б. Карточки, похожие по фамилии ===");
    for (const name of BROKER_NAMES) {
      const found = brokers.filter((b) => String(b.fullName || "").toLowerCase().includes(name));
      console.log(`  «${name}»: ${found.length}`);
      for (const b of found.slice(0, 10)) {
        console.log(
          `    ${b.id} · «${b.fullName}» · ${b.phone} · статус ${b.status} · amo ${b.amoContactId ?? "нет"} · создан ${day(b.createdAt)}${b.mergedIntoId ? " · ОБЪЕДИНЁН" : ""}`,
        );
      }
    }

    console.log("\n=== 2. Клиенты по телефонам ===");
    const clients = await prisma.client.findMany({
      select: {
        id: true, fullName: true, phone: true, project: true, brokerId: true,
        responsibleBrokerId: true, uniquenessStatus: true, uniquenessReason: true,
        uniquenessExpiresAt: true, amoLeadId: true, amoSyncStatus: true, amoSyncError: true,
        createdAt: true, updatedAt: true,
      },
    });
    const brokerById = new Map(brokers.map((b) => [b.id, b]));
    const wantedClients = new Set(CLIENT_PHONES.flatMap(phoneKeys));
    const hits = clients.filter((c) => phoneKeys(c.phone).some((key) => wantedClients.has(key)));
    for (const c of hits) {
      const broker = brokerById.get(c.brokerId);
      const responsible = c.responsibleBrokerId ? brokerById.get(c.responsibleBrokerId) : null;
      console.log(
        `  CLIENT ${c.id} · «${c.fullName}» · ${c.phone} · ${c.project} · статус ${c.uniquenessStatus} · до ${day(c.uniquenessExpiresAt)}`,
      );
      console.log(
        `         брокер: ${broker ? `«${broker.fullName}» (${broker.id}, статус ${broker.status})` : c.brokerId}` +
        (responsible && responsible.id !== broker?.id ? ` · ответственный: «${responsible.fullName}»` : ""),
      );
      console.log(
        `         amo лид ${c.amoLeadId ?? "нет"} · синхронизация ${c.amoSyncStatus ?? "—"}${c.amoSyncError ? ` (${c.amoSyncError})` : ""} · создан ${day(c.createdAt)} · изменён ${day(c.updatedAt)}`,
      );
      if (c.uniquenessReason) console.log(`         причина: ${String(c.uniquenessReason).slice(0, 200)}`);
    }
    if (!hits.length) console.log("  (клиентов с такими телефонами нет)");

    console.log("\n=== 3. Заявки «на проверке» дольше суток ===");
    const stale = clients
      .filter((c) => String(c.uniquenessStatus) === "UNDER_REVIEW")
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    console.log(`  всего UNDER_REVIEW: ${stale.length}`);
    const dayAgo = Date.now() - 24 * 3600 * 1000;
    const old = stale.filter((c) => new Date(c.createdAt).getTime() < dayAgo);
    console.log(`  из них старше суток: ${old.length}`);
    for (const c of old.slice(0, 15)) {
      const broker = brokerById.get(c.brokerId);
      console.log(
        `    ${day(c.createdAt)} · «${c.fullName}» · ${c.phone} · брокер «${broker?.fullName || c.brokerId}» · лид ${c.amoLeadId ?? "нет"}`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error("FATAL:", e?.stack || e?.message || e);
  process.exit(1);
});
