#!/usr/bin/env node
/**
 * Скачивает файлы с публичной папки Яндекс.Диска в /app/uploads/yandex/<subcat>/<name>
 * и записывает Document.fileUrl = /files/yandex/<subcat>/<name> в БД.
 *
 * Отличается от sync-yandex-disk.js тем, что тот хранит ссылки на Я.Диск
 * (для скачивания нужен один лишний клик через Я.Диск UI). Этот — кладёт
 * файлы локально, в браузере открывается превью напрямую (для JPG/MP4/PDF).
 *
 * Идемпотентно — пропускает файлы которые уже скачаны и не изменились.
 * Сравнивает по size. Если на Я.Диске файл удалён, локальный остаётся
 * (не чистим автоматически — могут быть линки в других местах).
 *
 * Запуск:
 *   node scripts/sync-yandex-files.js [public_url]
 *   FORCE=1 node scripts/sync-yandex-files.js   # перекачивает всё
 *
 * Cron: scheduler.service.ts handleYandexDiskFilesSync — раз в сутки.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_PUBLIC_KEY = 'https://disk.yandex.ru/d/8_w-xQ8PR3uz3w';
const PUBLIC_KEY = process.argv[2] || process.env.YANDEX_DISK_PUBLIC_KEY || DEFAULT_PUBLIC_KEY;
const UPLOAD_ROOT = process.env.UPLOAD_ROOT || '/app/uploads';
const TARGET_DIR = path.join(UPLOAD_ROOT, 'yandex');
const FORCE = process.env.FORCE === '1' || process.env.FORCE === 'true';

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

const API = 'https://cloud-api.yandex.net/v1/disk/public/resources';
const DOWNLOAD_API = 'https://cloud-api.yandex.net/v1/disk/public/resources/download';

async function fetchResource(p = '/', limit = 500) {
  const url = new URL(API);
  url.searchParams.set('public_key', PUBLIC_KEY);
  url.searchParams.set('path', p);
  url.searchParams.set('limit', String(limit));
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Yandex API ${res.status}: ${await res.text()}`);
  return res.json();
}

async function getDownloadHref(filePath) {
  const url = new URL(DOWNLOAD_API);
  url.searchParams.set('public_key', PUBLIC_KEY);
  url.searchParams.set('path', filePath);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`download link ${res.status}: ${await res.text()}`);
  const d = await res.json();
  return d.href;
}

async function collectFiles(p, parentName, files) {
  const data = await fetchResource(p);
  const items = data?._embedded?.items || [];
  for (const it of items) {
    if (it.type === 'dir') {
      await collectFiles(it.path, it.name, files);
    } else if (it.type === 'file') {
      files.push({
        name: it.name,
        size: it.size || 0,
        path: it.path,
        subcategory: parentName,
      });
    }
  }
}

function sanitizeName(s) {
  return s.replace(/[^\w\s.,()\-]/g, '_').replace(/\s+/g, ' ').trim();
}

async function downloadTo(href, dest) {
  const res = await fetch(href);
  if (!res.ok) throw new Error(`download ${res.status}`);
  const tmp = dest + '.tmp';
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, dest);
  return buf.length;
}

(async () => {
  console.log('=== Yandex.Disk files sync ===');
  console.log('public_key:', PUBLIC_KEY);
  console.log('target:    ', TARGET_DIR);
  console.log('mode:      ', FORCE ? 'FORCE re-download' : 'skip same-size');
  console.log('');

  if (!fs.existsSync(TARGET_DIR)) fs.mkdirSync(TARGET_DIR, { recursive: true });

  const files = [];
  await collectFiles('/', 'Материалы', files);
  console.log(`Found ${files.length} files in ${[...new Set(files.map(f => f.subcategory))].length} subfolders`);

  let downloaded = 0;
  let skipped = 0;
  let failed = 0;
  let totalBytes = 0;
  const prisma = new PrismaClient();

  for (const f of files) {
    const subSafe = sanitizeName(f.subcategory);
    const nameSafe = sanitizeName(f.name);
    const localDir = path.join(TARGET_DIR, subSafe);
    const localPath = path.join(localDir, nameSafe);
    const publicUrl = `/files/yandex/${encodeURIComponent(subSafe)}/${encodeURIComponent(nameSafe)}`;

    if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });

    // Check if already present with same size
    const exists = fs.existsSync(localPath);
    if (exists && !FORCE) {
      const stat = fs.statSync(localPath);
      if (stat.size === f.size) {
        skipped++;
        await upsertDocument(prisma, f, publicUrl);
        continue;
      }
    }

    try {
      console.log(`↓ ${f.subcategory}/${f.name} (${(f.size/1024/1024).toFixed(1)}MB)`);
      const href = await getDownloadHref(f.path);
      const bytes = await downloadTo(href, localPath);
      totalBytes += bytes;
      downloaded++;
      await upsertDocument(prisma, f, publicUrl);
    } catch (e) {
      console.error(`  FAIL ${f.path}: ${e.message}`);
      failed++;
    }
  }

  await prisma.$disconnect();

  console.log('');
  console.log(`Downloaded: ${downloaded}, skipped: ${skipped}, failed: ${failed}`);
  console.log(`Bytes downloaded: ${(totalBytes/1024/1024).toFixed(1)} MB`);
})().catch(e => { console.error(e); process.exit(1); });

async function upsertDocument(prisma, f, publicUrl) {
  const ext = (f.name.match(/\.([a-z0-9]+)$/i)?.[1] || 'FILE').toUpperCase();
  const description = `[yandex-local:${f.path}]`;
  const found = await prisma.document.findFirst({
    where: { category: 'materials', description },
  });
  const data = {
    name: f.name,
    type: ext,
    category: 'materials',
    subcategory: f.subcategory,
    fileUrl: publicUrl,
    fileSize: f.size,
    isPublic: true,
    sortOrder: 0,
    description,
  };
  if (found) {
    await prisma.document.update({ where: { id: found.id }, data });
  } else {
    await prisma.document.create({ data });
  }
}
