const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { validateInputs, summarizeDocuments, safeTimestamp, boundedJson, verifyAgencyCounts } = require('./inspect-release-718-smoke');
test('exact deployed SHA and explicit send flag are required', () => {
  const env = { SMOKE_EXPECTED_SHA: 'a'.repeat(40), GIT_SHA: 'a'.repeat(40), PRODUCTION_PG_SYSTEM_IDENTIFIER: '123', PRODUCTION_MIN_BROKER_ROWS: '100' };
  validateInputs(env);
  assert.throws(() => validateInputs({ ...env, GIT_SHA: 'b'.repeat(40) }));
  assert.throws(() => validateInputs({ ...env, SMOKE_CONFIRM_SEND: 'yes' }));
  assert.throws(() => validateInputs({ ...env, PRODUCTION_PG_SYSTEM_IDENTIFIER: '' }));
});
test('obsolete documents are detected without logging their payloads', () => {
  assert.equal(summarizeDocuments([{ name: 'Условия сотрудничества октябрь' }]).obsoleteAbsent, true);
  assert.equal(summarizeDocuments([{ name: 'Условия вознаграждения для брокеров на октябрь 2026 г.' }]).obsoleteAbsent, true);
  for (const name of ['Условия рассрочки Квартал Серебряный бор', 'Условия вознаграждения для брокеров на август 2026 г.', 'Условия вознаграждения партнёром St Michael']) {
    assert.equal(summarizeDocuments([{ name }]).obsoleteAbsent, false);
  }
});
test('JSON streaming rejects and cancels before buffering an excessive response', async () => {
  assert.deepEqual(await boundedJson(new Response('{"ok":true}')), { ok: true });
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(32)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(boundedJson(new Response(body), 16));
  assert.equal(cancelled, true);
});
test('compiled service smoke uses three period cases and never outputs entity data', async () => {
  const calls = [];
  const expected = { total: 8, with_fixations: 3, with_meetings: 4, with_both: 2 };
  const service = { async list(base, entity, query, search, canonical) {
    calls.push({ base, entity, query, canonical });
    const total = canonical.fixationPeriod && canonical.meetingPeriod ? 2 : canonical.fixationPeriod ? 3 : 4;
    return { total, items: [{ id: 'private', periodMetrics: { fixations: 1, meetings: 1 } }] };
  } };
  assert.deepEqual(await verifyAgencyCounts(service, { from: '2026-10-01', to: '2026-10-11' }, expected), { with_fixations: 3, with_meetings: 4, with_both: 2 });
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.base === 'ours' && call.entity === 'AGENCY' && call.canonical.includeLowSignal === true));
  await assert.rejects(verifyAgencyCounts(service, {}, { ...expected, with_both: 3 }));
});
test('only normalized timestamps escape stored JSON', () => {
  assert.equal(safeTimestamp('secret-value'), null);
  assert.equal(safeTimestamp('2026-10-11T14:00:00Z'), '2026-10-11T14:00:00.000Z');
});
test('smoke does not boot Nest or run any migrations', () => {
  const source = readFileSync(require.resolve('./inspect-release-718-smoke'), 'utf8');
  assert.doesNotMatch(source, /NestFactory|createApplicationContext|migrate|\.\$disconnect\(\).*delete/);
  assert.match(source, /REPEATABLE READ READ ONLY/);
  assert.match(source, /apiParityVerified: false/);
  assert.match(source, /SMOKE_CONFIRM_SEND === 'true'/);
  assert.match(source, /startsWith\('content-freshness:'/);
});
test('workflow pins SSH host and checks container plus checkout SHA before smoke', () => {
  const workflow = readFileSync(require('node:path').join(__dirname, '../.github/workflows/inspect-release-718-smoke.yml'), 'utf8');
  assert.match(workflow, /default: false/);
  assert.match(workflow, /StrictHostKeyChecking=yes/);
  assert.match(workflow, /fingerprints\[0\].*EXPECTED_SSH_FINGERPRINT/);
  assert.match(workflow, /git rev-parse HEAD.*expected_sha/);
  assert.match(workflow, /docker exec st-michael-api sh -c 'printf %s "\$GIT_SHA"'/);
  assert.match(workflow, /bundle_hash.*sha256sum/);
  assert.match(workflow, /flock -s -n 9/);
  assert.match(workflow, /test "\$SOURCE_REF" = refs\/heads\/master/);
  assert.match(workflow, /DOCKER_HOST/);
  assert.match(workflow, /com\.docker\.compose\.service/);
  assert.doesNotMatch(workflow, /docker compose up|restart|git pull|system prune/);
  assert.match(workflow, /printf '\\ninspect\(\)\.catch/);
});
