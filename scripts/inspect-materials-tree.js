#!/usr/bin/env node
/**
 * 2026-09-10 (владелец: «проверь все материалы»): дерево материалов —
 * какие папки есть, сколько в них фото и видео, у каких папок нет обложки
 * и какие файлы лежат прямо в папке без подпапки. Печатает и текущую
 * раскладку MATERIALS_FOLDER_LAYOUT. Только чтение.
 */
const VIDEO_RE = /\.(mp4|mov|webm|m4v|avi|mkv)(\?|#|$)/i;
const IMAGE_RE = /\.(jpe?g|png|webp|gif|svg|heic|avif|bmp|tiff?)(\?|#|$)/i;

const splitPath = (v) => String(v || "").split("/").map((s) => s.trim()).filter(Boolean);

async function main() {
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    const setting = await prisma.systemSetting.findUnique({ where: { key: "MATERIALS_FOLDER_LAYOUT" } });
    let layout = null;
    try { layout = setting?.value ? JSON.parse(setting.value) : null; } catch (e) { console.error("раскладка не парсится:", e?.message); }
    console.log(`=== Текущая раскладка: ${setting ? "есть" : "НЕТ (используется дефолт)"} ===`);
    if (layout) {
      console.log(`  групп: ${(layout.groups || []).length}, правил: ${(layout.rules || []).length}`);
      console.log(`  обложек задано: ${Object.keys(layout.covers || {}).length}`);
      for (const [k, v] of Object.entries(layout.covers || {})) console.log(`    COVER\t${k}\t${v}`);
      console.log(`  виртуальных подпапок: ${Object.keys(layout.looseFolders || {}).length}`);
      for (const [k, v] of Object.entries(layout.looseFolders || {})) console.log(`    LOOSE\t${k}\t${v}`);
    }

    const docs = await prisma.document.findMany({
      where: { category: "materials" },
      select: { id: true, name: true, subcategory: true, fileUrl: true, type: true, isPublic: true, fileSize: true },
      orderBy: [{ subcategory: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
    });
    console.log(`\n=== Материалов всего: ${docs.length} ===`);

    const byFolder = new Map();
    for (const d of docs) {
      const key = splitPath(d.subcategory).join("/");
      if (!byFolder.has(key)) byFolder.set(key, []);
      byFolder.get(key).push(d);
    }

    const kindOf = (d) => (VIDEO_RE.test(d.fileUrl) ? "видео" : IMAGE_RE.test(d.fileUrl) ? "фото" : "документ");
    const folders = [...byFolder.keys()].sort();
    console.log("\n=== Папки: путь | фото | видео | документы ===");
    for (const key of folders) {
      const items = byFolder.get(key);
      const c = { "фото": 0, "видео": 0, "документ": 0 };
      for (const d of items) c[kindOf(d)]++;
      const hasCover = layout?.covers?.[key] ? "обложка задана" : "";
      console.log(`  FOLDER\t${key || "(корень)"}\t${c["фото"]}\t${c["видео"]}\t${c["документ"]}\t${hasCover}`);
    }

    console.log("\n=== Файлы по папкам (для подбора обложек) ===");
    for (const key of folders) {
      for (const d of byFolder.get(key)) {
        console.log(`  FILE\t${key}\t${kindOf(d)}\t${d.name}\t${d.fileUrl}`);
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error("FATAL:", e?.stack || e?.message || e);
  process.exit(1);
});
