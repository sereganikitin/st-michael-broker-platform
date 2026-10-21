"use strict";

// Read-only diagnostic for broker-facing uniqueness check failures
// ("Полную проверку уникальности в amoCRM завершить не удалось").
// Consumes `docker logs --timestamps st-michael-api` on stdin, keeps raw lines
// in memory only and prints aggregate JSON: UTC/MSK minute, sanitized error
// code, attempt count, error class and HTTP status. Never prints raw log lines,
// phones, names, lead reasons or provider bodies.
const MAX_LOG_BYTES = 256 * 1024 * 1024;
const MAX_LINE_BYTES = 65536;
const MAX_EVENTS = 300;
// A give-up line is written immediately before the 503 line of the same request.
const CORRELATION_WINDOW_MS = 2000;
const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;

const TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,9})?Z\s/;
const RETRY = /\[fixClient\] amo checkUniqueness attempt (\d{1,2})\/(\d{1,2}) failed \(([A-Z][A-Z0-9_]{2,63})[^)]*\), retrying in \d{1,6}ms/;
const GIVE_UP = /\[fixClient\] amo checkUniqueness giving up on attempt (\d{1,2})\/(\d{1,2}): ([A-Z][A-Z0-9_]{2,63})[^(]*\(errClass=([A-Za-z_$][A-Za-z0-9_$]{0,63}), httpStatus=(\d{3}|n\/a)\)/;
const BLOCKED = /\[fixClient\] amo checkUniqueness failed; lead creation is blocked: ([A-Z][A-Z0-9_]{2,63})/;
const VERDICT = /\[fixClient\] amo uniqueness rule=([A-Z][A-Z0-9_]{2,63})(?:\s|$)/;
const UNIQUENESS_FRAGMENT = "[fixClient] amo checkUniqueness";

const TRANSIENT_CODES = new Set(["AMO_NETWORK_ERROR", "AMO_TEMPORARY_UNAVAILABLE", "AMO_RATE_LIMIT_429"]);
const AUTH_CODES = new Set(["AMO_AUTH_401", "AMO_FORBIDDEN_403"]);

function minute(ms) {
  return new Date(ms).toISOString().slice(0, 16);
}

function mskMinute(ms) {
  return `${minute(ms + MSK_OFFSET_MS)}+03:00`;
}

function mskDay(ms) {
  return minute(ms + MSK_OFFSET_MS).slice(0, 10);
}

function increment(target, key) {
  target[key] = (target[key] || 0) + 1;
}

/**
 * DETERMINISTIC_DATA_REJECTION: every attempt failed with the generic sanitized
 * code and no HTTP status. This is the signature of an amoCRM payload that the
 * uniqueness classifier refuses (for example AMO_UNIQUENESS_LEAD_STAGE_UNRECOGNIZED),
 * not of a transport failure.
 */
function signatureOf(event) {
  if (TRANSIENT_CODES.has(event.code)) return "AMO_OR_NETWORK_TRANSIENT";
  if (AUTH_CODES.has(event.code)) return "AMO_AUTHORIZATION";
  if (
    event.code === "AMO_SYNC_FAILED" &&
    event.httpStatus === "n/a" &&
    event.attempts !== null &&
    event.attempts === event.totalAttempts
  ) return "DETERMINISTIC_DATA_REJECTION";
  return "OTHER";
}

function parseLine(raw) {
  const line = raw.replace(/\x1b\[[0-9;]*m/g, "");
  const ts = line.match(TIMESTAMP);
  const at = ts ? Date.parse(`${ts[1]}Z`) : Number.NaN;
  if (!line.includes("[fixClient] amo ")) return { kind: "other", at };
  let m = line.match(BLOCKED);
  if (m) return { kind: "blocked", at, code: m[1] };
  m = line.match(GIVE_UP);
  if (m) {
    return {
      kind: "giveUp",
      at,
      attempt: Number(m[1]),
      totalAttempts: Number(m[2]),
      code: m[3],
      errClass: m[4],
      httpStatus: m[5],
    };
  }
  m = line.match(RETRY);
  if (m) return { kind: "retry", at, code: m[3] };
  m = line.match(VERDICT);
  if (m) return { kind: "verdict", at, rule: m[1] };
  if (line.includes(UNIQUENESS_FRAGMENT)) return { kind: "unparsed", at };
  return { kind: "other", at };
}

function buildReport(entries, coverage) {
  const report = {
    scope: "api_current_container_retained_logs",
    scannedLines: coverage.scannedLines,
    firstTimestamp: Number.isFinite(coverage.first) ? minute(coverage.first) : null,
    lastTimestamp: Number.isFinite(coverage.last) ? minute(coverage.last) : null,
    linesWithoutTimestamp: coverage.linesWithoutTimestamp,
    successfulChecksByRule: {},
    successfulChecksByDayMsk: {},
    blockedChecks: 0,
    blockedBySignature: {},
    blockedByCode: {},
    blockedByDayMsk: {},
    retryAttemptsByCode: {},
    giveUpsWithoutBlockedResponse: 0,
    giveUpsWithoutBlockedResponseByCode: {},
    unparsedUniquenessLines: 0,
    events: [],
    eventsTruncated: false,
    rawLinesEmitted: false,
    completeInput: true,
  };

  const giveUps = [];
  for (const entry of entries) {
    if (entry.kind === "verdict") {
      increment(report.successfulChecksByRule, entry.rule);
      if (Number.isFinite(entry.at)) increment(report.successfulChecksByDayMsk, mskDay(entry.at));
    } else if (entry.kind === "retry") {
      increment(report.retryAttemptsByCode, entry.code);
    } else if (entry.kind === "unparsed") {
      report.unparsedUniquenessLines++;
    } else if (entry.kind === "giveUp") {
      giveUps.push({ ...entry, consumed: false });
    } else if (entry.kind === "blocked") {
      let match = null;
      if (Number.isFinite(entry.at)) {
        for (let i = giveUps.length - 1; i >= 0; i--) {
          const candidate = giveUps[i];
          if (candidate.consumed || !Number.isFinite(candidate.at)) continue;
          const delta = entry.at - candidate.at;
          if (delta < 0) continue;
          if (delta > CORRELATION_WINDOW_MS) break;
          match = candidate;
          break;
        }
      }
      if (match) match.consumed = true;
      const event = {
        atUtc: Number.isFinite(entry.at) ? minute(entry.at) : null,
        atMsk: Number.isFinite(entry.at) ? mskMinute(entry.at) : null,
        code: entry.code,
        attempts: match ? match.attempt : null,
        totalAttempts: match ? match.totalAttempts : null,
        errClass: match ? match.errClass : null,
        httpStatus: match ? match.httpStatus : null,
      };
      event.signature = signatureOf(event);
      report.blockedChecks++;
      increment(report.blockedBySignature, event.signature);
      increment(report.blockedByCode, event.code);
      if (Number.isFinite(entry.at)) increment(report.blockedByDayMsk, mskDay(entry.at));
      if (report.events.length < MAX_EVENTS) report.events.push(event);
      else report.eventsTruncated = true;
    }
  }
  // Give-ups that did not end in the 503 path: the 409 "several amoCRM
  // contacts with this phone" conflict is thrown before the blocked line.
  for (const giveUp of giveUps) {
    if (giveUp.consumed) continue;
    report.giveUpsWithoutBlockedResponse++;
    increment(
      report.giveUpsWithoutBlockedResponseByCode,
      `${giveUp.code}@attempt${giveUp.attempt}/${giveUp.totalAttempts}`,
    );
  }
  return report;
}

async function classifyUniquenessLogs(input) {
  // Only uniqueness-related entries are retained; other lines update coverage.
  const entries = [];
  const coverage = { scannedLines: 0, first: Infinity, last: -Infinity, linesWithoutTimestamp: 0 };
  let bytes = 0;
  let remainder = "";
  const consume = (line) => {
    coverage.scannedLines++;
    const entry = parseLine(line);
    if (Number.isFinite(entry.at)) {
      if (entry.at < coverage.first) coverage.first = entry.at;
      if (entry.at > coverage.last) coverage.last = entry.at;
    } else {
      coverage.linesWithoutTimestamp++;
    }
    if (entry.kind !== "other") entries.push(entry);
  };
  for await (const chunk of input) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_LOG_BYTES) throw new Error("LOG_BOUND_EXCEEDED");
    remainder += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    const lines = remainder.split("\n");
    remainder = lines.pop();
    for (const line of lines) consume(line);
    if (Buffer.byteLength(remainder) > MAX_LINE_BYTES) {
      // An oversized line cannot be a uniqueness line; drop it unparsed.
      remainder = "";
      coverage.scannedLines++;
      coverage.linesWithoutTimestamp++;
    }
  }
  if (remainder) consume(remainder);
  return buildReport(entries, coverage);
}

if (require.main === module) {
  classifyUniquenessLogs(process.stdin)
    .then((report) => {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    })
    .catch((error) => {
      const code = /^[A-Z_]{3,64}$/.test(String(error?.message)) ? error.message : "CLASSIFIER_FAILED";
      process.stdout.write(`${JSON.stringify({ ok: false, code, rawLinesEmitted: false })}\n`);
      process.exitCode = 1;
    });
}

module.exports = { classifyUniquenessLogs, parseLine, signatureOf };
