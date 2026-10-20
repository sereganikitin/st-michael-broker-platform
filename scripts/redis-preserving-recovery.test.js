'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const source = fs.readFileSync('.github/workflows/recover-redis-preserving-data.yml', 'utf8');

test('recovery attests canonical exact successful CI and pinned SSH', () => {
  for (const marker of ['sereganikitin/st-michael-broker-platform', 'completed:success', '.head_sha', 'StrictHostKeyChecking=yes', 'flock -x -n 9']) assert.ok(source.includes(marker));
});
test('live or unsaved Redis data blocks restart', () => {
  const restart = source.indexOf('docker restart --time 30 st-michael-redis');
  for (const marker of ['test "$live" = 0', 'test "$listeners" = 0', 'RDB looks OK', '0 keys read', 'redis-data.tar', 'restart.attempted']) {
    assert.ok(source.indexOf(marker) > 0 && source.indexOf(marker) < restart);
  }
  assert.ok(source.includes('test ! -e "$backup"'));
});
test('only existing Redis container may restart; no key/volume/queue reset or CRM mutation', () => {
  assert.equal((source.match(/docker restart/g) || []).length, 1);
  assert.doesNotMatch(source, /FLUSH(?:ALL|DB)|\bDEL\b|UNLINK|docker (?:rm|run|compose)|redis-cli.*(?:SET|CONFIG|EVAL)|curl.*-X\s*(?:POST|PATCH|DELETE)/i);
  assert.ok(source.includes('test "$before" = "$after"'));
  assert.ok(source.includes('applicationRestarted'));
});
test('real Redis and both readiness endpoints must pass after restart', () => {
  for (const marker of ['redis-cli --raw PING', 'test "$pong" = true', '/api/health/ready', 'REDIS_PUBLIC_READINESS', "--proto '=https' --tlsv1.2"]) assert.ok(source.includes(marker));
});
