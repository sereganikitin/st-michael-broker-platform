#!/usr/bin/env node
/**
 * 2026-09-10 (владелец: «видео без подпапки убрать в папку УТП, обложки
 * подобрать»): точечное обновление раскладки материалов
 * (SystemSetting MATERIALS_FOLDER_LAYOUT).
 *
 * Вход — JSON вида {"looseFolders": {...}, "covers": {...}}: ключ — путь
 * папки как на сайте («Зорге 9/Видео»), значение — имя виртуальной подпапки
 * или fileUrl фото-обложки. Группы и правила НЕ трогаются. Существующие
 * ключи перезаписываются только если пришли в файле; остальные остаются.
 *
 * Запуск в контейнере api (workflow apply-materials-layout.yml):
 *   DRY_RUN=1 node /app/scripts/apply-materials-layout.js /app/materials-layout-patch.json
 */
const fs = require("node:fs");

const KEY = "MATERIALS_FOLDER_LAYOUT";

async function main() {
  const dryRun = process.env.DRY_RUN !== "0";
  const file = process.argv[2] || "/app/materials-layout-patch.json";
  const patch = JSON.parse(fs.readFileSync(file, "utf8"));
  const covers = patch.covers && typeof patch.covers === "object" ? patch.covers : {};
  const looseFolders = patch.looseFolders && typeof patch.looseFolders === "object" ? patch.looseFolders : {};

  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    const setting = await prisma.systemSetting.findUnique({ where: { key: KEY } });
    if (!setting?.value) {
      console.error(`FATAL: настройка ${KEY} не найдена — раскладку сначала нужно сохранить из админки.`);
      process.exit(2);
    }
    const layout = JSON.parse(setting.value);
    if (layout.version !== 1 || !Array.isArray(layout.groups) || !Array.isArray(layout.rules)) {
      console.error("FATAL: раскладка не похожа на MaterialsFolderLayout — ничего не меняю.");
      process.exit(2);
    }

    const before = {
      covers: Object.keys(layout.covers || {}).length,
      loose: Object.keys(layout.looseFolders || {}).length,
    };
    const next = {
      ...layout,
      covers: { ...(layout.covers || {}), ...covers },
      looseFolders: { ...(layout.looseFolders || {}), ...looseFolders },
    };

    console.log(`=== Режим: ${dryRun ? "DRY-RUN" : "APPLY"} ===`);
    console.log(`Обложек было ${before.covers}, станет ${Object.keys(next.covers).length}`);
    console.log(`Виртуальных подпапок было ${before.loose}, станет ${Object.keys(next.looseFolders).length}`);
    for (const [path, value] of Object.entries(looseFolders)) {
      console.log(`  ПОДПАПКА  ${path} → «${value}»${layout.looseFolders?.[path] ? " (перезапись)" : ""}`);
    }
    for (const [path, value] of Object.entries(covers)) {
      const mark = layout.covers?.[path] ? "перезапись" : "новая";
      console.log(`  ОБЛОЖКА   ${path} → ${decodeURIComponent(String(value).split("/").pop() || "")} (${mark})`);
    }

    if (dryRun) {
      console.log("DRY-RUN: настройка не изменена");
      return;
    }
    await prisma.systemSetting.update({
      where: { key: KEY },
      data: { value: JSON.stringify(next), updatedBy: "apply-materials-layout" },
    });
    console.log(`Записано. Обложек ${Object.keys(next.covers).length}, подпапок ${Object.keys(next.looseFolders).length}.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error("FATAL:", e?.stack || e?.message || e);
  process.exit(1);
});
