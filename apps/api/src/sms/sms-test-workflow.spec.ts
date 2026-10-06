import { readFileSync } from "fs";
import { resolve } from "path";
import { parse } from "yaml";

const root = resolve(__dirname, "../../../..");
const { run, validateInput, sampleText } = require(resolve(root, "scripts/apply-sms-test-send.js"));
const phone = "+79990000000";
const env = { PHONE: phone, SAMPLE: "PASSWORD_RESET_CODE", APPLY: "0", GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1" };
const settings = (extra: Record<string, string> = {}) => Object.entries({
  SMSC_LOGIN: "test-login", SMSC_API_KEY: "secret-test-only", SMSC_SENDER: "test-sender", ...extra,
}).map(([key, value]) => ({ key, value }));

function harness(extra: Record<string, string> = {}) {
  const reserved = new Set<string>();
  const prisma: any = {
    systemSetting: { findMany: jest.fn().mockResolvedValue(settings(extra)), upsert: jest.fn() },
    smsMessage: {
      create: jest.fn().mockImplementation(async ({ data }: any) => {
        if (reserved.has(data.id)) throw new Error("unique reservation");
        reserved.add(data.id);
        return data;
      }),
      update: jest.fn(),
      findFirst: jest.fn().mockResolvedValue({ id: "sms-test-123", status: "SENT" }),
    },
    $disconnect: jest.fn(),
  };
  prisma.$transaction = jest.fn().mockImplementation(async (fn: any) => fn(prisma));
  const adapter = {
    getBalance: jest.fn().mockResolvedValue({ ok: true, balance: 100 }),
    send: jest.fn().mockResolvedValue({ ok: true, id: "456", parts: 1, cost: 2 }),
    getStatus: jest.fn().mockResolvedValue({ ok: true, status: 1 }),
  };
  const load = jest.fn().mockReturnValue({ prisma, SmscAdapter: jest.fn().mockReturnValue(adapter),
    isSmscDelivered: (s: number) => [1, 2, 4].includes(s),
    isSmscFinalStatus: (s: number) => [1, 2, 3, 4, -2, -3].includes(s) || s >= 20 });
  const emit = jest.fn();
  return { prisma, adapter, load, emit };
}

describe("production SMS TEST execution", () => {
  it("clearly identifies the recovery sample as a nonfunctional test code in one SMS", () => {
    const text = sampleText("PASSWORD_RESET_CODE");
    expect(text).toMatch(/^Тест СМС: \d{6}\. Код недействителен для входа и смены пароля\.$/);
    expect(text.length).toBeLessThanOrEqual(70);
  });

  it.each([
    { PHONE: "+79990000000;echo unsafe" }, { SAMPLE: "arbitrary" }, { APPLY: "true" },
    { STATUS_ID: "1;echo unsafe" }, { STATUS_ID: "1", APPLY: "1" },
    { APPLY: "1", GITHUB_RUN_ATTEMPT: "2" }, { APPLY: "1", GITHUB_RUN_ID: "" },
    { CONFIRM_ENABLE_PASSWORD_RESET: "1" }, { APPLY: "1", CONFIRM_ENABLE_PASSWORD_RESET: "1" },
  ])("rejects unsafe inputs before loading DB/network %j", async (override) => {
    const h = harness();
    await expect(run({ ...env, ...override }, h.load, h.emit)).rejects.toThrow();
    expect(h.load).not.toHaveBeenCalled();
  });

  it("dry-run only reads settings and balance, never sends or writes", async () => {
    const h = harness();
    await expect(run(env, h.load, h.emit)).resolves.toEqual({ sent: false });
    expect(h.adapter.getBalance).toHaveBeenCalledTimes(1);
    expect(h.adapter.send).not.toHaveBeenCalled();
    expect(h.prisma.smsMessage.create).not.toHaveBeenCalled();
    expect(h.prisma.systemSetting.upsert).not.toHaveBeenCalled();
    expect(h.prisma.$disconnect).toHaveBeenCalledTimes(1);
    expect(h.emit).toHaveBeenCalledWith({ balanceChecked: true, sufficientBalance: true });
    expect(JSON.stringify(h.emit.mock.calls)).not.toContain('"balance":');
  });

  it.each([0, -1, Infinity, undefined, "100"])("invalid/insufficient balance %s cannot reserve or send", async (balance) => {
    const h = harness();
    h.adapter.getBalance.mockResolvedValue({ ok: true, balance } as any);
    await expect(run({ ...env, APPLY: "1" }, h.load, h.emit)).rejects.toThrow("balance is insufficient");
    expect(h.prisma.smsMessage.create).not.toHaveBeenCalled();
    expect(h.adapter.send).not.toHaveBeenCalled();
    expect(h.emit).toHaveBeenCalledWith({ balanceChecked: true, sufficientBalance: false });
    expect(JSON.stringify(h.emit.mock.calls)).not.toContain('"balance":');
  });

  it("missing configuration or failed balance cannot reserve/send", async () => {
    const missing = harness();
    missing.prisma.systemSetting.findMany.mockResolvedValue([]);
    await expect(run({ ...env, APPLY: "1" }, missing.load, missing.emit)).rejects.toThrow();
    expect(missing.adapter.getBalance).not.toHaveBeenCalled();
    expect(missing.adapter.send).not.toHaveBeenCalled();
    expect(missing.prisma.smsMessage.create).not.toHaveBeenCalled();
    const balance = harness();
    balance.adapter.getBalance.mockResolvedValue({ ok: false, error: "raw secret response" } as any);
    await expect(run({ ...env, APPLY: "1" }, balance.load, balance.emit)).rejects.toThrow();
    expect(balance.adapter.send).not.toHaveBeenCalled();
    expect(balance.prisma.smsMessage.create).not.toHaveBeenCalled();
    expect(balance.emit).toHaveBeenCalledWith(expect.objectContaining({ failureTag: "BALANCE_FAILED" }));
  });

  it("reserves a durable TEST id before one send and masks the synthetic code", async () => {
    const h = harness();
    await expect(run({ ...env, APPLY: "1" }, h.load, h.emit)).resolves.toMatchObject({ sent: true, providerId: "456", delivered: false });
    expect(h.adapter.send).toHaveBeenCalledTimes(1);
    expect(h.prisma.smsMessage.create.mock.invocationCallOrder[0]).toBeLessThan(h.adapter.send.mock.invocationCallOrder[0]);
    const data = h.prisma.smsMessage.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ id: "sms-test-123", phone, kind: "TEST", status: "QUEUED" });
    expect(data.text).toContain("••••••");
    expect(data.text).not.toMatch(/\d{6}/);
    await expect(run({ ...env, APPLY: "1" }, h.load, h.emit)).rejects.toThrow("unique reservation");
    expect(h.adapter.send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.emit.mock.calls)).not.toContain(phone);
    expect(JSON.stringify(h.emit.mock.calls)).not.toContain("secret-test-only");
  });

  it("never retries after a provider failure/ambiguous outcome", async () => {
    const h = harness();
    h.adapter.send.mockResolvedValue({ ok: false, error: "raw secret response" } as any);
    await expect(run({ ...env, APPLY: "1" }, h.load, h.emit)).rejects.toThrow();
    await expect(run({ ...env, APPLY: "1" }, h.load, h.emit)).rejects.toThrow();
    expect(h.adapter.send).toHaveBeenCalledTimes(1);
    expect(h.emit).toHaveBeenCalledWith(expect.objectContaining({ failureTag: "SEND_FAILED_OR_UNKNOWN", automaticRetry: false }));
    expect(JSON.stringify(h.emit.mock.calls)).not.toContain("raw secret response");
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9])("projects documented provider error code %s, without retry or raw text", async (errorCode) => {
    const h = harness();
    h.adapter.send.mockResolvedValue({ ok: false, errorCode, error: "raw secret response" } as any);
    await expect(run({ ...env, APPLY: "1" }, h.load, h.emit)).rejects.toThrow();
    expect(h.emit).toHaveBeenCalledWith({ sent: false, errorCode, outcomeMayBeUnknown: false, automaticRetry: false });
    expect(h.prisma.smsMessage.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "FAILED", error: `Provider error_code=${errorCode}. Do not automatically resend.` } }));
    expect(h.adapter.send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.emit.mock.calls)).not.toContain("raw secret response");
  });

  it.each([99, -1, Infinity, 0, 1.5, "6", undefined])("treats undocumented provider error code %s as unknown, without retry", async (errorCode) => {
    const h = harness();
    h.adapter.send.mockResolvedValue({ ok: false, errorCode, error: "raw secret response" } as any);
    await expect(run({ ...env, APPLY: "1" }, h.load, h.emit)).rejects.toThrow();
    expect(h.emit).toHaveBeenCalledWith({ sent: false, errorCode: null, outcomeMayBeUnknown: true, automaticRetry: false });
    expect(h.prisma.smsMessage.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "FAILED", error: "Provider rejected or outcome unknown. Do not automatically resend." } }));
    await expect(run({ ...env, APPLY: "1" }, h.load, h.emit)).rejects.toThrow();
    expect(h.adapter.send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.emit.mock.calls)).not.toContain("raw secret response");
  });

  it("status-only binds provider id + phone + TEST journal and never sends/writes", async () => {
    const h = harness();
    await expect(run({ ...env, STATUS_ID: "456" }, h.load, h.emit)).resolves.toMatchObject({ delivered: true });
    expect(h.prisma.smsMessage.findFirst).toHaveBeenCalledWith({
      where: { kind: "TEST", phone, providerId: "456" }, select: { id: true, status: true },
    });
    expect(h.adapter.getStatus).toHaveBeenCalledWith("456", phone);
    expect(h.adapter.send).not.toHaveBeenCalled();
    expect(h.adapter.getBalance).not.toHaveBeenCalled();
    expect(h.prisma.smsMessage.update).not.toHaveBeenCalled();
    expect(h.prisma.systemSetting.upsert).not.toHaveBeenCalled();
  });

  it("does not query the provider for an unbound TEST id", async () => {
    const h = harness();
    h.prisma.smsMessage.findFirst.mockResolvedValue(null);
    await expect(run({ ...env, STATUS_ID: "456" }, h.load, h.emit)).rejects.toThrow();
    expect(h.adapter.getStatus).not.toHaveBeenCalled();
  });

  it.each([1, 2, 4])("enables only reset + global flags after delivered status %s", async (status) => {
    const h = harness();
    h.adapter.getStatus.mockResolvedValue({ ok: true, status });
    await expect(run({ ...env, STATUS_ID: "456", CONFIRM_ENABLE_PASSWORD_RESET: "1" }, h.load, h.emit)).resolves.toMatchObject({ passwordResetEnabled: true });
    expect(h.prisma.systemSetting.upsert.mock.calls.map((c: any) => c[0].where.key)).toEqual(["SMS_ENABLED", "SMS_OTP_PASSWORD_RESET"]);
    expect(h.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "Serializable" });
    expect(h.adapter.send).not.toHaveBeenCalled();
    expect(h.prisma.smsMessage.update).not.toHaveBeenCalled();
  });

  it.each([-1, 0, 3, 20, 22])("does not enable on pending/failed delivery %s", async (status) => {
    const h = harness();
    h.adapter.getStatus.mockResolvedValue({ ok: true, status });
    await expect(run({ ...env, STATUS_ID: "456", CONFIRM_ENABLE_PASSWORD_RESET: "1" }, h.load, h.emit)).rejects.toThrow();
    expect(h.prisma.systemSetting.upsert).not.toHaveBeenCalled();
    expect(h.adapter.send).not.toHaveBeenCalled();
  });

  it.each(["FAILED", "QUEUED", "SKIPPED"])("does not enable from unknown/failed TEST journal %s", async (status) => {
    const h = harness();
    h.prisma.smsMessage.findFirst.mockResolvedValue({ id: "sms-test-123", status });
    await expect(run({ ...env, STATUS_ID: "456", CONFIRM_ENABLE_PASSWORD_RESET: "1" }, h.load, h.emit)).rejects.toThrow();
    expect(h.prisma.systemSetting.upsert).not.toHaveBeenCalled();
    expect(h.adapter.getStatus).not.toHaveBeenCalled();
  });

  it("provider status error cannot enable and raw response is never emitted", async () => {
    const h = harness();
    h.adapter.getStatus.mockResolvedValue({ ok: false, error: "raw secret response" } as any);
    await expect(run({ ...env, STATUS_ID: "456", CONFIRM_ENABLE_PASSWORD_RESET: "1" }, h.load, h.emit)).rejects.toThrow();
    expect(h.prisma.systemSetting.upsert).not.toHaveBeenCalled();
    expect(h.adapter.send).not.toHaveBeenCalled();
    expect(JSON.stringify(h.emit.mock.calls)).not.toContain("raw secret response");
  });

  it.each(["SMS_OTP_LOGIN", "SMS_OTP_REGISTER", "SMS_FIXATION_EXPIRY"])("blocks surprising global activation of %s", async (key) => {
    const h = harness({ [key]: "1" });
    await expect(run({ ...env, STATUS_ID: "456", CONFIRM_ENABLE_PASSWORD_RESET: "1" }, h.load, h.emit)).rejects.toThrow("Global enable");
    expect(h.prisma.systemSetting.upsert).not.toHaveBeenCalled();
  });

  it.each(["SMSC_LOGIN", "SMSC_API_KEY", "SMSC_SENDER"])("blocks credentials/sender changes after delivery %s", async (key) => {
    const h = harness();
    h.prisma.systemSetting.findMany.mockResolvedValueOnce(settings()).mockResolvedValueOnce(settings({ [key]: "changed" }));
    await expect(run({ ...env, STATUS_ID: "456", CONFIRM_ENABLE_PASSWORD_RESET: "1" }, h.load, h.emit)).rejects.toThrow("settings changed");
    expect(h.prisma.systemSetting.upsert).not.toHaveBeenCalled();
  });

  it("preserves already-effective other flows without changing their settings", async () => {
    const h = harness({ SMS_ENABLED: "1", SMS_OTP_LOGIN: "1", SMS_OTP_REGISTER: "1", SMS_FIXATION_EXPIRY: "1" });
    await expect(run({ ...env, STATUS_ID: "456", CONFIRM_ENABLE_PASSWORD_RESET: "1" }, h.load, h.emit)).resolves.toMatchObject({ passwordResetEnabled: true });
    expect(h.prisma.systemSetting.upsert.mock.calls.map((c: any) => c[0].where.key)).toEqual(["SMS_ENABLED", "SMS_OTP_PASSWORD_RESET"]);
  });
});

