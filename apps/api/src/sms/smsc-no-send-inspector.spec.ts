import { readFileSync } from "fs";
import { resolve } from "path";
import { parse } from "yaml";

const root = resolve(__dirname, "../../../..");
const { run, buildReadOnlyDatabaseUrl } = require(
  resolve(root, "scripts/inspect-smsc-no-send.js"),
);
const phone = "+79990000000";
const secret = "test-only-secret-not-for-output";
const env = { PHONE: phone };
function response(data: any, ok = true) {
  return { ok, text: jest.fn().mockResolvedValue(JSON.stringify(data)) };
}
function harness(sender = "BusinessSender") {
  const prisma: any = {
    $queryRaw: jest.fn().mockResolvedValue([{ mode: "on" }]),
    systemSetting: {
      findMany: jest.fn().mockResolvedValue([
        { key: "SMSC_LOGIN", value: "private-account" },
        { key: "SMSC_API_KEY", value: secret },
        { key: "SMSC_SENDER", value: sender },
      ]),
    },
    $disconnect: jest.fn(),
  };
  const fetch = jest
    .fn()
    .mockResolvedValueOnce(response([{ sender: "BusinessSender", id: 1 }]))
    .mockResolvedValueOnce(response({ cost: "4.50", cnt: 1 }));
  const load = jest.fn().mockReturnValue({ prisma, fetch });
  const emit = jest.fn();
  return { prisma, fetch, load, emit };
}

