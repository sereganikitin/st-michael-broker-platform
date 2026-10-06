import { readFileSync } from "fs";
import { spawnSync } from "child_process";
import { resolve } from "path";
import { parse } from "yaml";

const root = resolve(__dirname, "../../../..");
const workflowPath = resolve(root, ".github/workflows/send-synthetic-recovery-email-once.yml");
function workflowRun(): string {
  return parse(readFileSync(workflowPath, "utf8")).jobs.inspect.steps[1].run;
}
function runLocalGate(source: string, environment: Record<string, string>) {
  const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
  const result = spawnSync(bash, ["-c", source], {
    env: { ...process.env, ...environment }, encoding: "utf8", timeout: 5000,
  });
  if (result.error) throw result.error;
  return result;
}
const { run, failureProjection, SUBJECT, BODY } = require(resolve(root, "scripts/send-synthetic-recovery-email-once.js"));
const email = "Diagnostic.User@example.test";
const secret = "private-value-never-print";
const env = { EMAIL: email, CONFIRM_TEST_EMAIL: "true", SMTP_HOST: "mail.example.test",
  SMTP_USER: "private-user", SMTP_PASS: secret, SMTP_FROM: "Private Name <private@example.test>",
  SMTP_PORT: "587", SMTP_SECURE: "false" };
function harness() {
  const transport = { verify: jest.fn(), close: jest.fn(), sendMail: jest.fn().mockResolvedValue({
    accepted: [email], rejected: [], response: secret, messageId: secret,
  }) };
  const createTransport = jest.fn().mockReturnValue(transport);
  const load = jest.fn().mockReturnValue({ createTransport });
  const emit = jest.fn();
  return { transport, createTransport, load, emit };
}

