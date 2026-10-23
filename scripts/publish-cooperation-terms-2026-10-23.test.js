const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readFileSync } = require('node:fs');
const { OLD, NEW, PDF_HASH, PDF_SIZE, plan, verifyPdf, verifyEnvironment, applyRecords } = require('./publish-cooperation-terms-2026-10-23');
const old = () => ({ ...OLD, isPublic: true, type: 'PDF', fileSize: 1274759, sortOrder: 0, updatedAt: new Date('2026-10-11T14:12:20.508Z') });
const workflow = () => readFileSync(path.join(__dirname, '../.github/workflows/publish-cooperation-terms-2026-10-23.yml'), 'utf8');

test('exact old October document only; date/URL drift changes plan or refuses', () => {
  const expected = plan(old(), []);
  assert.equal(expected.action, 'publish');
  assert.match(expected.expectedOldHash, /^[a-f0-9]{64}$/);
  assert.throws(() => plan({ ...old(), fileUrl: '/files/other.pdf' }, []));
  assert.throws(() => plan({ ...old(), description: null }, []));
  assert.throws(() => plan({ ...old(), isPublic: false }, []));
  assert.notEqual(plan({ ...old(), updatedAt: new Date() }, []).expectedOldHash, expected.expectedOldHash);
});

test('idempotence requires exact new metadata and hidden old row', () => {
  assert.equal(plan({ ...old(), isPublic: false }, [{ ...NEW, sortOrder: 0 }]).action, 'already-published');
  assert.throws(() => plan(old(), [{ ...NEW, sortOrder: 0 }]));
  assert.throws(() => plan({ ...old(), isPublic: false }, [{ ...NEW, name: 'Changed', sortOrder: 0 }]));
  assert.throws(() => plan({ ...old(), isPublic: false }, [{ ...NEW, sortOrder: 5 }]));
  assert.throws(() => plan(old(), [{ ...NEW }, { ...NEW }]));
});

test('new row keeps the landing rewards marker and a hash-derived immutable file URL', () => {
  assert.equal(NEW.description, '[landing-rewards-button]');
  assert.equal(NEW.category, 'cooperation');
  assert.equal(NEW.isPublic, true);
  assert.equal(NEW.fileSize, PDF_SIZE);
  assert.ok(NEW.fileUrl.endsWith(`-${PDF_HASH.slice(0, 16)}.pdf`));
  assert.equal(NEW.id.replace(/-/g, '').slice(0, 12), PDF_HASH.slice(0, 12));
  assert.notEqual(NEW.fileUrl, OLD.fileUrl);
});

test('the committed asset is exactly the approved PDF', () => {
  verifyPdf(readFileSync(path.join(__dirname, '../assets/cooperation/cooperation-terms-2026-10-23.pdf')));
  assert.throws(() => verifyPdf(Buffer.from('%PDF-fake')));
});

test('apply cannot run without explicit confirmation, case hash and fresh backup attestation', () => {
  const env = { MODE: 'plan', EXPECTED_DEPLOYED_SHA: 'a'.repeat(40), GIT_SHA: 'a'.repeat(40), PRODUCTION_PG_SYSTEM_IDENTIFIER: '123', PRODUCTION_MIN_BROKER_ROWS: '100' };
  verifyEnvironment(env);
  assert.throws(() => verifyEnvironment({ ...env, GIT_SHA: 'b'.repeat(40) }));
  assert.throws(() => verifyEnvironment({ ...env, MODE: 'apply' }));
  const apply = { ...env, MODE: 'apply', CONFIRM_APPLY: 'true', EXPECTED_OLD_HASH: 'a'.repeat(64), VERIFIED_BACKUP_SHA256: 'b'.repeat(64), VERIFIED_BACKUP_AT: new Date().toISOString() };
  verifyEnvironment(apply);
  assert.throws(() => verifyEnvironment({ ...apply, VERIFIED_BACKUP_AT: '2026-01-01' }));
  assert.throws(() => verifyEnvironment({ ...apply, VERIFIED_BACKUP_AT: new Date(Date.now() - 21600001).toISOString() }));
});

