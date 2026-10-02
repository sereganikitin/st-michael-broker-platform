import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  decodeMaterialsSegments,
  fileCountUnder,
  foldersAndFilesAt,
  materialHref,
  splitMaterialPath,
} from './materials-folder-tree';

const docs = [
  { subcategory: 'ЗОРГЕ 9/1. Фото/01. Двор' },
  { subcategory: 'ЗОРГЕ 9/1. Фото/01. Двор' },
  { subcategory: 'ЗОРГЕ 9/2. Видео' },
  { subcategory: 'КСБ/3. Reels' },
];

test('splitMaterialPath keeps nested Disk folders', () => {
  assert.deepEqual(splitMaterialPath('ЗОРГЕ 9/1. Фото/01. Двор'), ['ЗОРГЕ 9', '1. Фото', '01. Двор']);
});

test('foldersAndFilesAt lists first-level Disk projects', () => {
  const { folders, files } = foldersAndFilesAt(docs, []);
  assert.deepEqual(folders, ['ЗОРГЕ 9', 'КСБ']);
  assert.equal(files.length, 0);
});

test('foldersAndFilesAt lists albums inside a project', () => {
  const { folders, files } = foldersAndFilesAt(docs, ['ЗОРГЕ 9']);
  assert.deepEqual(folders, ['1. Фото', '2. Видео']);
  assert.equal(files.length, 0);
});

test('foldersAndFilesAt returns files at the leaf folder', () => {
  const { folders, files } = foldersAndFilesAt(docs, ['ЗОРГЕ 9', '2. Видео']);
  assert.deepEqual(folders, []);
  assert.equal(files.length, 1);
});

test('fileCountUnder includes nested files', () => {
  assert.equal(fileCountUnder(docs, ['ЗОРГЕ 9']), 3);
  assert.equal(fileCountUnder(docs, ['ЗОРГЕ 9', '1. Фото']), 2);
});

test('materialHref encodes each path segment', () => {
  assert.equal(
    materialHref(['ЗОРГЕ 9', '1. Фото']),
    '/materials/%D0%97%D0%9E%D0%A0%D0%93%D0%95%209/1.%20%D0%A4%D0%BE%D1%82%D0%BE',
  );
});

test('decodeMaterialsSegments accepts catch-all params', () => {
  assert.deepEqual(decodeMaterialsSegments(['%D0%9A%D0%A1%D0%91', '3.%20Reels']), ['КСБ', '3. Reels']);
});

test('new-version project links open the complete project hierarchy', () => {
  const newDocs = [
    { subcategory: 'Зорге 9/Фото/Лобби' },
    { subcategory: 'Зорге 9/Видео/Теплый период — весна, лето, осень' },
    { subcategory: 'Квартал Серебряный бор/Рендеры/Архитектура' },
    { subcategory: 'Квартал Серебряный бор/Видео' },
  ];
  for (const project of ['Зорге 9', 'Квартал Серебряный бор']) {
    const href = materialHref([project]);
    const parts = decodeMaterialsSegments(href.slice('/materials/'.length).split('/'));
    assert.equal(fileCountUnder(newDocs, parts), 2);
    assert.equal(foldersAndFilesAt(newDocs, parts).folders.length, 2);
  }
  assert.equal(fileCountUnder(newDocs, ['Фотографии']), 0);
  assert.equal(fileCountUnder(newDocs, ['Рендеры']), 0);
});

test('landing project cards do not link to retired top-level media folders', () => {
  const source = readFileSync(resolve(__dirname, '../app/v2/LandingV2.tsx'), 'utf8');
  assert.ok(source.includes("href={materialHref(['Зорге 9'])}"));
  assert.ok(source.includes("href={materialHref(['Квартал Серебряный бор'])}"));
  assert.ok(!source.includes('href="/materials/Фотографии"'));
  assert.ok(!source.includes('href="/materials/Рендеры"'));
});
