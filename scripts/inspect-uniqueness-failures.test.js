"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { Readable } = require("node:stream");
const { classifyUniquenessLogs, parseLine } = require("./inspect-uniqueness-failures.js");

// Exact formats written by apps/api/src/client-fixation/client-fixation.service.ts.
const retry = (ts, n, code, delay) =>
  `${ts} [fixClient] amo checkUniqueness attempt ${n}/3 failed (${code}), retrying in ${delay}ms`;
const giveUp = (ts, n, code, errClass, httpStatus) =>
  `${ts} [fixClient] amo checkUniqueness giving up on attempt ${n}/3: ${code} (errClass=${errClass}, httpStatus=${httpStatus})`;
const blocked = (ts, code) =>
  `${ts} [fixClient] amo checkUniqueness failed; lead creation is blocked: ${code}`;
const verdict = (ts, rule, reason) => `${ts} [fixClient] amo uniqueness rule=${rule} — ${reason}`;

const run = (lines) => classifyUniquenessLogs(Readable.from([`${lines.join("\n")}\n`]));

test("classifies a deterministic amoCRM data rejection after all retries", async () => {
  const report = await run([
    retry("2026-10-21T06:00:00.100000000Z", 1, "AMO_SYNC_FAILED", 2000),
    retry("2026-10-21T06:00:02.200000000Z", 2, "AMO_SYNC_FAILED", 5000),
    giveUp("2026-10-21T06:00:07.300000000Z", 3, "AMO_SYNC_FAILED", "Error", "n/a"),
    blocked("2026-10-21T06:00:07.301000000Z", "AMO_SYNC_FAILED"),
  ]);
  assert.equal(report.blockedChecks, 1);
  assert.deepEqual(report.blockedBySignature, { DETERMINISTIC_DATA_REJECTION: 1 });
  assert.equal(report.events[0].atMsk, "2026-10-21T09:00+03:00");
  assert.equal(report.events[0].attempts, 3);
  assert.deepEqual(report.retryAttemptsByCode, { AMO_SYNC_FAILED: 2 });
  assert.deepEqual(report.blockedByDayMsk, { "2026-10-21": 1 });
});

test("separates transient amoCRM failures from data rejections", async () => {
  const report = await run([
    giveUp("2026-10-20T13:01:07.000000000Z", 3, "AMO_NETWORK_ERROR", "TypeError", "n/a"),
    blocked("2026-10-20T13:01:07.001000000Z", "AMO_NETWORK_ERROR"),
    giveUp("2026-10-20T13:14:07.000000000Z", 3, "AMO_RATE_LIMIT_429", "Error", "429"),
    blocked("2026-10-20T13:14:07.002000000Z", "AMO_RATE_LIMIT_429"),
  ]);
  assert.deepEqual(report.blockedBySignature, { AMO_OR_NETWORK_TRANSIENT: 2 });
  assert.equal(report.events[1].httpStatus, "429");
});

test("a give-up without the 503 line is reported as a non-blocked outcome", async () => {
  // AMBIGUOUS_EXACT_CONTACT gives up on the first attempt and returns 409.
  const report = await run([giveUp("2026-10-21T07:00:00.000000000Z", 1, "AMO_SYNC_FAILED", "Error", "n/a")]);
  assert.equal(report.blockedChecks, 0);
  assert.deepEqual(report.giveUpsWithoutBlockedResponseByCode, { "AMO_SYNC_FAILED@attempt1/3": 1 });
});

test("does not correlate a 503 with a give-up outside the request window", async () => {
  const report = await run([
    giveUp("2026-10-21T07:00:00.000000000Z", 3, "AMO_SYNC_FAILED", "Error", "n/a"),
    blocked("2026-10-21T07:00:05.000000000Z", "AMO_SYNC_FAILED"),
  ]);
  assert.equal(report.events[0].attempts, null);
  assert.equal(report.events[0].signature, "OTHER");
  assert.equal(report.giveUpsWithoutBlockedResponse, 1);
});

test("counts successful checks by rule and reports coverage bounds", async () => {
  const report = await run([
    "2026-10-08T00:00:00.000000000Z [Nest] 1  - LOG [NestApplication] Nest application successfully started",
    verdict("2026-10-21T08:00:00.000000000Z", "RULE_3", "Все активные лиды контакта закрыты, создаём новый"),
    verdict("2026-10-21T08:05:00.000000000Z", "NO_CONFLICT", "Контакт в amoCRM не найден или нет лидов"),
    "line without timestamp",
  ]);
  assert.deepEqual(report.successfulChecksByRule, { RULE_3: 1, NO_CONFLICT: 1 });
  assert.equal(report.firstTimestamp, "2026-10-08T00:00");
  assert.equal(report.lastTimestamp, "2026-10-21T08:05");
  assert.equal(report.linesWithoutTimestamp, 1);
  assert.equal(report.scannedLines, 4);
});

test("never emits raw log content, phones or names", async () => {
  const phone = "+79991234567";
  const report = await run([
    `2026-10-21T08:00:00.000000000Z POST /api/client-fixation phone=${phone} name=Иван Петров`,
    verdict("2026-10-21T08:00:01.000000000Z", "RULE_1", `Лид 32377125 клиента Иван Петров ${phone}`),
    `2026-10-21T08:00:02.000000000Z [fixClient] amo checkUniqueness unexpected ${phone} Иван`,
    giveUp("2026-10-21T08:00:03.000000000Z", 3, "AMO_SYNC_FAILED", "Error", "n/a"),
    blocked("2026-10-21T08:00:03.001000000Z", "AMO_SYNC_FAILED"),
  ]);
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /7999|1234567|Иван|Петров|32377125|POST|client-fixation/);
  assert.equal(report.unparsedUniquenessLines, 1);
  assert.equal(report.rawLinesEmitted, false);
});

test("rejects codes outside the sanitized alphabet", () => {
  const entry = parseLine(
    "2026-10-21T08:00:00Z [fixClient] amo checkUniqueness failed; lead creation is blocked: +79991234567",
  );
  assert.equal(entry.kind, "unparsed");
  const digitsOnly = parseLine(
    "2026-10-21T08:00:00Z [fixClient] amo checkUniqueness failed; lead creation is blocked: 79991234567",
  );
  assert.equal(digitsOnly.kind, "unparsed");
});

test("classifier source performs no network, database or file writes", () => {
  const source = fs.readFileSync(require.resolve("./inspect-uniqueness-failures.js"), "utf8");
  assert.doesNotMatch(source, /require\(["'](?:node:)?(?:https?|net|child_process|fs)["']\)/);
  assert.doesNotMatch(source, /prisma|fetch\(|writeFile/);
});