test('writes are scoped, exclusive and old files and offer acceptances are untouched', () => {
  const code = readFileSync(require.resolve('./publish-cooperation-terms-2026-10-23'), 'utf8');
  assert.match(code, /openSync\(TARGET, 'wx'/);
  assert.match(code, /REPEATABLE READ READ ONLY/);
  assert.match(code, /pg_advisory_xact_lock/);
  assert.match(code, /where: \{ \.\.\.OLD, isPublic: true, updatedAt: current\.old\.updatedAt \}/);
  assert.match(code, /await verifyPublicHash\(NEW\);\s+await prisma\.\$transaction/);
  assert.match(code, /fchmodSync\(fd, 0o644\)/);
  assert.match(code, /90000/);
  assert.doesNotMatch(code, /document\.delete|offerAcceptance\.|siteContent\.|execSync|unlinkSync\(source/);
});

test('workflow defaults to plan, uses existing exact-SHA backups and strict production identity', () => {
  const text = workflow();
  assert.match(text, /options: \[plan, apply\]\s+default: plan/);
  assert.match(text, /PUBLISH_APPROVED_COOPERATION_TERMS_2026_10_23/);
  assert.match(text, /expected_old_hash/);
  assert.match(text, /head_sha == \$sha/);
  assert.match(text, /\/var\/backups\/stmichael\/loyalty-predeploy/);
  assert.match(text, /loyalty-predeploy-\$\{deployed_sha\}-run\$\{backup_run\}-attempt\$\{backup_attempt\}\.dump/);
  assert.match(text, /-le 21600/);
  assert.match(text, /pg_restore --exit-on-error --no-owner --file=\/dev\/null/);
  assert.match(text, /StrictHostKeyChecking=yes/);
  assert.match(text, /flock -x -n 9/);
  assert.match(text, /DOCKER_HOST/);
  assert.match(text, /com\.docker\.compose\.service/);
  assert.match(text, /base64 -w 0 "\$archive"/);
  assert.match(text, /git show "\$SOURCE_SHA:\$file"/);
  assert.ok(text.includes(PDF_HASH));
  assert.ok(text.includes(String(PDF_SIZE)));
  assert.doesNotMatch(text, /docker compose up|restart|git pull|system prune|pg_restore.*-d broker_platform/);
});

test('operational-only staging is private /tmp and exact deployed payload is attested before SSH', () => {
  const text = workflow();
  assert.match(text, /root=\$\(mktemp -d \/tmp\/st-michael-terms-publication\.XXXXXX\)/);
  assert.match(text, /stat -c %a "\$root"\)" = 700/);
  assert.equal((text.match(/\^\/tmp\/st-michael-terms-publication/g) || []).length, 2);
  assert.doesNotMatch(text, /mktemp -d \/app/);
  const healthAt = text.indexOf('deployed_sha=$(curl');
  const backupAt = text.indexOf('backup=$(gh api');
  assert.ok(healthAt > 0 && healthAt < backupAt);
  assert.match(text, /git -C \.deployed-publisher-source rev-parse HEAD\)" = "\$DEPLOYED_SHA"/);
  assert.match(text, /test "\$reviewed_blob" = "\$deployed_blob"/);
  assert.ok(text.indexOf('test "$reviewed_blob" = "$deployed_blob"') < text.indexOf('Stream exact immutable PDF'));
});

function databaseFixture(failure) {
  let rows = [old()];
  const matches = (row, where) => Object.entries(where).every(([key, value]) => value instanceof Date ? new Date(row[key]).getTime() === value.getTime() : row[key] === value);
  const tx = { $executeRawUnsafe: async () => 1, document: {
    findUnique: async ({ where }) => rows.find(row => row.id === where.id),
    findMany: async ({ where }) => rows.filter(row => where.OR.some(item => matches(row, item))),
    updateMany: async ({ where, data }) => {
      if (failure === 'cas') return { count: 0 };
      const found = rows.filter(row => matches(row, where));
      found.forEach(row => Object.assign(row, data));
      return { count: found.length };
    },
    create: async ({ data }) => {
      if (failure === 'create') throw new Error('test create failure');
      rows.push({ ...data, updatedAt: new Date() });
      return data;
    },
  } };
  return { rows: () => rows, async transaction(fn) {
    const saved = structuredClone(rows);
    try { return await fn(tx); } catch (error) { rows = saved; throw error; }
  } };
}

test('one atomic transaction hides the exact old row, publishes the new PDF and rerun writes nothing', async () => {
  const db = databaseFixture();
  const hash = plan(old(), []).expectedOldHash;
  await db.transaction(tx => applyRecords(tx, hash));
  assert.equal(db.rows().length, 2);
  assert.equal(db.rows().find(row => row.id === OLD.id).isPublic, false);
  assert.equal(db.rows().find(row => row.id === OLD.id).fileUrl, OLD.fileUrl);
  assert.deepEqual(db.rows().filter(row => row.isPublic).map(row => row.id), [NEW.id]);
  const before = JSON.stringify(db.rows());
  await db.transaction(tx => applyRecords(tx, hash));
  assert.equal(JSON.stringify(db.rows()), before);
});

test('CAS/create failure or a stale plan hash leaves the old row public and creates nothing', async () => {
  for (const failure of ['cas', 'create']) {
    const db = databaseFixture(failure);
    await assert.rejects(db.transaction(tx => applyRecords(tx, plan(old(), []).expectedOldHash)));
    assert.equal(db.rows().length, 1);
    assert.ok(db.rows()[0].isPublic);
  }
  const db = databaseFixture();
  await assert.rejects(db.transaction(tx => applyRecords(tx, '0'.repeat(64))));
  assert.equal(db.rows().length, 1);
  assert.ok(db.rows()[0].isPublic);
});
