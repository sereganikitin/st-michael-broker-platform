#!/usr/bin/env node
/**
 * 2026-09-12: владелец обновил презентации по двум ЖК на Яндекс.Диске и
 * просит обновить их в кабинете. Прежде чем что-то тянуть — смотрим, какие
 * версии лежат на сервере: запись в базе, реальный размер файла на диске и
 * дата изменения. Сравнивать будем с размерами в публичной папке. Только
 * чтение.
 */
const fs = require("fs");
const path = require("path");

const UPLOAD_ROOT = process.env.UPLOAD_ROOT || "/app/uploads";

function localPathFor(fileUrl) {
  if (!fileUrl || !fileUrl.startsWith("/files/")) return null;
  const rel = decodeURIComponent(fileUrl.slice("/files/".length));
  return path.join(UPLOAD_ROOT, rel);
}

async function main() {
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    const docs = await prisma.document.findMany({
      where: {
        OR: [
          { subcategory: { startsWith: "Презентации проектов" } },
          { subcategory: { startsWith: "Презентации/Зорге" } },
          { subcategory: { startsWith: "Презентации/Квартал" } },
        ],
      },
      orderBy: [{ subcategory: "asc" }, { name: "asc" }],
      select: { id: true, name: true, subcategory: true, fileUrl: true, fileSize: true, updatedAt: true },
    });
    console.log(`=== Презентации в базе: ${docs.length} ===`);
    for (const d of docs) {
      const p = localPathFor(d.fileUrl);
      let onDisk = "нет файла";
      if (p && fs.existsSync(p)) {
        const st = fs.statSync(p);
        onDisk = `${(st.size / 1048576).toFixed(2)} МБ, изменён ${st.mtime.toISOString().slice(0, 16).replace("T", " ")}`;
      }
      const inDb = d.fileSize ? `${(d.fileSize / 1048576).toFixed(2)} МБ` : "—";
      console.log(`\n  ${d.subcategory} / ${d.name}`);
      console.log(`    в базе: ${inDb} | на диске: ${onDisk}`);
      console.log(`    запись обновлена: ${d.updatedAt.toISOString().slice(0, 16).replace("T", " ")}`);
    }

    console.log("\n=== Размеры в публичной папке «Презентации проектов» (для сравнения) ===");
    console.log("  Зорге 9. Общая презентация.pdf — 27.96 МБ");
    console.log("  КСБ. Общая презентация.pdf — 20.41 МБ");
    console.log("  Квартал Серебряный Бор — Отделка мест общего пользования.pdf — 11.76 МБ");
    console.log("  Пентхаусы — Квартал Серебряный Бор.pdf — 15.51 МБ");
    console.log("  Урбан Виллы — Квартал Серебряный Бор.pdf — 14.57 МБ");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
