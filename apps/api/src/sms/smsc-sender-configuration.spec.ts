import { readFileSync } from "fs";
import { resolve } from "path";
import { createHash } from "crypto";
import { spawnSync } from "child_process";
import { parse } from "yaml";

const root = resolve(__dirname, "../../../..");
const { run } = require(resolve(root, "scripts/configure-smsc-sender.js"));
const env = {
  PHONE: "+79990000000", CONFIRM_SET_SENDER: "1", NODE_ENV: "production", GITHUB_RUN_ID: "123456",
  SOURCE_SHA: "a".repeat(40), RUNTIME_SHA: "b".repeat(40), GIT_SHA: "b".repeat(40),
  EXPECTED_PG_SYSTEM_IDENTIFIER: "123456789", PRODUCTION_MIN_BROKER_ROWS: "2",
};
const secret = "SYNTHETIC_PRIVATE_CREDENTIAL", login = "SYNTHETIC_PRIVATE_LOGIN";
const date = new Date("2026-10-08T00:00:00.000Z");
const clone = (rows: any[]) => rows.map((row) => ({ ...row, updatedAt: new Date(row.updatedAt) }));
function response(data: any, ok = true) {
  const bytes = Buffer.from(typeof data === "string" ? data : JSON.stringify(data));
  let read = false;
  return { ok, body: { getReader: () => ({
    read: jest.fn(async () => read ? { done: true } : (read = true, { done: false, value: bytes })),
    cancel: jest.fn(async () => {}), releaseLock: jest.fn(),
  }) } };
}
function harness(sender: string | null = "") {
  let rows = [{ key: "SMSC_LOGIN", value: login, updatedAt: date }, { key: "SMSC_API_KEY", value: secret, updatedAt: date }];
  if (sender !== null) rows.push({ key: "SMSC_SENDER", value: sender, updatedAt: date });
  const set = (key: string, value: string) => {
    const existing = rows.find((row) => row.key === key);
    if (existing) { existing.value = value; existing.updatedAt = new Date(existing.updatedAt.getTime() + 1); }
    else rows.push({ key, value, updatedAt: date });
  };
  const settings: any = {
    findMany: jest.fn(async () => clone(rows)),
    create: jest.fn(async ({ data }) => { if (rows.some((row) => row.key === data.key)) throw new Error("private unique conflict"); rows.push({ ...data, updatedAt: new Date(date.getTime() + 1) }); return data; }),
    updateMany: jest.fn(async ({ where, data }) => {
      const row = rows.find((row) => row.key === where.key && row.value === where.value && row.updatedAt.getTime() === where.updatedAt.getTime());
      if (!row) return { count: 0 };
      Object.assign(row, data, { updatedAt: new Date(date.getTime() + 1) });
      return { count: 1 };
    }),
  };
  const prisma: any = {
    systemSetting: settings,
    $queryRaw: jest.fn(async (sql) => String(sql).includes("FOR UPDATE") ? [] : [{ systemIdentifier: "123456789", brokerRows: "42" }]),
    $disconnect: jest.fn(),
    smsMessage: { create: jest.fn(), update: jest.fn() }, broker: { update: jest.fn() }, phoneOtp: { create: jest.fn(), updateMany: jest.fn() },
  };
  prisma.$transaction = jest.fn(async (callback) => {
    const previous = clone(rows);
    try { return await callback(prisma); } catch (error) { rows = previous; throw error; }
  });
  const fetch: any = jest.fn(async (url, _options) => response(url.endsWith("senders.php")
    ? [{ sender: "ST MICHAEL", id: 1 }, { sender: "FOREIGN_PRIVATE_NAME", id: 2 }]
    : { cost: "8.70", cnt: 1 }));
  const load = jest.fn(() => ({ prisma, fetch })), emit = jest.fn();
  return { prisma, settings, fetch, load, emit, set, rows: () => clone(rows) };
}
const assertNoLeaks = (h: ReturnType<typeof harness>) => {
  const output = JSON.stringify(h.emit.mock.calls);
  for (const value of [secret, login, env.PHONE, env.PHONE.slice(1), "FOREIGN_PRIVATE_NAME", "000000", "private unique conflict"]) expect(output).not.toContain(value);
  expect(h.prisma.smsMessage.create).not.toHaveBeenCalled();
  expect(h.prisma.smsMessage.update).not.toHaveBeenCalled();
  expect(h.prisma.broker.update).not.toHaveBeenCalled();
  expect(h.prisma.phoneOtp.create).not.toHaveBeenCalled();
  expect(h.prisma.phoneOtp.updateMany).not.toHaveBeenCalled();
};

