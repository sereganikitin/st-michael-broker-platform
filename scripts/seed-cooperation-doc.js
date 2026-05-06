#!/usr/bin/env node
/**
 * Сидит документ "Как начать сотрудничать с St Michael" в категорию cooperation.
 * Файл лежит как статика в apps/web/public/docs/ — fileUrl ведёт туда.
 *
 * Идемпотентен: если документ с таким description уже есть — обновляет его,
 * иначе создаёт. Безопасно запускать многократно.
 *
 * Запуск (на сервере): node /app/scripts/seed-cooperation-doc.js
 * Через workflow_dispatch — task=seed-cooperation-doc.
 */

let PrismaClient;
try {
  ({ PrismaClient } = require('@prisma/client'));
} catch (_) {
  ({ PrismaClient } = require('../packages/database/node_modules/@prisma/client'));
}

const DOC = {
  name: 'Как начать сотрудничать с St Michael',
  description: '[seed:cooperation-doc-howto]',
  type: 'DOCX',
  category: 'cooperation',
  fileUrl: '/docs/how-to-start-cooperation.docx',
  isPublic: true,
  sortOrder: 1,
};

(async () => {
  const prisma = new PrismaClient();

  const existing = await prisma.document.findFirst({
    where: { description: DOC.description },
  });

  if (existing) {
    await prisma.document.update({
      where: { id: existing.id },
      data: DOC,
    });
    console.log(`✓ Обновлён: ${DOC.name}`);
  } else {
    await prisma.document.create({ data: DOC });
    console.log(`✓ Создан: ${DOC.name}`);
  }

  await prisma.$disconnect();
})().catch((e) => {
  console.error('Error:', e?.message || e);
  process.exit(1);
});
