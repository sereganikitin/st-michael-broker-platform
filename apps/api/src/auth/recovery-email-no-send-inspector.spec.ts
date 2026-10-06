import { readFileSync } from "fs";
import { resolve } from "path";
import { parse } from "yaml";

const root = resolve(__dirname, "../../../..");
const { run, validateEmail, buildReadOnlyDatabaseUrl, configFacts, smtpFailure } = require(
  resolve(root, "scripts/inspect-recovery-email-no-send.js"),
);
const email = "Diagnostic.User@example.test";
const secret = "test-only-private-value-never-print";
const env = { EMAIL: email, DATABASE_URL: "postgresql://test:secret@localhost/test",
  SMTP_HOST: "mail.example.test", SMTP_USER: "private-user", SMTP_PASS: secret,
  SMTP_FROM: "Private Name <from@example.test>", SMTP_PORT: "587", SMTP_SECURE: "false",
  WEB_URL: "https://broker.stmichael.ru", NODE_ENV: "production" };
function group(overrides: any = {}) {
  return { matchKind: "exact", role: "BROKER", status: "ACTIVE", hasPassword: true,
    merged: false, resetExpiryPresent: true, resetExpired: true, count: 1, ...overrides };
}
function harness(rows: any[] = [group()]) {
  const tx = { $queryRaw: jest.fn().mockResolvedValueOnce([{ mode: "on" }]).mockResolvedValueOnce(rows) };
  const prisma = { $transaction: jest.fn(async (fn) => fn(tx)), $disconnect: jest.fn() };
  const transport = { verify: jest.fn().mockResolvedValue(true), close: jest.fn(), sendMail: jest.fn() };
  const createTransport = jest.fn().mockReturnValue(transport);
  const load = jest.fn().mockReturnValue({ prisma, createTransport });
  const emit = jest.fn();
  return { tx, prisma, transport, createTransport, load, emit };
}

