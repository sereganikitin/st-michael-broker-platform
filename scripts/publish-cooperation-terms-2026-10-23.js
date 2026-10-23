'use strict';
// 2026-10-23: owner-approved cooperation terms (Zorge 9 base 5.5%, up to 6.5%).
// Same procedure as publish-rewards-october-2026.js for exactly one PDF: plan is
// read-only; apply hides the pinned October row, never deletes its file, and
// publishes the new row with the landing "Условия вознаграждения" marker.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const PDF_HASH = '18e988f20f531286726952be5dcb3a7ef8f6052e0fc42318a7dee84a6db450a1';
const PDF_SIZE = 856396;
const OLD = { id: 'e2161fa2-6b10-5b3c-ac99-a2e234315fb6', name: 'Условия вознаграждения ST MICHAEL — октябрь 2026', category: 'cooperation', description: '[landing-rewards-button]', fileUrl: '/files/cooperation/rewards-2026-10-11-e2161fa26b105b3c.pdf' };
const NEW = { id: '18e988f2-0f53-5286-b269-52be5dcb3a7e', name: 'Условия сотрудничества ST MICHAEL — 23.10.2026', category: 'cooperation', description: '[landing-rewards-button]', subcategory: null, project: null, type: 'PDF', fileSize: PDF_SIZE, fileUrl: '/files/cooperation/cooperation-terms-2026-10-23-18e988f20f531286.pdf', isPublic: true };
const TARGET = '/app/uploads/cooperation/cooperation-terms-2026-10-23-18e988f20f531286.pdf';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function snapshotHash(row) {
  return sha(JSON.stringify({ id: row.id, name: row.name, category: row.category, subcategory: row.subcategory ?? null, project: row.project ?? null, description: row.description, fileUrl: row.fileUrl, isPublic: row.isPublic, type: row.type, fileSize: row.fileSize, sortOrder: row.sortOrder, updatedAt: new Date(row.updatedAt).toISOString() }));
}
function plan(old, candidates) {
  assert.ok(old);
  for (const [key, value] of Object.entries(OLD)) assert.equal(old[key], value);
  assert.ok(candidates.length <= 1);
  const expectedOldHash = sha(JSON.stringify({ old: snapshotHash(old), count: candidates.length, terms: NEW }));
  if (candidates.length) {
    for (const [key, value] of Object.entries(NEW)) assert.equal(candidates[0][key], value);
    assert.equal(candidates[0].sortOrder, old.sortOrder);
    assert.equal(old.isPublic, false);
    return { action: 'already-published', expectedOldHash };
  }
  assert.equal(old.isPublic, true);
  return { action: 'publish', expectedOldHash };
}
function verifyPdf(buffer) {
  assert.equal(buffer.length, PDF_SIZE);
  assert.equal(buffer.subarray(0, 5).toString(), '%PDF-');
  assert.equal(sha(buffer), PDF_HASH);
}
function verifyEnvironment(env) {
  assert.match(env.EXPECTED_DEPLOYED_SHA || '', /^[0-9a-f]{40}$/);
  assert.equal(env.GIT_SHA, env.EXPECTED_DEPLOYED_SHA);
  assert.match(env.PRODUCTION_PG_SYSTEM_IDENTIFIER || '', /^\d+$/);
  assert.match(env.PRODUCTION_MIN_BROKER_ROWS || '', /^[1-9]\d*$/);
  assert.ok(env.MODE === 'plan' || env.MODE === 'apply');
  if (env.MODE === 'apply') {
    assert.equal(env.CONFIRM_APPLY, 'true');
    assert.match(env.EXPECTED_OLD_HASH || '', /^[0-9a-f]{64}$/);
    assert.match(env.VERIFIED_BACKUP_SHA256 || '', /^[0-9a-f]{64}$/);
    const age = Date.now() - Date.parse(env.VERIFIED_BACKUP_AT || '');
    assert.ok(Number.isFinite(age) && age >= 0 && age <= 21600000);
  }
}
async function verifyPublicHash(doc) {
  const response = await fetch('https://broker.stmichael.ru' + doc.fileUrl, { redirect: 'error', signal: AbortSignal.timeout(20000) });
  assert.equal(response.status, 200);
  assert.ok(response.body);
  const reader = response.body.getReader();
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      assert.ok(bytes <= doc.fileSize);
      hash.update(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  assert.equal(bytes, doc.fileSize);
  assert.equal(hash.digest('hex'), PDF_HASH);
}
async function readCase(tx) {
  const old = await tx.document.findUnique({ where: { id: OLD.id } });
  // Fail closed on any pre-existing row with the new id, file or name.
  const candidates = await tx.document.findMany({ where: { OR: [{ id: NEW.id }, { fileUrl: NEW.fileUrl }, { name: NEW.name }] } });
  return { old, candidates, ...plan(old, candidates) };
}
async function applyRecords(tx, expectedOldHash) {
  await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext('publish-cooperation-terms-18e988f2'))");
  const current = await readCase(tx);
  if (current.action === 'already-published') return;
  assert.equal(current.expectedOldHash, expectedOldHash);
  const changed = await tx.document.updateMany({ where: { ...OLD, isPublic: true, updatedAt: current.old.updatedAt }, data: { isPublic: false } });
  assert.equal(changed.count, 1);
  await tx.document.create({ data: { ...NEW, sortOrder: current.old.sortOrder } });
  assert.equal((await readCase(tx)).action, 'already-published');
}
async function run(env = process.env) {
  verifyEnvironment(env);
  const source = env.SOURCE_PDF;
  assert.ok(source && fs.lstatSync(source).isFile() && !fs.lstatSync(source).isSymbolicLink());
  const bytes = fs.readFileSync(source);
  verifyPdf(bytes);
  const { PrismaClient } = require('/app/node_modules/@st-michael/database');
  const prisma = new PrismaClient();
  let createdFile = null;
  let committed = false;
  try {
    const readPlan = await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const identity = await tx.$queryRawUnsafe('SELECT system_identifier::text AS id FROM pg_control_system()');
      assert.equal(identity[0]?.id, env.PRODUCTION_PG_SYSTEM_IDENTIFIER);
      assert.ok(await tx.broker.count() >= Number(env.PRODUCTION_MIN_BROKER_ROWS));
      const current = await readCase(tx);
      return { action: current.action, expectedOldHash: current.expectedOldHash };
    });
    console.log(JSON.stringify({ ...readPlan, sourcePdfHash: PDF_HASH, targetUrl: NEW.fileUrl, hiddenOldId: OLD.id, oldFileKept: true }));
    if (env.MODE === 'plan') return;
    if (readPlan.action !== 'already-published') assert.equal(readPlan.expectedOldHash, env.EXPECTED_OLD_HASH);
    assert.equal(fs.realpathSync('/app/uploads/cooperation'), '/app/uploads/cooperation');
    assert.equal(path.dirname(TARGET), '/app/uploads/cooperation');
    try {
      const fd = fs.openSync(TARGET, 'wx', 0o644);
      try {
        const stat = fs.fstatSync(fd);
        createdFile = `${stat.dev}:${stat.ino}`;
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
        // Explicitly restore nginx-readable permissions even under umask 077.
        fs.fchmodSync(fd, 0o644);
      } finally { fs.closeSync(fd); }
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    assert.ok(fs.lstatSync(TARGET).isFile() && !fs.lstatSync(TARGET).isSymbolicLink());
    verifyPdf(fs.readFileSync(TARGET));
    // Verify nginx's persistent-volume mapping before changing any document row.
    await verifyPublicHash(NEW);
    await prisma.$transaction(async tx => {
      await applyRecords(tx, env.EXPECTED_OLD_HASH);
    }, { timeout: 20000 });
    committed = true;
    await verifyPublicHash(NEW);
    console.log(JSON.stringify({ publicationCommitted: true, publicDownloadHashVerified: true, oldRecordsHidden: 1, publishedPdfs: 1, sourcePdfHash: PDF_HASH }));
  } finally {
    if (!committed && createdFile) {
      // Never delete an existing or referenced file. If DB is unavailable, leave
      // the verified orphan for inspection/retry rather than guessing ownership.
      try {
        const stat = fs.lstatSync(TARGET);
        if (await prisma.document.count({ where: { fileUrl: NEW.fileUrl } }) === 0 && !stat.isSymbolicLink() && `${stat.dev}:${stat.ino}` === createdFile) fs.unlinkSync(TARGET);
      } catch { console.log('new_uncommitted_file_cleanup_not_confirmed'); }
    }
    await prisma.$disconnect();
  }
}
module.exports = { OLD, NEW, PDF_HASH, PDF_SIZE, TARGET, plan, snapshotHash, verifyPdf, verifyEnvironment, readCase, applyRecords, run };
if (require.main === module) {
  // Bound the process itself, not just the docker CLI: no publisher can remain
  // running after the SSH workflow releases its production lock.
  const watchdog = setTimeout(() => { console.error('COOPERATION_TERMS_PUBLICATION_TIMEOUT'); process.exit(1); }, 90000);
  run().catch(() => { console.error('COOPERATION_TERMS_PUBLICATION_FAILED'); process.exitCode = 1; }).finally(() => clearTimeout(watchdog));
}
