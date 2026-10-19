"use strict";

// Pure diagnostic of ONE agency in an authenticated historical pg_dump table.
// Never execute the SQL, output its fields, or authorize reconciliation writes.
const { createHash } = require("node:crypto");
const CASE_HASH = "ac50b11e3b127b97962b7bd8eddb919fe05fdc885eab6b3568919c8a5fd1f82c";
const BACKUP_SHA256 = "db170493aa746ad7ff8aa802edc99dd27aa255d41cd1cf48baaeac12eb527015";
const BACKUP_SOURCE = "c5fe9e89083f45c7df6c3bf3c09401d0452a9158";
const BACKUP_RUN = "38251486523";
const MAX_TABLE_BYTES = 16 * 1024 * 1024;
function refuse() { const error = new Error("Historical agency proof refused"); error.safeCode = "HISTORICAL_AGENCY_PROOF_REFUSED"; throw error; }
function fingerprint(value) { return createHash("sha256").update(JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item)).digest("hex"); }
function decodeCopy(value) {
  if (value === "\\N") return null;
  // pg_dump UTF-8 text carries Unicode literally. Refuse unsupported escapes
  // rather than silently normalizing bytes used by an identity fingerprint.
  const escapes = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\" };
  let output = "";
  for (let index = 0; index < value.length; index++) {
    if (value[index] !== "\\") { output += value[index]; continue; }
    const next = value[++index]; if (!Object.prototype.hasOwnProperty.call(escapes, next)) refuse(); output += escapes[next];
  }
  return output;
}
function parseHistoricalAgency(table, agencyId) {
  if (typeof table !== "string" || Buffer.byteLength(table, "utf8") > MAX_TABLE_BYTES ||
    typeof agencyId !== "string" || !/^[A-Za-z0-9-]{1,80}$/.test(agencyId)) refuse();
  let columns = null, inCopy = false, complete = false, result = null, rows = 0;
  for (const line of table.split("\n")) {
    if (!inCopy) {
      if (line.startsWith("COPY ")) {
        if (columns) refuse();
        const match = /^COPY public\.agencies \(([^)\r\n]+)\) FROM stdin;$/.exec(line);
        if (!match) refuse(); columns = match[1].split(/,\s*/).map(value => {
          if (/^[a-z_][a-z0-9_]*$/.test(value)) return value;
          if (/^"[A-Za-z_][A-Za-z0-9_]*"$/.test(value)) return value.slice(1, -1);
          refuse();
        });
        if (new Set(columns).size !== columns.length || !["id", "name", "inn", "updated_at"].every(key => columns.includes(key))) refuse();
        inCopy = true;
      }
      continue;
    }
    if (line === "\\.") { inCopy = false; complete = true; continue; }
    const values = line.split("\t"); if (values.length !== columns.length || ++rows > 100000) refuse();
    if (values[columns.indexOf("id")] !== agencyId) continue;
    if (result) refuse();
    const selected = Object.fromEntries(["id", "name", "inn", "updated_at"].map(key => [key, decodeCopy(values[columns.indexOf(key)])]));
    if (!selected.name || typeof selected.inn !== "string" || !/^(?:[0-9]{10}|[0-9]{12})$/.test(selected.inn) ||
      typeof selected.updated_at !== "string" || !/^20[0-9]{2}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?$/.test(selected.updated_at)) refuse();
    const updatedAt = new Date(selected.updated_at.replace(" ", "T") + "Z");
    if (!Number.isFinite(updatedAt.getTime())) refuse();
    result = { id: selected.id, name: selected.name, inn: selected.inn, updatedAt };
  }
  if (!columns || !complete || inCopy || !result) refuse();
  return { agency: result, tableRowsRead: rows };
}
function originalCaseHash(row, agency) {
  const immutable = { ...row };
  for (const key of ["updatedAt", "amoSyncStatus", "amoSyncAttempts", "amoSyncError"]) delete immutable[key];
  return fingerprint({ scope: "fixed-case-calltouch-exclusion-v1", case: immutable, agency });
}
function compareHistoricalProof(row, agency, expectedNote, observedNote, expectedHash = CASE_HASH) {
  if (typeof expectedNote !== "string" || typeof observedNote !== "string" || Buffer.byteLength(expectedNote) > 120000 ||
    Buffer.byteLength(observedNote) > 120000 || !/^[a-f0-9]{64}$/.test(expectedHash)) refuse();
  const tags = text => text.split("\n").filter(line => line.startsWith("Recovery agency tag:"));
  return { originalCaseHashMatchesArmedPlan: originalCaseHash(row, agency) === expectedHash,
    historicalAgencyTagExactMatch: tags(expectedNote).length === 1 && JSON.stringify(tags(expectedNote)) === JSON.stringify(tags(observedNote)),
    fullHistoricalNoteExactMatch: expectedNote === observedNote,
    fullHistoricalNoteWithoutMemoEmojiExactMatch: expectedNote.replace(/^📝 /, "") === observedNote,
    // This diagnostic never converts a known heading variant into link consent.
    headingVariantAuthorizesLink: false, databaseMutationAuthorized: false, amoMutationAuthorized: false, retryAuthorized: false };
}
module.exports = { CASE_HASH, BACKUP_SHA256, BACKUP_SOURCE, BACKUP_RUN, MAX_TABLE_BYTES, parseHistoricalAgency, originalCaseHash, compareHistoricalProof };