describe("SMS workflow source safety contract", () => {
  const workflow = readFileSync(resolve(root, ".github/workflows/apply-sms-test-send.yml"), "utf8");
  const script = readFileSync(resolve(root, "scripts/apply-sms-test-send.js"), "utf8");
  const parsed = parse(workflow);

  it("pins the canonical reviewed source, SSH fingerprint and production lock", () => {
    expect(parsed.jobs.test.environment).toBe("production");
    expect(parsed.concurrency.group).toBe("production-deploy");
    expect(parsed.on.workflow_dispatch.inputs.confirm_enable_password_reset.default).toBe(false);
    expect(workflow).toContain("actions/checkout@11d5960a326750d5838078e36cf38b85af677262");
    expect(workflow).toContain('test "$EXPECTED_REF" = "refs/heads/master"');
    expect(workflow).toContain('test "${fingerprints[0]}" = "$EXPECTED_SSH_FINGERPRINT"');
    expect(workflow).toContain("-o StrictHostKeyChecking=yes");
    expect(workflow).toContain('test "$container_sha" = "$production_sha"');
    expect(workflow).toContain('flock -n 9');
    expect(workflow).toContain('test "$actual_script_sha" = "$expected_script_sha"');
    expect(workflow).toContain('trap cleanup EXIT HUP INT TERM');
    expect(workflow).not.toContain("appleboy/");
    expect(workflow).not.toContain("docker cp");
    expect(workflow).not.toContain("git fetch");
    expect(workflow).toContain('[ "$RUN_ATTEMPT_INPUT" != 1 ]');
  });

  it("has one shared-adapter send call, no raw provider dumps or account/OTP writes", () => {
    expect((script.match(/adapter\.send\(/g) || []).length).toBe(1);
    expect(script).not.toContain("fetch(");
    expect(script).not.toMatch(/prisma\.(broker|phoneOtp)/);
    expect(script).not.toContain("all: \"1\"");
    expect(script).not.toContain("psw:");
    expect(() => validateInput({ ...env, STATUS_ID: "456", CONFIRM_ENABLE_PASSWORD_RESET: "1" })).not.toThrow();
  });

  it("loads the recipient from the event file and masks it before use, not in public env logs", () => {
    expect(workflow).not.toContain("PHONE_INPUT:");
    expect(workflow).not.toContain("${{ inputs.phone }}");
    const loadPhone = workflow.indexOf("PHONE_INPUT=$(jq");
    const maskPhone = workflow.indexOf("printf '::add-mask::%s\\n'", loadPhone);
    const validatePhone = workflow.indexOf('[[ "$PHONE_INPUT" =~', loadPhone);
    expect(loadPhone).toBeGreaterThan(0);
    expect(maskPhone).toBeGreaterThan(loadPhone);
    expect(validatePhone).toBeGreaterThan(maskPhone);
    expect(workflow.slice(loadPhone, maskPhone)).toContain('select(length == 12 and test("^\\\\+7[0-9]{10}$"))');
    expect(workflow).toContain('"$GITHUB_EVENT_PATH"');
    expect(workflow).toContain('"${PHONE_INPUT#+}"');
  });
});
