"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const proof = require("./fixed-amo-historical-agency-proof");
const fs = require("node:fs"), vm = require("node:vm");
const inspector = require("./inspect-fixed-amo-fixation-case");
const sql = (rows = "agency1\tprivate-name\t1234567890\t2026-10-12 10:00:00.123\n") =>
  "-- historical fixture\nCOPY public.agencies (id, name, inn, updated_at) FROM stdin;\n" + rows + "\\.\n";
test("reads only the exact scoped agency without executing any SQL", () => {
  const parsed = proof.parseHistoricalAgency(sql("other\tprivate-other\t0987654321\t2026-10-11 10:00:00\n" + "agency1\tprivate-name\t1234567890\t2026-10-12 10:00:00.123\n"), "agency1");
  assert.equal(parsed.agency.name, "private-name"); assert.equal(parsed.agency.updatedAt.toISOString(), "2026-10-12T10:00:00.123Z");
  assert.equal(parsed.tableRowsRead, 2);
});
test("COPY escaping preserves fingerprint bytes instead of normalizing names", () => {
  const parsed = proof.parseHistoricalAgency(sql("agency1\tprivate\\tname\\\\tail\t1234567890\t2026-10-12 10:00:00\n"), "agency1");
  assert.equal(parsed.agency.name, "private\tname\\tail");
});
test("truncated, duplicate, missing, wrong table and unsupported data are refused", () => {
  for (const value of [sql().replace("\\.\n", ""), sql() + sql(), sql().replace("agency1", "other"),
    sql().replace("public.agencies", "public.clients"), sql().replace("private-name", "private\\qname"),
    sql().replace("1234567890", "\\N"), sql() + "COPY public.clients (id) FROM stdin;\n"]) {
    assert.throws(() => proof.parseHistoricalAgency(value, "agency1"), /proof refused/);
  }
});
test("only volatile operational fields are excluded from the original plan fingerprint", () => {
  const agency = proof.parseHistoricalAgency(sql(), "agency1").agency;
  const row = { id: "fixture", phone: "private", amoLeadId: null, updatedAt: new Date(), amoSyncStatus: "FAILED", amoSyncAttempts: 10, amoSyncError: "fixture" };
  const hash = proof.originalCaseHash(row, agency);
  assert.equal(proof.originalCaseHash({ ...row, amoSyncError: "changed", amoSyncAttempts: 11 }, agency), hash);
  assert.notEqual(proof.originalCaseHash({ ...row, phone: "changed" }, agency), hash);
  assert.notEqual(proof.originalCaseHash(row, { ...agency, updatedAt: new Date() }), hash);
});
test("historical tag proof does not falsely authorize a heading variant or disclose private values", () => {
  const agency = proof.parseHistoricalAgency(sql(), "agency1").agency, row = { id: "fixture", phone: "private" };
  const expected = "📝 Фиксация клиента от брокера\nprivate-data\nRecovery agency tag: " + "a".repeat(64);
  const result = proof.compareHistoricalProof(row, agency, expected, expected.replace(/^📝 /, ""), proof.originalCaseHash(row, agency));
  assert.equal(result.originalCaseHashMatchesArmedPlan, true); assert.equal(result.historicalAgencyTagExactMatch, true);
  assert.equal(result.fullHistoricalNoteExactMatch, false); assert.equal(result.fullHistoricalNoteWithoutMemoEmojiExactMatch, true);
  assert.equal(result.headingVariantAuthorizesLink, false); assert.doesNotMatch(JSON.stringify(result), /private|1234567890|Recovery agency|a{64}/);
});
test("selected fields and ordering match the original attested writer literally", () => {
  const writer = fs.readFileSync(require.resolve("./apply-fixed-amo-fixation-case"), "utf8");
  const declaration = writer.match(/const CLIENT_SELECT = (\{[\s\S]*?\n\});/)[1];
  const expected = vm.runInNewContext(`(${declaration})`, { inspector });
  assert.equal(JSON.stringify(inspector.originalWriterClientSelection()), JSON.stringify(expected));
});
