#!/usr/bin/env node
/**
 * Backfill: превращает существующие Document.subcategory (строка) в реальные
 * записи MaterialFolder и проставляет Document.folderId.
 *
 * Идемпотентно: повторный запуск не создаст дубли (upsert по name).
 * Затрагивает только documents с category IN ('marketing', 'materials') —
 * cooperation/analytics на лендинге показываются плоским списком без папок.
 *
 * Запуск (после `prisma db push`):
 *   node scripts/backfill-material-folders.js
 *   DRY_RUN=1 node scripts/backfill-material-folders.js
 *
 * Введено 2026-07-13 вместе с полноценным редактором папок в /admin/documents.
 */

let PrismaClient;
try {
  ({ PrismaClient } = require('@prisma/client'));
} catch (_) {
  try {
    ({ PrismaClient } = require('../packages/database/node_modules/@prisma/client'));
  } catch (e) {
    console.error('Cannot find @prisma/client');
    process.exit(1);
  }
}

const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const FOLDER_CATEGORIES = ['marketing', 'materials'];

async function main() {
  const prisma = new PrismaClient();
  try {
    const docs = await prisma.document.findMany({
      where: {
        subcategory: { not: null },
        category: { in: FOLDER_CATEGORIES },
        folderId: null,
      },
      select: { id: true, subcategory: true, sortOrder: true },
    });
    if (docs.length === 0) {
      console.log('[backfill] Нет документов, требующих привязки к папке.');
      return;
    }

    // Уникальные имена папок из subcategory, сохраняя порядок первого появления
    const seen = new Set();
    const folderNames = [];
    for (const d of docs) {
      const name = (d.subcategory || '').trim();
      if (!name) continue;
      if (!seen.has(name)) {
        seen.add(name);
        folderNames.push(name);
      }
    }

    console.log(`[backfill] Документов без папки: ${docs.length}. Уникальных имён: ${folderNames.length}.`);
    if (DRY_RUN) {
      console.log('[backfill] DRY_RUN — ничего не пишем. Список папок:');
      for (const n of folderNames) console.log('  -', n);
      return;
    }

    const nameToId = new Map();
    for (let i = 0; i < folderNames.length; i++) {
      const name = folderNames[i];
      const folder = await prisma.materialFolder.upsert({
        where: { name },
        update: {},
        create: {
          name,
          sortOrder: (i + 1) * 10,
          showInCabinet: true,
          showOnLanding: true,
        },
      });
      nameToId.set(name, folder.id);
    }

    let attached = 0;
    for (const d of docs) {
      const name = (d.subcategory || '').trim();
      const folderId = nameToId.get(name);
      if (!folderId) continue;
      await prisma.document.update({
        where: { id: d.id },
        data: { folderId },
      });
      attached++;
    }

    console.log(`[backfill] Создано/подхвачено папок: ${nameToId.size}. Привязано документов: ${attached}.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error('[backfill] error:', e);
  process.exit(1);
});