describe("Explicitly authorized one-shot synthetic SMTP email", () => {
  it.each([undefined, "", "false", "TRUE", "1"])("requires literal confirmation before dependencies", async (CONFIRM_TEST_EMAIL) => {
    const h = harness();
    const report = await run({ ...env, CONFIRM_TEST_EMAIL }, h.load, h.emit);
    expect(report).toMatchObject({ sendAttempts: 0, failureTag: "CONFIRMATION_REQUIRED", ambiguousOutcome: false });
    expect(h.load).not.toHaveBeenCalled();
  });

  it.each(["", "a@example.test\n", "a'@example.test", "a@example.test;unsafe", "a@example.test,b@example.test", " a@example.test", "a@example"])(
    "rejects invalid recipient before SMTP access", async (EMAIL) => {
      const h = harness();
      const report = await run({ ...env, EMAIL }, h.load, h.emit);
      expect(report).toMatchObject({ sendAttempts: 0, failureTag: "INPUT_INVALID" });
      expect(h.load).not.toHaveBeenCalled();
    });

  it.each(["SMTP_HOST", "SMTP_USER", "SMTP_PASS"])("stops on missing %s", async (key) => {
    const h = harness();
    const report = await run({ ...env, [key]: "" }, h.load, h.emit);
    expect(report.failureTag).toBe("CONFIG_INCOMPLETE");
    expect(h.load).not.toHaveBeenCalled();
  });

  it("sends exactly one fixed plain TEST mail with strict TLS and no reset/custom inputs", async () => {
    const h = harness();
    const report = await run({ ...env, SUBJECT: "unsafe", BODY: secret, RESET_TOKEN: secret, DATABASE_URL: secret,
      RECOVERY_URL: "https://unsafe.example", RETRY: "true" }, h.load, h.emit);
    expect(h.createTransport).toHaveBeenCalledTimes(1);
    expect(h.createTransport).toHaveBeenCalledWith({ host: env.SMTP_HOST, port: 587, secure: false,
      auth: { user: env.SMTP_USER, pass: secret }, tls: { rejectUnauthorized: true }, requireTLS: true,
      logger: false, debug: false, pool: false, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 15000 });
    expect(h.transport.verify).not.toHaveBeenCalled();
    expect(h.transport.sendMail).toHaveBeenCalledTimes(1);
    expect(h.transport.sendMail).toHaveBeenCalledWith({ from: env.SMTP_FROM, to: email, subject: SUBJECT, text: BODY });
    expect(SUBJECT).toContain("TEST");
    expect(BODY).not.toMatch(/https?:\/\/|\d{4,}|token=/);
    expect(h.transport.sendMail.mock.calls[0][0]).not.toHaveProperty("html");
    expect(h.transport.close).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({ ok: true, providerAccepted: true, acceptedCount: 1, rejectedCount: 0,
      sendAttempts: 1, automaticRetry: false, resetRequested: false, accountChanged: false,
      ambiguousOutcome: false, mailboxDeliveryVerified: false });
    const output = JSON.stringify(h.emit.mock.calls);
    for (const value of [email, secret, env.SMTP_USER, env.SMTP_HOST, env.SMTP_FROM]) expect(output).not.toContain(value);
  });

  it("preserves the existing sender fallback identity", async () => {
    const h = harness();
    await run({ ...env, SMTP_FROM: "" }, h.load, h.emit);
    expect(h.transport.sendMail.mock.calls[0][0].from).toBe(env.SMTP_USER);
  });

  it.each(["ETIMEDOUT", "ECONNRESET", "ESOCKET", secret])("does not retry an ambiguous %s failure", async (code) => {
    const h = harness();
    h.transport.sendMail.mockRejectedValue(Object.assign(new Error(`${secret} ${email}`), { code, response: secret }));
    const report = await run(env, h.load, h.emit);
    expect(report).toMatchObject({ ok: false, sendAttempts: 1, ambiguousOutcome: true, automaticRetry: false });
    expect(h.transport.sendMail).toHaveBeenCalledTimes(1);
    expect(h.createTransport).toHaveBeenCalledTimes(1);
    expect(h.transport.verify).not.toHaveBeenCalled();
    expect(h.transport.close).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.emit.mock.calls)).not.toContain(secret);
  });

  it("does not disable TLS or retry after certificate rejection", async () => {
    const h = harness();
    h.transport.sendMail.mockRejectedValue(Object.assign(new Error(secret), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }));
    const report = await run(env, h.load, h.emit);
    expect(report).toMatchObject({ failureTag: "TLS", sendAttempts: 1, ambiguousOutcome: false });
    expect(h.createTransport).toHaveBeenCalledTimes(1);
    expect(h.createTransport.mock.calls[0][0]).toMatchObject({ tls: { rejectUnauthorized: true }, requireTLS: true });
    expect(h.transport.sendMail).toHaveBeenCalledTimes(1);
  });

  it.each([{ accepted: [], rejected: [email], expectedAmbiguous: false },
    { accepted: [], rejected: [], expectedAmbiguous: true },
    { accepted: [email, secret], rejected: [], expectedAmbiguous: true }])(
    "projects only bounded acceptance counts", async ({ accepted, rejected, expectedAmbiguous }) => {
      const h = harness();
      h.transport.sendMail.mockResolvedValue({ accepted, rejected, response: secret, messageId: secret });
      const report = await run(env, h.load, h.emit);
      expect(report).toMatchObject({ ok: false, ambiguousOutcome: expectedAmbiguous, mailboxDeliveryVerified: false });
      expect(JSON.stringify(h.emit.mock.calls)).not.toContain(email);
      expect(JSON.stringify(h.emit.mock.calls)).not.toContain(secret);
    });

  it.each([0, 600, "535", 123456789])("sanitizes provider response code %s", (responseCode) => {
    expect(failureProjection({ code: secret, responseCode }, true)).toMatchObject({ code: null, responseCode: null });
  });

  it("reports known auth rejection without claiming mailbox delivery", async () => {
    const h = harness();
    h.transport.sendMail.mockRejectedValue(Object.assign(new Error(secret), { code: "EAUTH", responseCode: 535 }));
    expect(await run(env, h.load, h.emit)).toMatchObject({ failureTag: "AUTH", code: "EAUTH", responseCode: 535,
      ambiguousOutcome: false, mailboxDeliveryVerified: false });
  });

  it("sanitizes dependency failures before send", async () => {
    const h = harness();
    h.load.mockImplementation(() => { throw new Error(secret); });
    const report = await run(env, h.load, h.emit);
    expect(report).toMatchObject({ sendAttempts: 0, ambiguousOutcome: false });
    expect(JSON.stringify(h.emit.mock.calls)).not.toContain(secret);
  });

  it("has no DB/bootstrap/token/reset dependencies or configurable message contents", () => {
    const script = readFileSync(resolve(root, "scripts/send-synthetic-recovery-email-once.js"), "utf8");
    expect(script).not.toMatch(/require\(["'](?:@st-michael\/database|@st-michael\/integrations)/);
    expect(script).not.toContain("PrismaClient");
    expect(script).not.toContain(".verify(");
    expect(script.match(/await transport\.sendMail\(/g)).toHaveLength(1);
    expect(script).not.toMatch(/env\.(SUBJECT|BODY|RESET_TOKEN|RECOVERY_URL|DATABASE_URL)/);
  });

  it("requires explicit workflow confirmation, exclusive production lock and pinned source/SSH", () => {
    const workflow = readFileSync(resolve(root, ".github/workflows/send-synthetic-recovery-email-once.yml"), "utf8");
    const parsed: any = parse(workflow);
    expect(parsed.on.workflow_dispatch.inputs.confirm_test_email).toMatchObject({ type: "boolean", default: false });
    expect(parsed.concurrency).toEqual({ group: "production-deploy", "cancel-in-progress": false });
    expect(parsed.permissions).toEqual({ contents: "read" });
    expect(workflow).toContain("jq -c '.inputs.confirm_test_email'");
    expect(parsed.jobs.inspect.steps[1].env.EXPECTED_RUN_ATTEMPT).toBe("${{ github.run_attempt }}");
    expect(workflow).toContain("GITHUB_EVENT_PATH");
    expect(workflow).toContain("flock -x -n 9");
    expect(workflow).toContain("StrictHostKeyChecking=yes");
    expect(workflow).toContain("actual_script_sha");
    expect(workflow).toContain("container_sha");
    expect(workflow).toContain("trap cleanup EXIT HUP INT TERM");
    expect(workflow).not.toContain("${{ inputs.email }}");
    expect(workflow).not.toMatch(/\b(git fetch|eval|docker cp|docker compose up)\b/);
  });

  it.each([
    { value: true, accepted: true }, { value: "true", accepted: true },
    { value: false, accepted: false }, { value: "false", accepted: false },
    { value: 1, accepted: false }, { value: "1", accepted: false },
    { value: null, accepted: false }, { value: "TRUE", accepted: false },
  ])("validates event JSON confirmation without coercion: $value", ({ value, accepted }) => {
    const event = JSON.parse(JSON.stringify({ inputs: { confirm_test_email: value } }));
    // jq -c '.inputs.confirm_test_email' produces this canonical JSON value.
    // Execute the ACTUAL extracted Bash gate, not a parallel truthiness helper.
    const canonicalValue = JSON.stringify(event.inputs.confirm_test_email);
    const run = workflowRun();
    const confirmationGate = run.split("\n").find((line) => line.startsWith('case "$confirmation_json"'));
    expect(confirmationGate).toBeDefined();
    const result = runLocalGate(`${confirmationGate}\nprintf 'GATE_PASSED'`, { confirmation_json: canonicalValue });
    expect(result.status).toBe(accepted ? 0 : 1);
    expect(result.stdout.includes("GATE_PASSED")).toBe(accepted);
  });

  it.each(["1", "2", "3", "", "01", "true"])("permits only first GitHub run attempt: %s", (attempt) => {
    const run = workflowRun();
    const attemptGate = run.split("\n").find((line) => line.startsWith('test "$EXPECTED_RUN_ATTEMPT"'));
    expect(attemptGate).toBeDefined();
    expect(run.indexOf(attemptGate!)).toBeLessThan(run.indexOf("ssh-keyscan"));
    expect(run.indexOf(attemptGate!)).toBeLessThan(run.indexOf("confirmation_json=$(jq"));
    const result = runLocalGate(`${attemptGate}\nprintf 'GATE_PASSED'`, { EXPECTED_RUN_ATTEMPT: attempt });
    expect(result.status).toBe(attempt === "1" ? 0 : 1);
    expect(result.stdout.includes("GATE_PASSED")).toBe(attempt === "1");
  });
});