describe("approved fixed SMS sender configuration only", () => {
  it.each([
    { CONFIRM_SET_SENDER: "true" }, { CONFIRM_SET_SENDER: "0" }, { PHONE: env.PHONE + "\n" },
    { PHONE: "+79990000000,+79990000001" }, { GITHUB_RUN_ID: "1\n" }, { SOURCE_SHA: "x" },
    { RUNTIME_SHA: "c".repeat(40) }, { NODE_ENV: "development" }, { EXPECTED_PG_SYSTEM_IDENTIFIER: "0" }, { PRODUCTION_MIN_BROKER_ROWS: "0" },
  ])("rejects unsafe input before database or network: %j", async (extra) => {
    const h = harness();
    await expect(run({ ...env, ...extra }, h.load, h.emit)).rejects.toThrow("INPUT_INVALID");
    expect(h.load).not.toHaveBeenCalled();
  });

  it.each(["", null])("writes only canonical sender from initially %s", async (sender) => {
    const h = harness(sender);
    const result = await run({ ...env, COST: "3", SENDER: "foreign", BASE_URL: "https://unsafe.example" }, h.load, h.emit);
    expect(result).toMatchObject({ sender: "ST MICHAEL", settingsChanged: true, verifiedNoop: false, providerRequests: 2, smsSent: false, smsFlagsUnchanged: true, runId: env.GITHUB_RUN_ID });
    expect(h.prisma.$transaction.mock.calls[0][1]).toEqual({ isolationLevel: "Serializable", maxWait: 5000, timeout: 15000 });
    const writes = sender === null ? h.settings.create : h.settings.updateMany;
    expect(writes).toHaveBeenCalledTimes(1);
    expect(writes.mock.calls[0][0].data).toEqual(expect.objectContaining({ value: "ST MICHAEL", updatedBy: "workflow:configure-smsc-sender:123456" }));
    expect(h.rows().find((row) => row.key === "SMSC_SENDER")!.value).toBe("ST MICHAEL");
    expect(h.fetch).toHaveBeenCalledTimes(2);
    const listing = new URLSearchParams(h.fetch.mock.calls[0][1].body);
    const estimate = new URLSearchParams(h.fetch.mock.calls[1][1].body);
    expect(listing.get("get")).toBe("1");
    expect(listing.get("add")).toBeNull(); expect(listing.get("del")).toBeNull();
    expect(estimate.getAll("cost")).toEqual(["1"]); expect(estimate.get("sender")).toBe("ST MICHAEL");
    expect(estimate.get("mes")).toContain("000000"); expect(estimate.get("phones")).toBe(env.PHONE.slice(1));
    for (const [url, options] of h.fetch.mock.calls) {
      expect(url).toMatch(/^https:\/\/smsc\.ru\/sys\/(senders|send)\.php$/);
      expect(options.method).toBe("POST"); expect(options.redirect).toBe("error");
      expect(options.signal).toBeInstanceOf(AbortSignal);
    }
    expect(h.prisma.$queryRaw.mock.calls.some(([sql]) => String(sql).includes("ORDER BY key FOR UPDATE"))).toBe(true);
    assertNoLeaks(h);
  });

  it("is an exact approved/cost-checked idempotent noop", async () => {
    const h = harness("ST MICHAEL");
    const result = await run(env, h.load, h.emit);
    expect(result).toMatchObject({ settingsChanged: false, verifiedNoop: true, providerRequests: 2 });
    expect(h.settings.create).not.toHaveBeenCalled(); expect(h.settings.updateMany).not.toHaveBeenCalled();
    assertNoLeaks(h);
  });

  it.each(["St. Michael", "st michael", "OTHER"])('never replaces another configured identity "%s"', async (sender) => {
    const h = harness(sender);
    await expect(run(env, h.load, h.emit)).rejects.toThrow("CONFIGURATION_FAILED");
    expect(h.emit.mock.calls[0][0].failureTag).toBe("SENDER_CONFLICT");
    expect(h.fetch).not.toHaveBeenCalled(); expect(h.prisma.$transaction).not.toHaveBeenCalled(); assertNoLeaks(h);
  });

  it.each(["SMS_ENABLED", "SMS_OTP_LOGIN", "SMS_OTP_REGISTER", "SMS_OTP_PASSWORD_RESET", "SMS_FIXATION_EXPIRY"])("blocks even pending enabled flag %s", async (key) => {
    const h = harness(); h.set(key, "yes");
    await expect(run(env, h.load, h.emit)).rejects.toThrow();
    expect(h.emit.mock.calls[0][0].failureTag).toBe("SMS_FLAGS_ENABLED");
    expect(h.fetch).not.toHaveBeenCalled(); expect(h.settings.updateMany).not.toHaveBeenCalled();
  });
  it.each(["2", "undefined", "disabled?", "false\n::warning::private"])("rejects ambiguous flag %s", async (value) => {
    const h = harness(); h.set("SMS_OTP_PASSWORD_RESET", value);
    await expect(run(env, h.load, h.emit)).rejects.toThrow();
    expect(h.emit.mock.calls[0][0].failureTag).toBe("SMS_FLAGS_INVALID"); expect(h.fetch).not.toHaveBeenCalled();
  });
  it("respects env fallback and explicit database disabled override", async () => {
    const blocked = harness();
    await expect(run({ ...env, SMS_OTP_LOGIN: "true" }, blocked.load, blocked.emit)).rejects.toThrow();
    expect(blocked.fetch).not.toHaveBeenCalled();
    const h = harness(); h.set("SMS_OTP_LOGIN", "0");
    await run({ ...env, SMS_OTP_LOGIN: "true" }, h.load, h.emit);
    expect(h.rows().find((row) => row.key === "SMS_OTP_LOGIN")!.value).toBe("0");
  });

  it.each([
    { identity: [{ systemIdentifier: "987", brokerRows: "42" }] },
    { identity: [{ systemIdentifier: "123456789", brokerRows: "1" }] },
    { identity: [{ systemIdentifier: "123456789", brokerRows: "private" }] },
    { identity: [] },
  ])("checks the actual API database identity/floor", async ({ identity }) => {
    const h = harness(); h.prisma.$queryRaw.mockResolvedValue(identity);
    await expect(run(env, h.load, h.emit)).rejects.toThrow();
    expect(h.emit.mock.calls[0][0].failureTag).toBe("DATABASE_IDENTITY_INVALID"); expect(h.fetch).not.toHaveBeenCalled();
  });
  it.each(["St. Michael", "st michael", " ST MICHAEL", "ST MICHAEL "])("requires exact provider approval, not %s", async (sender) => {
    const h = harness(); h.fetch.mockResolvedValue(response([{ sender }]));
    await expect(run(env, h.load, h.emit)).rejects.toThrow();
    expect(h.emit.mock.calls[0][0].failureTag).toBe("SENDER_NOT_EXACTLY_APPROVED"); expect(h.fetch).toHaveBeenCalledTimes(1);
  });
  it("refuses duplicated exact identity rather than guessing", async () => {
    const h = harness(); h.fetch.mockResolvedValue(response([{ sender: "ST MICHAEL" }, { sender: "ST MICHAEL" }]));
    await expect(run(env, h.load, h.emit)).rejects.toThrow(); expect(h.settings.updateMany).not.toHaveBeenCalled();
  });

  it.each(["SMSC_LOGIN", "SMSC_API_KEY", "SMSC_SENDER", "SMS_OTP_PASSWORD_RESET"])("CAS rejects changed settings during provider check: %s", async (key) => {
    const h = harness(); h.fetch.mockImplementationOnce(async () => response([{ sender: "ST MICHAEL" }])).mockImplementationOnce(async () => {
      h.set(key, key === "SMSC_SENDER" ? "ST MICHAEL" : key.startsWith("SMS_OTP") ? "0" : "changed-private-value");
      return response({ cost: "8.7", cnt: 1 });
    });
    await expect(run(env, h.load, h.emit)).rejects.toThrow();
    expect(h.emit.mock.calls[0][0].failureTag).toBe("SETTINGS_CHANGED");
    expect(h.settings.updateMany).not.toHaveBeenCalled(); expect(h.settings.create).not.toHaveBeenCalled(); assertNoLeaks(h);
  });
  it("CAS refuses failed update without retry and marks outcome conservatively", async () => {
    const h = harness(); h.settings.updateMany.mockResolvedValue({ count: 0 });
    await expect(run(env, h.load, h.emit)).rejects.toThrow();
    expect(h.settings.updateMany).toHaveBeenCalledTimes(1); expect(h.emit.mock.calls[0][0].configurationOutcomeMayBeUnknown).toBe(true);
  });
  it("readback mismatch rolls back the sender write", async () => {
    const h = harness(); const original = h.settings.updateMany.getMockImplementation();
    h.settings.updateMany.mockImplementation(async (args) => { const result = await original(args); h.set("SMSC_LOGIN", "changed-private-value"); return result; });
    await expect(run(env, h.load, h.emit)).rejects.toThrow();
    expect(h.rows().find((row) => row.key === "SMSC_SENDER")!.value).toBe("");
    expect(h.emit.mock.calls[0][0].failureTag).toBe("READBACK_FAILED"); assertNoLeaks(h);
  });

  it.each([{ cost: "8.7", cnt: 1, id: 123 }, { cost: -1, cnt: 1 }, { cost: "8.7", cnt: 0 }, { cost: "private", cnt: 1 }])("refuses invalid cost-only response", async (estimate) => {
    const h = harness(); h.fetch.mockImplementationOnce(async () => response([{ sender: "ST MICHAEL" }])).mockImplementationOnce(async () => response(estimate));
    await expect(run(env, h.load, h.emit)).rejects.toThrow(); expect(h.prisma.$transaction).not.toHaveBeenCalled(); assertNoLeaks(h);
  });
  it("bounds body streaming, cancels over-limit data, and never retries", async () => {
    const h = harness(); let reads = 0; const cancel = jest.fn(async () => {});
    h.fetch.mockResolvedValue({ ok: true, body: { getReader: () => ({ read: async () => ({ done: false, value: (reads++, new Uint8Array(65537)) }), cancel, releaseLock: jest.fn() }) } });
    await expect(run(env, h.load, h.emit)).rejects.toThrow();
    expect(reads).toBe(2); expect(cancel).toHaveBeenCalledTimes(1); expect(h.fetch).toHaveBeenCalledTimes(1); expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });
  it("never emits raw transport/private exceptions or performs a retry", async () => {
    const h = harness(); h.fetch.mockRejectedValue(new Error(`${secret} ${env.PHONE} raw private provider body`));
    await expect(run(env, h.load, h.emit)).rejects.toThrow("CONFIGURATION_FAILED");
    expect(h.fetch).toHaveBeenCalledTimes(1); expect(h.emit.mock.calls[0][0].failureTag).toBe("PROVIDER_TRANSPORT_FAILED"); assertNoLeaks(h);
  });
});