describe("Recovery email read-only/no-send inspector", () => {
  it("enforces read-only DB defaults and a finite statement timeout", () => {
    const url = new URL(buildReadOnlyDatabaseUrl("postgresql://test:secret@localhost/db?options=-c%20default_transaction_read_only%3Doff"));
    expect(url.searchParams.getAll("options")).toHaveLength(1);
    expect(url.searchParams.get("options")).toMatch(/default_transaction_read_only=on -c statement_timeout=15000$/);
    expect(() => buildReadOnlyDatabaseUrl("https://example.test")).toThrow("DATABASE_CONFIG_INVALID");
  });

  it.each(["", "a@example.test\n", "a@example.test\n::warning::unsafe", "a'@example.test",
    "a@example.test;echo", "a@example.test,b@example.test", " a@example.test", "a@example", "a".repeat(65) + "@example.test"])(
    "rejects invalid/injecting input before DB or provider initialization", async (EMAIL) => {
      const h = harness();
      await expect(run({ EMAIL }, h.load, h.emit)).rejects.toThrow("RECOVERY_EMAIL_DIAGNOSTIC_FAILED");
      expect(h.load).not.toHaveBeenCalled();
      expect(h.emit).toHaveBeenCalledWith(expect.objectContaining({ failureTag: "INPUT_INVALID" }));
    });

  it("preserves email casing for exact-match diagnosis", () => {
    expect(validateEmail(env)).toBe(email);
  });

  it("checks transaction read-only on the same session before parameter-bound SELECTs", async () => {
    const h = harness();
    const report = await run(env, h.load, h.emit);
    expect(h.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { maxWait: 15000, timeout: 15000 });
    const modeSql = h.tx.$queryRaw.mock.calls[0][0].join("");
    const accountSql = h.tx.$queryRaw.mock.calls[1][0].join("");
    expect(modeSql).toContain("current_setting('transaction_read_only')");
    expect(accountSql).toMatch(/^\s*SELECT/);
    expect(accountSql).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/i);
    expect(accountSql).not.toContain(email);
    expect(accountSql).not.toContain("password_reset_token");
    expect(accountSql).toContain("password_hash IS NOT NULL");
    expect(h.tx.$queryRaw.mock.calls[1].slice(1)).toEqual([email, email, email]);
    expect(report).toMatchObject({ databaseSessionReadOnly: true, emailSent: false, resetRequested: false,
      deliveryVerified: false, inputHadUppercase: true, smtp: { attempts: 1, ok: true } });
    expect(h.transport.sendMail).not.toHaveBeenCalled();
    expect(h.prisma.$disconnect).toHaveBeenCalledTimes(1);
  });

  it.each(["off", null, "ON"])("fails closed on unverified DB readonly mode", async (mode) => {
    const h = harness();
    h.tx.$queryRaw.mockReset().mockResolvedValue([{ mode }]);
    await expect(run(env, h.load, h.emit)).rejects.toThrow();
    expect(h.tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(h.createTransport).not.toHaveBeenCalled();
    expect(h.emit).toHaveBeenCalledWith(expect.objectContaining({ failureTag: "DATABASE_NOT_READ_ONLY" }));
  });

  it("aggregates exact, case/whitespace-only, inactive, staff, merged and shared eligible rows", async () => {
    const h = harness([group({ count: 2 }), group({ role: "ADMIN", merged: true }),
      group({ matchKind: "case_only" }), group({ matchKind: "stored_whitespace" }),
      group({ status: "PENDING", hasPassword: false })]);
    const report = await run(env, h.load, h.emit);
    expect(report.accounts).toMatchObject({ matchingAccountCount: 6, exactMatchCount: 4,
      caseOnlyMatchCount: 1, storedWhitespaceMatchCount: 1, currentlyEligibleCount: 3,
      eligibleStaffCount: 1, eligibleMergedCount: 1, sharedEligibleEmail: true });
  });

  it("reports unknown accounts without triggering reset, activation or send", async () => {
    const h = harness([]);
    const report = await run(env, h.load, h.emit);
    expect(report.accounts).toMatchObject({ matchingAccountCount: 0, currentlyEligibleCount: 0, groups: [] });
    expect(h.transport.sendMail).not.toHaveBeenCalled();
  });

  it.each([group({ role: secret }), group({ hasPassword: secret }), group({ count: secret }), group({ matchKind: secret })])(
    "whitelists DB result types and never prints untrusted values", async (row) => {
      const h = harness([row]);
      await expect(run(env, h.load, h.emit)).rejects.toThrow();
      expect(h.createTransport).not.toHaveBeenCalled();
      expect(JSON.stringify(h.emit.mock.calls)).not.toContain(secret);
    });

  it("rejects excessive groups and projects no extra DB fields", async () => {
    const h = harness(Array.from({ length: 513 }, () => group()));
    await expect(run(env, h.load, h.emit)).rejects.toThrow();
    const safe = harness([group({ email, passwordHash: secret, passwordResetToken: secret, fullName: secret })]);
    await run(env, safe.load, safe.emit);
    expect(JSON.stringify(safe.emit.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(safe.emit.mock.calls)).not.toContain(email);
  });

  it("uses only strict verify, once, and distinguishes the unsafe production policy", async () => {
    const h = harness();
    const report = await run(env, h.load, h.emit);
    expect(h.createTransport).toHaveBeenCalledTimes(1);
    expect(h.createTransport).toHaveBeenCalledWith({ host: env.SMTP_HOST, port: 587, secure: false,
      auth: { user: env.SMTP_USER, pass: secret }, tls: { rejectUnauthorized: true }, requireTLS: true,
      logger: false, debug: false, pool: false, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 15000 });
    expect(report.config).toMatchObject({ productionCertificateVerificationEnabled: false,
      productionRequireTlsConfigured: false, diagnosticCertificateVerificationEnabled: true,
      diagnosticRequireTls: true, strictPolicyDifferentFromProduction: true });
    expect(h.transport.verify).toHaveBeenCalledTimes(1);
    expect(h.transport.close).toHaveBeenCalledTimes(1);
    expect(h.transport.sendMail).not.toHaveBeenCalled();
    const output = JSON.stringify(h.emit.mock.calls);
    for (const privateValue of [email, secret, env.SMTP_USER, env.SMTP_FROM, env.SMTP_HOST]) expect(output).not.toContain(privateValue);
  });

  it.each(["SMTP_HOST", "SMTP_USER", "SMTP_PASS"])("skips verify on missing %s", async (key) => {
    const h = harness();
    const report = await run({ ...env, [key]: "" }, h.load, h.emit);
    expect(report.smtp).toEqual({ attempted: false, attempts: 0, ok: false, failureTag: "CONFIG_INCOMPLETE" });
    expect(h.createTransport).not.toHaveBeenCalled();
  });

  it.each(["0", "65536", "not-port", "NaN"])("skips invalid port %s", async (SMTP_PORT) => {
    const h = harness();
    const report = await run({ ...env, SMTP_PORT }, h.load, h.emit);
    expect(report.config.port).toBeNull();
    expect(h.createTransport).not.toHaveBeenCalled();
  });

  it("sanitizes provider failures and never retries or prints exceptions", async () => {
    const h = harness();
    h.transport.verify.mockRejectedValue(Object.assign(new Error(`${email} ${secret}`), {
      code: "EAUTH", responseCode: 535, response: secret, command: secret,
    }));
    const report = await run(env, h.load, h.emit);
    expect(report.smtp).toEqual({ attempted: true, attempts: 1, ok: false, failureTag: "AUTH", code: "EAUTH", responseCode: 535 });
    expect(h.transport.verify).toHaveBeenCalledTimes(1);
    expect(h.transport.close).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.emit.mock.calls)).not.toContain(secret);
  });

  it("does not fall back to unsafe TLS or retry after a certificate failure", async () => {
    const h = harness();
    h.transport.verify.mockRejectedValue(Object.assign(new Error(`${email} ${secret}`), {
      code: "DEPTH_ZERO_SELF_SIGNED_CERT",
    }));
    const report = await run(env, h.load, h.emit);
    expect(report.smtp).toEqual({ attempted: true, attempts: 1, ok: false, failureTag: "TLS",
      code: "DEPTH_ZERO_SELF_SIGNED_CERT", responseCode: null });
    expect(report.deliveryVerified).toBe(false);
    expect(report.config.strictPolicyDifferentFromProduction).toBe(true);
    expect(h.createTransport).toHaveBeenCalledTimes(1);
    expect(h.createTransport.mock.calls[0][0]).toMatchObject({ tls: { rejectUnauthorized: true }, requireTLS: true });
    expect(h.transport.verify).toHaveBeenCalledTimes(1);
    expect(h.transport.sendMail).not.toHaveBeenCalled();
    expect(h.transport.close).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.emit.mock.calls)).not.toContain(secret);
  });

  it.each([secret, "ECONNECTION\n::warning::unsafe", 42])("never emits unknown provider codes", (code) => {
    expect(smtpFailure({ code, responseCode: secret })).toEqual({ ok: false, failureTag: "VERIFY_FAILED", code: null, responseCode: null });
  });

  it.each([0, 600, "535", 123456789])("only emits bounded integer SMTP response code", (responseCode) => {
    expect(smtpFailure({ code: "EAUTH", responseCode }).responseCode).toBeNull();
  });

  it("projects stale contacts and WEB_URL through boolean flags only", () => {
    const facts = configFacts({ ...env, SMTP_FROM: "Name <INFO@ZORGE9.COM>", SENDGRID_API_KEY: secret,
      SENDGRID_FROM: "info@zorge9.com", VAPID_SUBJECT: "mailto:info@zorge9.com" });
    expect(facts).toMatchObject({ smtpFromObsoleteMailbox: true, effectiveFromObsoleteMailbox: true,
      sendgridApiKeyConfigured: true, sendgridFromConfigured: true,
      sendgridFromObsoleteMailbox: true, vapidSubjectObsoleteMailbox: true, webUrlCanonicalOrigin: true });
    expect(configFacts({ WEB_URL: "https://broker.stmichael.ru/forgot?token=private" }).webUrlCanonicalOrigin).toBe(false);
    expect(JSON.stringify(facts)).not.toContain("info@zorge9.com");
  });

  it("sanitizes dependency failures and closes DB without emitting credentials", async () => {
    const h = harness();
    h.tx.$queryRaw.mockReset().mockRejectedValue(new Error(`${email} ${secret}`));
    await expect(run(env, h.load, h.emit)).rejects.toThrow("RECOVERY_EMAIL_DIAGNOSTIC_FAILED");
    expect(h.emit).toHaveBeenCalledWith(expect.objectContaining({ failureTag: "DIAGNOSTIC_FAILED" }));
    expect(h.createTransport).not.toHaveBeenCalled();
    expect(h.prisma.$disconnect).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.emit.mock.calls)).not.toContain(secret);
  });

  it("pins source/host and locks production without reset, mail dispatch or service mutations", () => {
    const workflow = readFileSync(resolve(root, ".github/workflows/inspect-recovery-email-no-send.yml"), "utf8");
    const parsed: any = parse(workflow);
    expect(parsed.concurrency).toEqual({ group: "production-deploy", "cancel-in-progress": false });
    expect(parsed.permissions).toEqual({ contents: "read" });
    expect(parsed.jobs.inspect.environment).toBe("production");
    expect(parsed.jobs.inspect.steps[0].uses).toBe("actions/checkout@11d5960a326750d5838078e36cf38b85af677262");
    expect(workflow).toContain("GITHUB_EVENT_PATH");
    expect(workflow).toContain("::add-mask::");
    expect(workflow).not.toContain("${{ inputs.email }}");
    expect(workflow).toContain("StrictHostKeyChecking=yes");
    expect(workflow).toContain("flock -s -n 9");
    expect(workflow).toContain("actual_script_sha");
    expect(workflow).toContain("container_sha");
    expect(workflow).toContain("trap cleanup EXIT HUP INT TERM");
    expect(workflow).not.toMatch(/\b(git fetch|eval|docker cp|docker compose up|sendMail|forgot-password)\b/);
    expect(workflow).not.toContain("send_to:");
  });
});