describe("SMSC strictly no-send diagnostic", () => {
  it("forces read-only PostgreSQL sessions without emitting credentials", () => {
    const original =
      "postgresql://private:password@localhost/example?options=-c%20default_transaction_read_only%3Doff";
    const safe = new URL(buildReadOnlyDatabaseUrl(original));
    expect(safe.searchParams.getAll("options")).toHaveLength(1);
    expect(safe.searchParams.get("options")).toMatch(
      /default_transaction_read_only=on -c statement_timeout=15000$/,
    );
    expect(() => buildReadOnlyDatabaseUrl("https://example.test")).toThrow();
  });

  it.each([
    "",
    "+79990000000\n",
    "+79990000000\n::warning::unsafe",
    "+79990000000,79990000001",
    "79123456789",
    "+19990000000",
  ])(
    "rejects invalid/ambiguous input before DB/provider access",
    async (PHONE) => {
      const h = harness();
      await expect(run({ PHONE }, h.load, h.emit)).rejects.toThrow(
        "INPUT_INVALID",
      );
      expect(h.load).not.toHaveBeenCalled();
    },
  );

  it("uses exactly two fixed HTTPS POSTs, immutable get=1/cost=1 and no mutations", async () => {
    const h = harness();
    const report = await run(
      { ...env, COST: "3", APPLY: "1", BASE_URL: "https://unsafe.example" },
      h.load,
      h.emit,
    );
    expect(report).toMatchObject({
      readOnly: true,
      smsSent: false,
      databaseSessionReadOnly: true,
      senders: {
        ok: true,
        approvedSenderCount: 1,
        configuredSenderListed: true,
      },
      estimate: { ok: true, cost: 4.5, parts: 1 },
    });
    expect(h.fetch).toHaveBeenCalledTimes(2);
    const [senderUrl, senderOptions] = h.fetch.mock.calls[0];
    const [estimateUrl, estimateOptions] = h.fetch.mock.calls[1];
    expect(senderUrl).toBe("https://smsc.ru/sys/senders.php");
    expect(estimateUrl).toBe("https://smsc.ru/sys/send.php");
    const senderParams = new URLSearchParams(senderOptions.body);
    const estimateParams = new URLSearchParams(estimateOptions.body);
    expect(senderParams.get("get")).toBe("1");
    expect(senderParams.get("add")).toBeNull();
    expect(senderParams.get("del")).toBeNull();
    expect(senderParams.get("all")).toBeNull();
    expect(estimateParams.getAll("cost")).toEqual(["1"]);
    expect(estimateParams.get("phones")).toBe(phone.slice(1));
    expect(estimateParams.get("sender")).toBe("BusinessSender");
    for (const options of [senderOptions, estimateOptions]) {
      expect(options.method).toBe("POST");
      expect(options.redirect).toBe("error");
      expect(options.signal).toBeInstanceOf(AbortSignal);
    }
    expect(h.prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(h.prisma.systemSetting.findMany).toHaveBeenCalledTimes(1);
    expect(h.prisma.$disconnect).toHaveBeenCalledTimes(1);
    const output = JSON.stringify(h.emit.mock.calls);
    for (const privateValue of [
      phone,
      phone.slice(1),
      secret,
      "private-account",
      "BusinessSender",
      "000000",
    ]) {
      expect(output).not.toContain(privateValue);
    }
  });

  it("reports absent configured sender without inventing an active default", async () => {
    const h = harness("");
    const report = await run(env, h.load, h.emit);
    expect(report).toMatchObject({
      senderConfigured: false,
      defaultSenderRequested: true,
      senders: { configuredSenderListed: null, approvedSenderCount: 1 },
    });
    expect(
      new URLSearchParams(h.fetch.mock.calls[1][1].body).has("sender"),
    ).toBe(false);
  });

  it("projects only a bounded numeric provider error and never logs the raw body", async () => {
    const h = harness();
    h.fetch
      .mockReset()
      .mockResolvedValueOnce(
        response({ error: `${secret} ${phone}`, error_code: "2" }),
      )
      .mockResolvedValueOnce(
        response({ error: `${secret} ${phone}`, error_code: 6, id: phone }),
      );
    const report = await run(env, h.load, h.emit);
    expect(report.senders).toEqual({
      ok: false,
      errorCode: 2,
      failureTag: "PROVIDER_REJECTED",
    });
    expect(report.estimate).toEqual({
      ok: false,
      errorCode: 6,
      failureTag: "PROVIDER_REJECTED",
    });
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(h.emit.mock.calls)).not.toContain(phone);
    expect(JSON.stringify(h.emit.mock.calls)).not.toContain(secret);
  });

  it("does not retry transport failures or follow redirects", async () => {
    const h = harness();
    h.fetch.mockReset().mockRejectedValue(new Error(`${secret} ${phone}`));
    const report = await run(env, h.load, h.emit);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(report.senders.failureTag).toBe("TRANSPORT_FAILED");
    expect(report.estimate.failureTag).toBe("TRANSPORT_FAILED");
    expect(JSON.stringify(h.emit.mock.calls)).not.toContain(secret);
  });

  it.each([99, -1, "Infinity", "2:private text", phone.slice(1)])(
    "never projects undocumented or identifying provider error codes",
    async (code) => {
      const h = harness();
      h.fetch
        .mockReset()
        .mockResolvedValue(response({ error: secret, error_code: code }));
      const report = await run(env, h.load, h.emit);
      expect(report.senders.errorCode).toBeNull();
      expect(report.estimate.errorCode).toBeNull();
    },
  );

  it("does not access the provider unless the DB session is read-only and configured", async () => {
    const h = harness();
    h.prisma.$queryRaw.mockResolvedValue([{ mode: "off" }]);
    await expect(run(env, h.load, h.emit)).rejects.toThrow(
      "DATABASE_NOT_READ_ONLY",
    );
    expect(h.fetch).not.toHaveBeenCalled();
    h.prisma.$queryRaw.mockResolvedValue([{ mode: "on" }]);
    h.prisma.systemSetting.findMany.mockResolvedValue([]);
    await expect(run(env, h.load, h.emit)).rejects.toThrow("CONFIG_MISSING");
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it.each([
    { id: "sent-message", cost: "4.50", cnt: 1 },
    { cost: phone.slice(1), cnt: 1 },
    { cost: "4.50", cnt: phone.slice(1) },
    { cost: null, cnt: 1 },
    { cost: false, cnt: 1 },
    { cost: "", cnt: 1 },
    { error: secret, error_code: phone.slice(1) },
  ])(
    "rejects sent-message IDs and potential PII masquerading as numbers",
    async (data) => {
      const h = harness();
      h.fetch
        .mockReset()
        .mockResolvedValueOnce(response([]))
        .mockResolvedValueOnce(response(data));
      const report = await run(env, h.load, h.emit);
      expect(report.estimate.ok).toBe(false);
      expect(JSON.stringify(h.emit.mock.calls)).not.toContain(phone.slice(1));
    },
  );
});

describe("no-send workflow source contract", () => {
  const workflow = readFileSync(
    resolve(root, ".github/workflows/inspect-smsc-no-send.yml"),
    "utf8",
  );
  const script = readFileSync(
    resolve(root, "scripts/inspect-smsc-no-send.js"),
    "utf8",
  );
  const parsed = parse(workflow);
  it("validates/masks runtime event phone before use and never places it in step env", () => {
    const step = parsed.jobs.inspect.steps[1];
    expect(Object.keys(step.env).some((key) => key.includes("PHONE"))).toBe(
      false,
    );
    expect(workflow).not.toContain("${{ inputs.phone }}");
    expect(workflow).toContain("$GITHUB_EVENT_PATH");
    expect(step.run.indexOf("select(type ==")).toBeLessThan(
      step.run.indexOf("::add-mask::"),
    );
    expect(step.run.indexOf("::add-mask::")).toBeLessThan(
      step.run.indexOf("'$PHONE_INPUT'"),
    );
    expect(Object.keys(parsed.on.workflow_dispatch.inputs)).toEqual(["phone"]);
  });
  it("keeps source/SSH/production guards and has no send/write operations", () => {
    expect(parsed.jobs.inspect.environment).toBe("production");
    expect(parsed.concurrency.group).toBe("production-deploy");
    for (const required of [
      "refs/heads/master",
      "StrictHostKeyChecking=yes",
      "$EXPECTED_SSH_FINGERPRINT",
      'test "$actual_script_sha" = "$expected_script_sha"',
      'test "$container_sha" = "$production_sha"',
      "flock -s -n 9",
      "trap cleanup EXIT HUP INT TERM",
    ])
      expect(workflow).toContain(required);
    for (const forbidden of [
      "git fetch",
      "docker cp",
      "appleboy/",
      "inputs.apply",
    ])
      expect(workflow).not.toContain(forbidden);
    expect(script).not.toMatch(
      /prisma(?:\.\w+)?\.(create|update|upsert|delete)\(/,
    );
    expect(script).not.toMatch(/\.(send|sendTest)\(/);
    expect(script).not.toContain("$executeRaw");
    expect(script).not.toMatch(/cost\s*=\s*["'](?:0|2|3)["']/);
    expect(script).not.toMatch(/process\.env\.(COST|APPLY|BASE_URL)/);
  });
});