describe("protected sender-only production workflow", () => {
  const source = readFileSync(resolve(root, ".github/workflows/configure-smsc-sender.yml"), "utf8");
  const workflow = parse(source), step = workflow.jobs.configure.steps[1];
  const run = step.run.replace(/\r\n/g, "\n");
  const prefix = run.split("<<'REMOTE_PREFIX'\n")[1].split("\nREMOTE_PREFIX")[0];
  const suffix = run.split("<<'REMOTE_SUFFIX'\n")[1].split("\nREMOTE_SUFFIX")[0];
  const script = readFileSync(resolve(root, "scripts/configure-smsc-sender.js"));
  const assemble = (payload: Buffer) => `${prefix}\n${payload.toString("base64")}\nFIXED_SENDER_PAYLOAD\n${suffix}\n`;
  const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/bash";
  it("requires explicit confirmation, exact current master, SSH/runtime/PG and a nontruncating exclusive lock", () => {
    expect(workflow.on.workflow_dispatch.inputs.confirm_set_sender.default).toBe(false);
    expect(run).toContain('.inputs.confirm_set_sender == true or .inputs.confirm_set_sender == "true"');
    expect(workflow.concurrency).toEqual({ group: "production-deploy", "cancel-in-progress": false });
    expect(workflow.jobs.configure.environment).toBe("production"); expect(workflow.permissions).toEqual({ contents: "read" });
    expect(step.env.PHONE).toBeUndefined(); expect(source).not.toContain("${{ inputs.phone }}");
    expect(run.indexOf("select(length == 12")).toBeLessThan(run.indexOf("::add-mask::"));
    expect(run).toContain('test "$master_sha" = "$EXPECTED_SHA"'); expect(run).toContain("-o StrictHostKeyChecking=yes");
    expect(prefix).toContain('exec 9<"$lock_path"'); expect(prefix).toContain("flock -n 9"); expect(prefix).not.toContain("exec 9>");
    expect(prefix).toContain("--proto '=https'"); expect(prefix).not.toMatch(/--insecure|\bcurl -k\b/);
    expect(prefix).toContain("pg_control_system()"); expect(prefix).toContain("--user 0");
    expect(prefix).toContain('crypto.createHash("sha256").update(source).digest("hex") !== expected');
    expect(prefix).not.toMatch(/\b(mktemp|rm|cp|mv|chmod|chown|prune|restart|truncate)\b/);
    expect(prefix).not.toMatch(/--env-file|printenv|\.Config\.Env/);
  });
  it("parses both runner source and the real assembled SSH program", () => {
    for (const input of [run, assemble(script)]) {
      const result = spawnSync(bash, ["-n"], { input, encoding: "utf8", timeout: 5000 });
      expect(result.error).toBeUndefined(); expect(result.status).toBe(0); expect(result.stderr).toBe("");
    }
  });
  it.each([false, true])("executes assembled streamed/hash-bound source before final attestation (tampered=%s)", (tampered) => {
    const payload = Buffer.from('module.exports.run = async () => { console.log("SYNTHETIC_CONFIG_EXECUTED"); };');
    const hash = createHash("sha256").update(payload).digest("hex");
    const program = assemble(tampered ? Buffer.from(payload.toString() + "\n// tampered") : payload);
    const operation = program.slice(program.indexOf("set_stage remote_cost_only_checks_and_sender_setting"));
    const fixture = `set -euo pipefail
script_sha=${hash}
phone=+79990000000
run_id=123456
source_sha=${env.SOURCE_SHA}
runtime_sha=${env.RUNTIME_SHA}
pg_identifier=123456789
broker_floor=2
started_at=synthetic-start
lock_path=/dev/null
lock_identity=synthetic-inode
set_stage() { printf 'STAGE=%s\\n' "$1"; }
timeout() { shift; "$@"; }
docker() {
  if [ "$1" = inspect ]; then printf synthetic-start; return; fi
  test "$1" = exec || return 97
  while [ "$1" != node ]; do shift; done
  "$@"
}
assert_health() { printf 'SYNTHETIC_FINAL_HEALTH\\n'; }
git() { printf '%s' "$runtime_sha"; }
test() { if [ "$1" = -f ] && [ "$2" = /dev/null ]; then return 0; fi; builtin test "$@"; }
stat() { printf synthetic-inode; }
${operation}`;
    const result = spawnSync(bash, ["-s"], { input: fixture, encoding: "utf8", timeout: 5000, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } });
    expect(result.error).toBeUndefined(); expect(result.status).toBe(tampered ? 1 : 0);
    if (tampered) {
      expect(result.stdout).not.toContain("SYNTHETIC_CONFIG_EXECUTED"); expect(result.stdout).not.toContain("remote_final_attestation");
    } else {
      expect(result.stdout.indexOf("SYNTHETIC_CONFIG_EXECUTED")).toBeGreaterThan(-1);
      expect(result.stdout.indexOf("STAGE=remote_final_attestation")).toBeGreaterThan(result.stdout.indexOf("SYNTHETIC_CONFIG_EXECUTED"));
      expect(result.stdout).toContain("sender_configuration_completed_without_sms_or_service_restart=true");
    }
  });
});
