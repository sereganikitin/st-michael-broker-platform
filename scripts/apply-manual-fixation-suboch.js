#!/usr/bin/env node
/**
 * 2026-09-10 (владелец: «Субоча заведи, у них по номеру всё верно, и чтобы
 * статус был уникален»). Одноразовая операция по конкретному обращению:
 *   1) карточке брокера с номером +7 925 221 21 77 ставим имя для работы
 *      «Субоч Евгений» — по правилу «фиксация по номеру, ФИО — последнее
 *      присланное»; самоназвание (full_name) не трогаем, прежнее имя уходит
 *      в журнал;
 *   2) заводим заявку на клиента Андрей +7 963 975 82 74 (Квартал
 *      Серебряный Бор) со статусом «уникален» на 30 дней.
 * Карточка в amoCRM создаётся штатной пятиминутной синхронизацией
 * (amo_sync_status = PENDING, amo_lead_id пустой) — руками в amo не лезем.
 *
 * DRY_RUN=1 по умолчанию: только отчёт.
 */
const BROKER_ID = "dca6575d-c37b-4dde-9447-f65323aaba9a";
const BROKER_NAME = "Субоч Евгений";
const CLIENT_NAME = "Андрей";
const CLIENT_PHONE = "+79639758274";
const PROJECT = "SILVER_BOR";
const UNIQUENESS_DAYS = 30;

const digits = (raw) => {
  const d = String(raw || "").replace(/\D/g, "");
  if (d.length === 11 && (d[0] === "7" || d[0] === "8")) return d.slice(1);
  return d;
};

async function main() {
  const dryRun = process.env.DRY_RUN !== "0";
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    console.log(`=== Режим: ${dryRun ? "DRY-RUN (без записи)" : "APPLY (запись)"} ===`);

    const broker = await prisma.broker.findUnique({
      where: { id: BROKER_ID },
      select: {
        id: true, fullName: true, displayName: true, phone: true, status: true,
        amoContactId: true, mergedIntoId: true,
        brokerAgencies: { select: { agencyId: true, isPrimary: true, agency: { select: { name: true, inn: true } } } },
      },
    });
    if (!broker) {
      console.error("FATAL: карточка брокера не найдена");
      process.exit(2);
    }
    if (broker.mergedIntoId) {
      console.error("FATAL: карточка объединена в другую — операция отменена");
      process.exit(2);
    }
    const link = broker.brokerAgencies.find((l) => l.isPrimary) || broker.brokerAgencies[0] || null;
    console.log(`Брокер: «${broker.displayName || broker.fullName}» · ${broker.phone} · статус ${broker.status} · amo ${broker.amoContactId ?? "нет"}`);
    console.log(`Агентство: ${link?.agency?.name || "не привязано"}${link?.agency?.inn ? ` (ИНН ${link.agency.inn})` : ""}`);

    // ---------- 1. имя для работы
    const currentName = String(broker.displayName || broker.fullName || "").trim();
    const needRename = currentName.toLowerCase() !== BROKER_NAME.toLowerCase();
    console.log(`\n1. Имя для работы: «${currentName}» → «${BROKER_NAME}» ${needRename ? "(меняем)" : "(уже такое)"}`);

    // ---------- 2. заявка на клиента
    const key = digits(CLIENT_PHONE);
    const sameParty = await prisma.client.findMany({
      where: { phone: { contains: key } },
      select: {
        id: true, fullName: true, phone: true, brokerId: true, uniquenessStatus: true,
        uniquenessExpiresAt: true, createdAt: true, amoLeadId: true,
        broker: { select: { fullName: true, displayName: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    console.log(`\n2. Заявки по номеру ${CLIENT_PHONE}: ${sameParty.length}`);
    for (const c of sameParty) {
      console.log(
        `   ${new Date(c.createdAt).toISOString().slice(0, 10)} · ${c.uniquenessStatus} · до ${c.uniquenessExpiresAt ? new Date(c.uniquenessExpiresAt).toISOString().slice(0, 10) : "—"} · брокер «${c.broker?.displayName || c.broker?.fullName}»`,
      );
    }
    const active = sameParty.filter(
      (c) =>
        (c.uniquenessStatus === "CONDITIONALLY_UNIQUE" || c.uniquenessStatus === "UNDER_REVIEW") &&
        (!c.uniquenessExpiresAt || new Date(c.uniquenessExpiresAt).getTime() > Date.now()),
    );
    if (active.length) {
      console.error(`ОТМЕНА: по номеру есть действующая заявка (${active.length}) — заводить вторую нельзя, это решает колл-центр.`);
      process.exit(3);
    }
    const alreadyOurs = sameParty.find((c) => c.brokerId === BROKER_ID);
    if (alreadyOurs) {
      console.log(`   у этого брокера заявка уже есть: ${alreadyOurs.id} (${alreadyOurs.uniquenessStatus})`);
    }
    const expiresAt = new Date(Date.now() + UNIQUENESS_DAYS * 24 * 3600 * 1000);
    console.log(`   создаём заявку: «${CLIENT_NAME}» · ${CLIENT_PHONE} · ${PROJECT} · уникален до ${expiresAt.toISOString().slice(0, 10)}`);

    if (dryRun) {
      console.log("\nDRY-RUN: ничего не записано");
      return;
    }

    if (needRename) {
      await prisma.broker.update({
        where: { id: BROKER_ID },
        data: { displayName: BROKER_NAME, displayNameSource: "manual" },
      });
      await prisma.auditLog.create({
        data: {
          action: "BROKER_NAME_UPDATED",
          entity: "Broker",
          entityId: BROKER_ID,
          payload: { previousName: currentName, submittedName: BROKER_NAME, source: "manual_ops_20260910" },
        },
      });
      console.log("   имя обновлено");
    }

    const client = await prisma.client.create({
      data: {
        brokerId: BROKER_ID,
        responsibleBrokerId: BROKER_ID,
        phone: CLIENT_PHONE,
        fullName: CLIENT_NAME,
        project: PROJECT,
        ...(link?.agencyId ? { fixationAgencyId: link.agencyId } : {}),
        uniquenessStatus: "CONDITIONALLY_UNIQUE",
        uniquenessExpiresAt: expiresAt,
        uniquenessReason: "Заведено вручную 10.09.2026 по обращению: форма падала из-за ошибки кабинета",
        comment: "Заявка восстановлена вручную (обращение от 10.09.2026)",
        // Пусть карточку в amoCRM создаст штатная синхронизация (каждые 5 минут).
        amoSyncStatus: "PENDING",
        amoSyncAttempts: 0,
        amoSyncError: null,
      },
      select: { id: true, uniquenessStatus: true, uniquenessExpiresAt: true },
    });
    await prisma.auditLog.create({
      data: {
        action: "CLIENT_FIXATION",
        entity: "Client",
        entityId: client.id,
        payload: { scenario: "MANUAL_OPS_20260910", brokerId: BROKER_ID, phone: CLIENT_PHONE },
      },
    });
    console.log(`\nГотово: заявка ${client.id} · ${client.uniquenessStatus} · до ${new Date(client.uniquenessExpiresAt).toISOString().slice(0, 10)}`);
    console.log("Карточка в amoCRM появится в ближайшие 5 минут (штатная синхронизация).");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error("FATAL:", e?.stack || e?.message || e);
  process.exit(1);
});
