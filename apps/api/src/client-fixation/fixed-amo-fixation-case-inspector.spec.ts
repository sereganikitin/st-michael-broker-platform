import { spawnSync } from "child_process";
import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { parse } from "yaml";
import { AMO_CONTACT_FIELDS } from "../../../../packages/integrations/src/amo-crm.fields";

describe("approved single-client GET-only amo inspector", () => {
  const root = resolve(__dirname, "../../../..");
  const scriptPath = resolve(root, "scripts/inspect-fixed-amo-fixation-case.js");
  const source = readFileSync(scriptPath, "utf8");
  const workflowSource = readFileSync(resolve(root, ".github/workflows/inspect-fixed-amo-fixation-case.yml"), "utf8");
  const dependencySource = readFileSync(resolve(root, "scripts/inspect-amo-fixation-lead-reconciliation.js"), "utf8");
  const NodeModule = jest.requireActual("module") as any;
  const loaded = new NodeModule(scriptPath, module);
  loaded.filename = scriptPath;
  loaded.paths = NodeModule._nodeModulePaths(dirname(scriptPath));
  loaded._compile(source, scriptPath);
  const inspector = loaded.exports;
  const workflow = parse(workflowSource);
  const runSource = workflow.jobs.inspect.steps[1].run.replace(/\r\n/g, "\n");
  const env = {
    FIXED_CASE_INSPECTOR_SHA256: "a".repeat(64),
    FIXED_CASE_DEPENDENCY_SHA256: "b".repeat(64),
    FIXED_CASE_DEPLOYED_GIT_SHA: "c".repeat(40),
    PRODUCTION_PG_SYSTEM_IDENTIFIER: "1234567",
    PRODUCTION_MIN_BROKER_ROWS: "100",
    AMO_ACCESS_TOKEN: "private-env-token",
  };
  const metadata = { inspectorSha256: env.FIXED_CASE_INSPECTOR_SHA256, dependencySha256: env.FIXED_CASE_DEPENDENCY_SHA256, deployedGitSha: env.FIXED_CASE_DEPLOYED_GIT_SHA };
  const row = (changes: any = {}) => ({
    id: inspector.CLIENT_ID, brokerId: inspector.EXPECTED_BROKER_ID,
    responsibleBrokerId: null, responsibleBroker: null,
    broker: { id: inspector.EXPECTED_BROKER_ID, phone: "+79998887766", amoContactId: 900001n, role: "BROKER", status: "ACTIVE", mergedIntoId: null, brokerAgencies: [{ agencyId: "private-agency", isPrimary: true }] },
    phone: "+79991234567", project: "ZORGE9", fixationAgencyId: "private-agency",
    createdAt: new Date("2026-10-08T08:00:00Z"), updatedAt: new Date("2026-10-08T08:02:00Z"),
    amoLeadId: null, amoCreatedAt: null, amoUpdatedAt: null,
    amoSyncStatus: "FAILED", amoSyncAttempts: 3, amoSyncLastAttemptAt: new Date("2026-10-08T08:01:00Z"),
    amoSyncError: "AMO_CREATE_RECONCILIATION_REQUIRED: private-name private@example.test +79991234567",
    uniquenessStatus: "CONDITIONALLY_UNIQUE", uniquenessExpiresAt: new Date("2026-11-07T08:00:00Z"),
    fixationStatus: "NOT_FIXED", fixationExpiresAt: null, status: "NEW", ...changes,
  });
  const created = Math.floor(row().createdAt.getTime() / 1000);
  const envelope = (leadId = 101, changes: any = {}) => ({ leadId, pipelineId: 7600542, statusId: 62907350, createdAt: created, sourceMarker: true, requestValues: [created], projectValues: ["Зорге 9"], contactIds: [800001, 900001], ...changes });
  const evidence = (leads: any[] = [envelope()], contacts = [800001]) => ({ byPhone: new Map([["+79991234567", { exactContactIds: contacts, leads }]]), stats: { normalizedPhones: 1, contactSearchPages: 1, contactRowsRead: contacts.length, exactContacts: contacts.length, distinctLinkedLeadsRead: leads.length } });
  function database(rows = [row(), row()], token: any = "private-db-token", identityChanges: any = {}) {
    let index = 0;
    const tx = {
      $queryRaw: jest.fn(async (strings: TemplateStringsArray) => strings.join("").includes("pg_control_system") ? [{ read_only: "on", database_name: "broker_platform", system_identifier: "1234567", broker_rows: "1000", ...identityChanges }] : [{ mode: "on" }]),
      client: { findUnique: jest.fn(async () => rows[Math.min(index++, rows.length - 1)]) },
      systemSetting: { findUnique: jest.fn(async () => token === null ? null : { value: token }) },
    };
    return { tx, $transaction: jest.fn(async (callback: any) => callback(tx)) };
  }
  function json(payload: any, status = 200) {
    let done = false;
    return { status, ok: status >= 200 && status < 300, headers: { get: () => null }, body: { getReader: () => ({ read: async () => done ? { done: true } : (done = true, { done: false, value: Buffer.from(JSON.stringify(payload)) }), cancel: async () => {}, releaseLock: () => {} }) } };
  }
  const clientContact = (id = 800001, leads = [101]) => ({ id, name: "private-name", custom_fields_values: [{ field_id: 557903, values: [{ value: "+79991234567" }] }], _embedded: { leads: leads.map((id) => ({ id })) } });
  const crmLead = (id = 101) => ({ id, name: "private-name", pipeline_id: 7600542, status_id: 62907350, created_at: created, _embedded: { contacts: [{ id: 800001 }, { id: 900001 }] }, custom_fields_values: [{ field_id: 665195, values: [{ enum_id: 985337 }] }, { field_id: 833189, values: [{ value: created }] }, { field_id: 839179, values: [{ value: "Зорге 9" }] }] });
  const crm = () => jest.fn(async (url: URL) => {
    const path = new URL(url).pathname;
    if (path === "/api/v4/account") return json({ id: 28552900 });
    if (path === "/api/v4/contacts/900001") return json({ id: 900001, name: "private-broker", custom_fields_values: [{ field_id: 557903, values: [{ value: "+79998887766" }] }, { field_id: AMO_CONTACT_FIELDS.IS_BROKER, values: [{ value: true }] }] });
    if (path === "/api/v4/contacts") return json({ _embedded: { contacts: [clientContact()] } });
    if (path === "/api/v4/contacts/800001") return json(clientContact());
    if (path === "/api/v4/leads/101") return json(crmLead());
    throw Error("Unexpected private@example.test +79991234567");
  });

  it("binds exact approved UUIDs with no operator scope", () => {
    expect(inspector.CLIENT_ID).toBe("8d082b21-7cba-4778-a6c6-1d80bfe7ed7c");
    expect(inspector.EXPECTED_BROKER_ID).toBe("6e414141-f2ca-4c71-8402-2032c9186568");
    expect(workflow.on.workflow_dispatch).toEqual({});
    expect(inspector.CLIENT_SELECT.fullName).toBeUndefined();
    expect(inspector.CLIENT_SELECT.email).toBeUndefined();
    expect(inspector.CLIENT_SELECT.broker.select.passwordHash).toBeUndefined();
  });
  it("reports scoped lead IDs and safe evidence, without raw/private records", () => {
    const report = inspector.buildReport(row(), evidence(), { id: 900001 }, null, metadata);
    expect(report.conclusion).toBe("unique_strong_candidate_advisory");
    expect(report.strongLeadIds).toEqual([101]);
    expect(report.candidates[0]).toMatchObject({ leadId: 101, pipelineId: 7600542, expectedBrokerAttachment: "present", strictBrokerSourceMarker: true });
    expect(report.database.errorClass).toBe("create_reconciliation_required");
    expect(report.advisory).toMatchObject({ executablePayload: false, databaseMutationAuthorized: false, amoMutationAuthorized: false, retryAuthorized: false });
    expect(JSON.stringify(report)).not.toMatch(/private-name|private-broker|private-agency|example.test|79991234567|rawValidValues|contactIds|attestationRecord/);
  });
  it("keeps all strong IDs even when duplicate exact contacts require manual review", () => {
    const report = inspector.buildReport(row(), evidence([envelope()], [800001, 800002]), {}, null, metadata);
    expect(report.exactClientContactCount).toBe(2);
    expect(report.strongLeadIds).toEqual([101]);
    expect(report.resolution).toBe("ambiguous_exact_client_contacts");
    expect(report.advisory.candidateLinkEvidenceSufficient).toBe(false);
  });
  it.each([
    ["multiple strong", evidence([envelope(101), envelope(102)]), "multiple_strong_candidates"],
    ["strong and weak", evidence([envelope(101), envelope(102, { projectValues: [] })]), "single_strong_with_weak_candidates"],
    ["weak", evidence([envelope(101, { projectValues: [] })]), "single_weak_candidate"],
    ["no exact contact", evidence([], []), "no_exact_client_contact"],
    ["outside KC", evidence([envelope(101, { pipelineId: 77 })]), "no_candidate"],
  ])("does not pick the first candidate: %s", (_name, found, resolution) => {
    const report = inspector.buildReport(row(), found, {}, null, metadata);
    expect(report.resolution).toBe(resolution);
    expect(report.advisory.candidateLinkEvidenceSufficient).toBe(false);
  });
  it("limits absence to the completed contact-linked KC scope", () => {
    const report = inspector.buildReport(row(), evidence([], []), null, null, metadata);
    expect(report.conclusion).toBe("no_contact_linked_kc_candidate_observed");
    expect(report.advisory.amoMutationAuthorized).toBe(false);
  });
  it("does not qualify a missing broker contact or absent source marker", () => {
    expect(inspector.buildReport(row(), evidence(), null, null, metadata).advisory.candidateLinkEvidenceSufficient).toBe(false);
    expect(inspector.buildReport(row(), evidence([envelope(101, { sourceMarker: false })]), {}, null, metadata).advisory.candidateLinkEvidenceSufficient).toBe(false);
  });
  it("reports a stored link separately, never as an automatic relink", () => {
    const report = inspector.buildReport(row({ amoLeadId: 111n }), evidence(), {}, envelope(111), metadata);
    expect(report.database.storedLeadId).toBe(111);
    expect(report.database.storedLeadEvidence.exactClientContactLinked).toBe(true);
    expect(report.conclusion).toBe("stored_link_requires_review");
    expect(report.advisory.candidateLinkEvidenceSufficient).toBe(false);
  });
  it.each([
    ["wrong client", { id: "different" }, "FIXED_CLIENT_MISSING"],
    ["unresolved responsible", { responsibleBrokerId: "unresolved" }, "RESPONSIBLE_BROKER_UNRESOLVED"],
    ["wrong broker", { brokerId: "different", broker: { ...row().broker, id: "different" } }, "EXPECTED_BROKER_MISMATCH"],
    ["staff", { broker: { ...row().broker, role: "ADMIN" } }, "EXPECTED_BROKER_NOT_CANONICAL"],
    ["merged", { broker: { ...row().broker, mergedIntoId: "other" } }, "EXPECTED_BROKER_NOT_CANONICAL"],
    ["invalid phone", { phone: "invalid" }, "INVALID_CLIENT_PHONE"],
    ["unsupported project", { project: "UNKNOWN" }, "PROJECT_MAPPING_UNSUPPORTED"],
    ["malformed timestamp", { createdAt: new Date("invalid") }, "INVALID_CASE_TIMESTAMP"],
    ["unsafe attempts", { amoSyncAttempts: -1 }, "INVALID_SYNC_ATTEMPTS"],
    ["invalid state", { status: "private-name" }, "INVALID_CASE_STATE"],
    ["agency overflow", { broker: { ...row().broker, brokerAgencies: new Array(101).fill({}) } }, "AGENCY_SCOPE_TOO_LARGE"],
  ])("fails closed before token or AMO lookup: %s", async (_name, changes, code) => {
    const db = database([row(changes)]);
    const fetchImpl = crm();
    await expect(inspector.run({ prisma: db, environment: env, fetchImpl })).rejects.toMatchObject({ safeCode: code });
    expect(db.tx.systemSetting.findUnique).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each([
    { read_only: "off" }, { database_name: "other" }, { system_identifier: "999" }, { broker_rows: "1" }, { broker_rows: "1\n1000" },
  ])("checks exact read-only database identity and floor before the client SELECT: %j", async (changes) => {
    const db = database(undefined, undefined, changes);
    await expect(inspector.run({ prisma: db, environment: env, fetchImpl: crm() })).rejects.toMatchObject({ safeCode: "DATABASE_IDENTITY_MISMATCH" });
    expect(db.tx.client.findUnique).not.toHaveBeenCalled();
  });
  it("uses DB token, GET only, current account, full evidence and a final snapshot", async () => {
    const db = database();
    const fetchImpl = crm();
    const report = await inspector.run({ prisma: db, environment: env, fetchImpl });
    expect(report.strongLeadIds).toEqual([101]);
    expect(db.tx.client.findUnique).toHaveBeenCalledTimes(2);
    expect(db.tx.systemSetting.findUnique).toHaveBeenCalledTimes(1);
    expect((db.tx.systemSetting.findUnique.mock.calls as any)[0][0]).toEqual({ where: { key: "AMO_ACCESS_TOKEN" }, select: { value: true } });
    for (const [url, options] of fetchImpl.mock.calls as any) {
      expect(new URL(url).origin).toBe("https://stmichael.amocrm.ru");
      expect(options).toMatchObject({ method: "GET", redirect: "error", headers: { Authorization: "Bearer private-db-token" } });
    }
  });
  it("uses env only when the DB access-token setting is empty", async () => {
    const fetchImpl = jest.fn(async () => json({ id: 1 }));
    await expect(inspector.run({ prisma: database(undefined, " "), environment: env, fetchImpl })).rejects.toThrow("Unexpected amoCRM account");
    expect((fetchImpl.mock.calls as any)[0][1].headers.Authorization).toBe("Bearer private-env-token");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("fails on unauthorized without fallback token, refresh, or retry", async () => {
    const fetchImpl = jest.fn(async () => json({}, 401));
    await expect(inspector.run({ prisma: database(), environment: env, fetchImpl })).rejects.toThrow("amoCRM request rejected");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("refuses concurrent row changes instead of printing stale advice", async () => {
    await expect(inspector.run({ prisma: database([row(), row({ amoSyncAttempts: 4 })]), environment: env, fetchImpl: crm() })).rejects.toMatchObject({ safeCode: "CASE_CHANGED_DURING_SCAN" });
  });
  it("honours explicit responsible broker, not a different coordinator owner", () => {
    const actual = row({ brokerId: "coordinator", broker: { ...row().broker, id: "coordinator", role: "MANAGER" }, responsibleBrokerId: inspector.EXPECTED_BROKER_ID, responsibleBroker: row().broker });
    expect(inspector.validateCase(actual).source).toBe("responsible");
  });
  it.each([
    ["ADMIN", null, false],
    ["MANAGER", null, false],
    ["BROKER", "private-merged-target", false],
  ])("reports a scoped ownership mismatch DB-only without token/CRM: %s", async (role, mergedIntoId, canonical) => {
    const actual = row({
      responsibleBrokerId: "private-unexpected-broker",
      responsibleBroker: { ...row().broker, id: "private-unexpected-broker", role, mergedIntoId },
    });
    const db = database([actual]);
    const fetchImpl = crm();
    const report = await inspector.run({ prisma: db, environment: env, fetchImpl });
    expect(report).toMatchObject({ expectedBrokerMatched: false, expectedBrokerIsOwner: true, expectedBrokerIsResponsible: false, mappingSource: "responsible", effectiveBrokerRole: role, effectiveBrokerStatus: "ACTIVE", effectiveBrokerCanonical: canonical, crmInspectionPerformed: false, tokenRead: false, conclusion: "effective_broker_mismatch_db_only" });
    expect(report.database).toMatchObject({ project: "ZORGE9", status: "NEW", amoSyncStatus: "FAILED", amoSyncAttempts: 3, errorClass: "create_reconciliation_required" });
    expect(report.advisory).toEqual({ executablePayload: false, databaseMutationAuthorized: false, amoMutationAuthorized: false, retryAuthorized: false, candidateLinkEvidenceSufficient: false });
    expect(db.tx.systemSetting.findUnique).not.toHaveBeenCalled();
    expect(db.tx.client.findUnique).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(JSON.stringify(report)).not.toMatch(/private-unexpected-broker|private-merged-target|private-name|private-db-token|79991234567|example.test|rawValidValues/);
  });
  it("still refuses the exact client when the expected broker is neither owner nor responsible", async () => {
    const actual = row({ brokerId: "private-other-owner", broker: { ...row().broker, id: "private-other-owner" }, responsibleBrokerId: "private-other-responsible", responsibleBroker: { ...row().broker, id: "private-other-responsible" } });
    const db = database([actual]);
    const fetchImpl = crm();
    await expect(inspector.run({ prisma: db, environment: env, fetchImpl })).rejects.toMatchObject({ safeCode: "EXPECTED_BROKER_MISMATCH" });
    expect(db.tx.systemSetting.findUnique).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("reads the canonical PENDING responsible of this exact owner, without repair advice or identity output", async () => {
    const actual = row({ responsibleBrokerId: "private-stored-responsible", responsibleBroker: { ...row().broker, id: "private-stored-responsible", status: "PENDING" } });
    const db = database([actual, actual]);
    const fetchImpl = crm();
    const report = await inspector.run({ prisma: db, environment: env, fetchImpl });
    expect(report).toMatchObject({ expectedBrokerMatched: false, expectedBrokerIsOwner: true, expectedBrokerIsResponsible: false, mappingSource: "responsible", effectiveBrokerRole: "BROKER", effectiveBrokerStatus: "PENDING", effectiveBrokerCanonical: true, crmInspectionPerformed: true, brokerLinkageReference: "stored_effective_broker_contact", brokerContactMatchesCurrentBrokerPhone: true, brokerContactHasBrokerFlag: true, brokerContactBrokerFlagEvidence: "valid" });
    expect(report.strongLeadIds).toEqual([101]);
    expect(report.candidates[0]).toMatchObject({ effectiveBrokerAttachment: "present", expectedBrokerAttachment: "not_inspected" });
    expect(report.advisory).toEqual({ executablePayload: false, databaseMutationAuthorized: false, amoMutationAuthorized: false, retryAuthorized: false, candidateLinkEvidenceSufficient: false });
    expect(db.tx.systemSetting.findUnique).toHaveBeenCalledTimes(1);
    expect(db.tx.client.findUnique).toHaveBeenCalledTimes(2);
    for (const [url, options] of fetchImpl.mock.calls as any) {
      expect(new URL(url).origin).toBe("https://stmichael.amocrm.ru");
      expect(options.method).toBe("GET");
    }
    expect(JSON.stringify(report)).not.toMatch(/private-stored-responsible|private-agency|private-name|private-db-token|79991234567|79998887766|example.test|rawValidValues|contactIds/);
  });
  it("does not emit repair advice even for an ACTIVE canonical responsible mismatch", () => {
    const actual = row({ responsibleBrokerId: "private-stored-responsible", responsibleBroker: { ...row().broker, id: "private-stored-responsible", status: "ACTIVE" } });
    const brokerContact = { id: 900001, custom_fields_values: [{ field_id: 557903, values: [{ value: "+79998887766" }] }, { field_id: AMO_CONTACT_FIELDS.IS_BROKER, values: [{ value: true }] }] };
    const report = inspector.buildReport(actual, evidence(), brokerContact, null, metadata);
    expect(report.expectedBrokerMatched).toBe(false);
    expect(report.brokerContactMatchesCurrentBrokerPhone).toBe(true);
    expect(report.brokerContactHasBrokerFlag).toBe(true);
    expect(report.advisory.candidateLinkEvidenceSufficient).toBe(false);
  });
  it.each([
    [{ phone: "invalid" }, "INVALID_CLIENT_PHONE"],
    [{ project: "UNKNOWN" }, "PROJECT_MAPPING_UNSUPPORTED"],
    [{ responsibleBroker: { ...row().broker, id: "private-stored-responsible", brokerAgencies: new Array(101).fill({}) } }, "AGENCY_SCOPE_TOO_LARGE"],
    [{ broker: { ...row().broker, id: "private-not-approved-owner" } }, "OWNER_BROKER_UNRESOLVED"],
  ])("validates newly allowed canonical-responsible scope before token/CRM", async (changes, code) => {
    const actual = row({ responsibleBrokerId: "private-stored-responsible", responsibleBroker: { ...row().broker, id: "private-stored-responsible", status: "PENDING" }, ...changes });
    const db = database([actual]);
    const fetchImpl = crm();
    await expect(inspector.run({ prisma: db, environment: env, fetchImpl })).rejects.toMatchObject({ safeCode: code });
    expect(db.tx.systemSetting.findUnique).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("rejects a changed canonical responsible snapshot after the GET scan", async () => {
    const initial = row({ responsibleBrokerId: "private-stored-responsible", responsibleBroker: { ...row().broker, id: "private-stored-responsible", status: "PENDING" } });
    const changed = { ...initial, responsibleBroker: { ...initial.responsibleBroker, phone: "+79998880000" } };
    await expect(inspector.run({ prisma: database([initial, changed]), environment: env, fetchImpl: crm() })).rejects.toMatchObject({ safeCode: "CASE_CHANGED_DURING_SCAN" });
  });
  it("binds the reported broker checkbox to the reviewed shared field constant", () => {
    expect(inspector.IS_BROKER_FIELD_ID).toBe(AMO_CONTACT_FIELDS.IS_BROKER);
  });
  it.each([
    [undefined, "missing", null],
    [[], "missing", null],
    [[{ field_id: 835415, values: [{ value: true }] }], "valid", true],
    [[{ field_id: 835415, values: [{ value: false }] }], "valid", false],
    [[{ field_id: 835415, values: [{ value: "true" }] }], "invalid", null],
    [[{ field_id: 835415, values: [{ value: 1 }] }], "invalid", null],
    [[{ field_id: 835415, values: [{ value: true }, { value: false }] }], "invalid", null],
    [[{ field_id: 835415, values: [{ value: true }] }, { field_id: 835415, values: [{ value: true }] }], "invalid", null],
  ])("does not invent broker-flag evidence: %j", (fields, coverage, value) => {
    expect(inspector.brokerFlagEvidence({ custom_fields_values: fields })).toEqual({ coverage, value });
  });
  it("keeps an unmatched broker phone as safe negative evidence, never a phone output", () => {
    const report = inspector.buildReport(row(), evidence(), { id: 900001, custom_fields_values: [{ field_id: 557903, values: [{ value: "+79990000000" }] }] }, null, metadata);
    expect(report.brokerContactMatchesCurrentBrokerPhone).toBe(false);
    expect(report.advisory.candidateLinkEvidenceSufficient).toBe(false);
    expect(JSON.stringify(report)).not.toMatch(/79990000000|79998887766/);
  });
  it.each([
    { NODE_TLS_REJECT_UNAUTHORIZED: "0" }, { FIXED_CASE_INSPECTOR_SHA256: "wrong" }, { PRODUCTION_MIN_BROKER_ROWS: "0" }, { PRODUCTION_MIN_BROKER_ROWS: "9007199254740992" },
  ])("refuses unsafe runtime attestation: %j", async (changes) => {
    const db = database();
    await expect(inspector.run({ prisma: db, environment: { ...env, ...changes }, fetchImpl: crm() })).rejects.toThrow();
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it("redacts raw provider/database failures and malicious getter errors", () => {
    expect(inspector.failureCode(Error("private@example.test +79991234567 private-token"))).toBe("UNKNOWN_FAILURE");
    expect(inspector.failureCode({ get safeCode() { throw Error("private-token"); } })).toBe("UNKNOWN_FAILURE");
  });
  it("uses only SELECTs, no resets, credentials refresh, repairs, messages or production mutations", () => {
    expect(source).not.toMatch(/\.(updateMany|upsert|create|delete|deleteMany|\$executeRaw)\s*\(|(?:prisma|tx)\.\w+\.update\s*\(/);
    expect(source).not.toMatch(/AMO_REFRESH_TOKEN|refreshAccessToken|sendMail|sendSms|createLead|setAmoTokens/);
    expect(source).toContain('where: { id: CLIENT_ID }');
    expect(source).toContain('current_setting(\'transaction_read_only\')');
    expect(workflowSource).not.toMatch(/docker\s+(restart|start|stop|kill|run|build|pull|push|compose)|git\s+(fetch|reset|checkout|pull|push)|\b(UPDATE|INSERT|DELETE|ALTER|DROP)\b/);
  });
  it("pins source, host, existing shared lock, root Docker endpoint and both DB identities", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.concurrency).toEqual({ group: "production-deploy", "cancel-in-progress": false });
    expect(workflow.jobs.inspect.environment).toBe("production");
    expect(runSource).toContain('test "$master_sha" = "$EXPECTED_SHA"');
    expect(runSource).toContain('case "$compare_status" in ahead|identical)');
    expect(runSource).toContain('test "$fingerprints" = "$EXPECTED_SSH_FINGERPRINT"');
    expect(runSource).toContain('-o StrictHostKeyChecking=yes');
    expect(runSource).toContain('exec 9<"$lock_path"');
    expect(runSource).toContain('flock -s -n 9');
    expect(runSource).toContain('unix:///var/run/docker.sock');
    expect(runSource).toContain('contains("rootless") | not');
    expect(runSource).toContain('BEGIN READ ONLY; SET LOCAL statement_timeout=');
    expect(runSource).toContain('FIXED_CASE_DEPENDENCY_SOURCE_SHA256=');
    expect(runSource).toContain('test "$(sha256sum "$inspector" | cut -d " " -f 1)" = "$expected_bundle_sha"');
  });
  it("builds the actual same-program module without invoking either main", () => {
    const bundleProgram = runSource.split("<<'BUNDLE'\n")[1].split("\nBUNDLE")[0];
    const { createHash } = require("crypto");
    const depHash = createHash("sha256").update(dependencySource).digest("hex");
    const ownHash = createHash("sha256").update(source).digest("hex");
    const result = spawnSync(process.execPath, ["-", resolve(root, "scripts/inspect-amo-fixation-lead-reconciliation.js"), scriptPath, depHash, ownHash], { input: bundleProgram, encoding: "utf8", timeout: 5000 });
    expect(result.status).toBe(0);
    const bundled = new NodeModule(scriptPath, module);
    bundled.filename = scriptPath;
    bundled.paths = NodeModule._nodeModulePaths(dirname(scriptPath));
    bundled._compile(result.stdout, scriptPath);
    expect(bundled.exports.CLIENT_ID).toBe(inspector.CLIENT_ID);
    expect(bundled.exports.validateCase(row()).source).toBe("owner_fallback");
    const bad = spawnSync(process.execPath, ["-", resolve(root, "scripts/inspect-amo-fixation-lead-reconciliation.js"), scriptPath, "0".repeat(64), ownHash], { input: bundleProgram, encoding: "utf8", timeout: 5000 });
    expect(bad.status).not.toBe(0);
  });
  it("parses actual Bash, without executing SSH/Docker/production commands", () => {
    const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/bash";
    const result = spawnSync(bash, ["-n"], { input: runSource, encoding: "utf8", timeout: 5000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
  });
});
