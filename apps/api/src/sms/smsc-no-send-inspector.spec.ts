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
function harness(sender = "BusinessSender", approved = ["BusinessSender"]) {
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
    .mockImplementation(async (url) =>
      response(
        url.endsWith("senders.php")
          ? approved.map((name, index) => ({ sender: name, id: index + 1 }))
          : { cost: "4.50", cnt: 1 },
      ),
    );
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

  it("uses bounded fixed HTTPS POSTs, immutable get=1/cost=1 and no mutations", async () => {
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
      providerRequests: 7,
      priceEstimateOnly: true,
      brandSelection: "not_approved",
      approvedBrand: null,
      configuredSenderStatus: "skipped_not_approved_brand",
      additionalApprovedSendersEstimated: 1,
      additionalSenderEstimatesTechnicalOnly: true,
      additionalSenderSendingAuthorized: false,
      senderConfigurationChanged: false,
      senders: {
        ok: true,
        approvedSenderCount: 1,
        configuredSenderListed: true,
      },
      estimate: { ok: true, cost: 4.5, parts: 1 },
    });
    expect(h.fetch).toHaveBeenCalledTimes(7);
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
    expect(estimateParams.get("sender")).toBeNull();
    for (const [url, options] of h.fetch.mock.calls) {
      expect(options.method).toBe("POST");
      expect(options.redirect).toBe("error");
      expect(options.signal).toBeInstanceOf(AbortSignal);
      if (url.endsWith("send.php")) {
        const params = new URLSearchParams(options.body);
        expect(params.getAll("cost")).toEqual(["1"]);
        expect(params.get("phones")).toBe(phone.slice(1));
      }
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
      .mockResolvedValue(
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
    expect(h.fetch).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(h.emit.mock.calls)).not.toContain(phone);
    expect(JSON.stringify(h.emit.mock.calls)).not.toContain(secret);
  });

  it("does not retry transport failures or follow redirects", async () => {
    const h = harness();
    h.fetch.mockReset().mockRejectedValue(new Error(`${secret} ${phone}`));
    const report = await run(env, h.load, h.emit);
    expect(h.fetch).toHaveBeenCalledTimes(4);
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
        .mockResolvedValue(response(data));
      const report = await run(env, h.load, h.emit);
      expect(report.estimate.ok).toBe(false);
      expect(JSON.stringify(h.emit.mock.calls)).not.toContain(phone.slice(1));
    },
  );

  it("estimates all three fixed texts without sending, accepting env text or creating an OTP", async () => {
    const h = harness("", ["ST MICHAEL"]);
    const report = await run(
      { ...env, TEXT: secret, TEMPLATE: "login", CODE: "654321", COST: "3" },
      h.load,
      h.emit,
    );
    expect(report.providerRequests).toBe(7);
    expect(report.matrix).toEqual([
      {
        senderMode: "default",
        template: "test",
        ok: true,
        cost: 4.5,
        parts: 1,
      },
      {
        senderMode: "default",
        template: "password_reset",
        ok: true,
        cost: 4.5,
        parts: 1,
      },
      { senderMode: "default", template: "neutral", ok: true, cost: 4.5, parts: 1 },
      {
        senderMode: "approved_brand",
        template: "test",
        ok: true,
        cost: 4.5,
        parts: 1,
      },
      {
        senderMode: "approved_brand",
        template: "password_reset",
        ok: true,
        cost: 4.5,
        parts: 1,
      },
      { senderMode: "approved_brand", template: "neutral", ok: true, cost: 4.5, parts: 1 },
    ]);
    const bodies = h.fetch.mock.calls
      .slice(1)
      .map(([, options]) => new URLSearchParams(options.body));
    expect([...new Set(bodies.map((body) => body.get("mes")))]).toEqual([
      "Тест СМС: 000000. Код недействителен для входа и смены пароля.",
      "Код для смены пароля: 000000. Если это не вы — не вводите его.",
      "Тест.",
    ]);
    for (const body of bodies) {
      expect(body.getAll("cost")).toEqual(["1"]);
      expect(body.get("mes")!.length).toBeLessThanOrEqual(70);
      expect(body.get("mes")).not.toContain("654321");
    }
    expect(JSON.stringify(h.emit.mock.calls)).not.toContain("000000");
    expect(h.prisma).not.toHaveProperty("smsOtp");
  });

  it("prefers exact approved brand and deduplicates identical current/approved sender", async () => {
    const h = harness("ST MICHAEL", [
      "st michael",
      "ST MICHAEL",
      "OtherSender",
    ]);
    const report = await run(env, h.load, h.emit);
    expect(report).toMatchObject({
      brandSelection: "exact",
      approvedBrand: "ST MICHAEL",
      configuredSenderStatus: "checked",
      providerRequests: 10,
    });
    expect(report.matrix.map((row: any) => row.senderMode)).toEqual([
      "default",
      "default",
      "default",
      "configured_brand",
      "configured_brand",
      "configured_brand",
      "approved_sender_1",
      "approved_sender_1",
      "approved_sender_1",
    ]);
    const bodies = h.fetch.mock.calls
      .slice(1)
      .map(([, options]) => new URLSearchParams(options.body));
    expect(bodies.map((body) => body.get("sender"))).toEqual([
      null,
      null,
      null,
      "ST MICHAEL",
      "ST MICHAEL",
      "ST MICHAEL",
      "OtherSender",
      "OtherSender",
      "OtherSender",
    ]);
    expect(report.estimate).toEqual({ ok: true, cost: 4.5, parts: 1 });
    expect(JSON.stringify(h.emit.mock.calls)).not.toContain("OtherSender");
    expect(JSON.stringify(h.emit.mock.calls)).not.toContain("st michael");
  });

  it("estimates the exact user-approved ST MICHAEL without substituting the legacy dotted sender", async () => {
    const h = harness("St. Michael", ["St. Michael", "ST MICHAEL", "st michael"]);
    const report = await run(env, h.load, h.emit);
    expect(report).toMatchObject({
      brandSelection: "exact", approvedBrand: "ST MICHAEL",
      configuredSenderStatus: "skipped_not_approved_brand",
      senderConfigurationChanged: false, additionalSenderSendingAuthorized: false,
      smsSent: false, automaticRetry: false, providerRequests: 10,
    });
    const pairs = report.matrix.map((row: any, index: number) => ({
      mode: row.senderMode, params: new URLSearchParams(h.fetch.mock.calls[index + 1][1].body),
    }));
    expect(pairs.filter((row: any) => row.mode === "approved_brand").map((row: any) => row.params.get("sender")))
      .toEqual(["ST MICHAEL", "ST MICHAEL", "ST MICHAEL"]);
    expect(pairs.some((row: any) => row.mode === "configured_brand")).toBe(false);
    for (const row of pairs) expect(row.params.getAll("cost")).toEqual(["1"]);
    for (const value of ["St. Michael", "st michael", phone, secret])
      expect(JSON.stringify(h.emit.mock.calls)).not.toContain(value);
    expect(Object.keys(h.prisma.systemSetting)).toEqual(["findMany"]);
  });

  it.each(["St. Michael", "ST. MICHAEL", "St.Michael", "ST  MICHAEL", "ST-MICHAEL", " ST MICHAEL", "ST MICHAEL "])(
    "never normalizes punctuation/whitespace in %s into the agreed public sender",
    async (sender) => {
      const h = harness("", [sender]);
      const report = await run(env, h.load, h.emit);
      expect(report).toMatchObject({
        brandSelection: "not_approved", approvedBrand: null,
        configuredSenderStatus: "missing", smsSent: false,
        senderConfigurationChanged: false, additionalSenderSendingAuthorized: false,
      });
      expect(report.matrix.some((row: any) => ["approved_brand", "configured_brand"].includes(row.senderMode))).toBe(false);
      for (const [, options] of h.fetch.mock.calls.slice(1)) {
        const params = new URLSearchParams(options.body);
        expect(params.getAll("cost")).toEqual(["1"]);
        if (params.has("sender")) expect(params.get("sender")).toBe(sender);
      }
      expect(JSON.stringify(h.emit.mock.calls)).not.toContain(sender);
    },
  );

  it("uses only a single unambiguous approved case variant without disclosing its raw value", async () => {
    const h = harness("", ["St Michael", "SMSC", "ForeignBusiness"]);
    const report = await run(env, h.load, h.emit);
    expect(report).toMatchObject({
      brandSelection: "case_unique",
      approvedBrand: "ST MICHAEL",
      providerRequests: 10,
    });
    expect(
      new URLSearchParams(h.fetch.mock.calls[4][1].body).get("sender"),
    ).toBe("St Michael");
    for (const value of [
      "St Michael",
      "SMSC",
      "ForeignBusiness",
      "000000",
      secret,
      phone,
    ])
      expect(JSON.stringify(h.emit.mock.calls)).not.toContain(value);
  });

  it("bounds current-case plus exact approved brand and neutral text to ten requests and preserves current TEST compatibility", async () => {
    const h = harness("st michael", ["st michael", "ST MICHAEL"]);
    h.fetch.mockImplementation(async (url, options) =>
      response(
        url.endsWith("senders.php")
          ? [{ sender: "st michael" }, { sender: "ST MICHAEL" }]
          : {
              cost:
                new URLSearchParams(options.body).get("sender") ===
                "st michael"
                  ? "3.00"
                  : "4.50",
              cnt: 1,
            },
      ),
    );
    const report = await run(env, h.load, h.emit);
    expect(report.providerRequests).toBe(10);
    expect(h.fetch).toHaveBeenCalledTimes(10);
    expect(report.estimate).toEqual({ ok: true, cost: 3, parts: 1 });
    expect(report.matrix.map((row: any) => row.senderMode)).toEqual([
      "default",
      "default",
      "default",
      "configured_brand",
      "configured_brand",
      "configured_brand",
      "approved_brand",
      "approved_brand",
      "approved_brand",
    ]);
    for (const [, options] of h.fetch.mock.calls.slice(1))
      expect(new URLSearchParams(options.body).getAll("cost")).toEqual(["1"]);
    expect(JSON.stringify(h.emit.mock.calls)).not.toContain("st michael");
  });

  it.each([
    {
      sender: "st michael",
      approved: ["st michael", "St Michael"],
      selection: "ambiguous",
      requests: 4,
    },
    {
      sender: "SMSC",
      approved: [
        "SMSC",
        "St.Michael",
        " ST MICHAEL",
        "ST MICHAEL ",
        "ST MICHAEL Extra",
        phone,
      ],
      selection: "not_approved",
      requests: 10,
    },
    {
      sender: "ST MICHAEL",
      approved: ["OtherSender"],
      selection: "not_approved",
      requests: 7,
    },
  ])(
    "does not authorize nonbrand senders while allowing approved technical probes",
    async ({ sender, approved, selection, requests }) => {
      const h = harness(sender, approved);
      const report = await run(env, h.load, h.emit);
      expect(report).toMatchObject({
        brandSelection: selection,
        approvedBrand: null,
        providerRequests: requests,
        configuredSenderStatus: "skipped_not_approved_brand",
        additionalSenderSendingAuthorized: false,
        senderConfigurationChanged: false,
      });
      expect(
        report.matrix.slice(0, 3).every((row: any) => row.senderMode === "default"),
      ).toBe(true);
      for (const [, options] of h.fetch.mock.calls.slice(1)) {
        const params = new URLSearchParams(options.body);
        expect(params.getAll("cost")).toEqual(["1"]);
        if (params.has("sender")) expect(approved).toContain(params.get("sender"));
      }
      const output = JSON.stringify(h.emit.mock.calls);
      for (const value of approved) expect(output).not.toContain(value);
    },
  );

  it.each([null, {}, [{ sender: "ST MICHAEL" }, { sender: null }]])(
    "fails closed on malformed approved list but still estimates default only",
    async (list) => {
      const h = harness("ST MICHAEL");
      h.fetch.mockResolvedValueOnce(response(list));
      const report = await run(env, h.load, h.emit);
      expect(report).toMatchObject({
        brandSelection: "unavailable",
        approvedBrand: null,
        providerRequests: 4,
        senders: { ok: false },
      });
      for (const [, options] of h.fetch.mock.calls.slice(1))
        expect(new URLSearchParams(options.body).has("sender")).toBe(false);
    },
  );

  it("reserves the three-text budget for at most two approved names, keeps anonymous labels and never changes sender configuration", async () => {
    const names = ["SMSC", "ForeignBusiness", "GenericSender", "FourthSender", "SMSC"];
    const h = harness("", names);
    const report = await run(env, h.load, h.emit);
    expect(report).toMatchObject({ providerRequests: 10, additionalApprovedSendersEstimated: 2,
      additionalSenderEstimatesTechnicalOnly: true, additionalSenderSendingAuthorized: false,
      senderConfigurationChanged: false, configuredSenderStatus: "missing" });
    expect(report.matrix.map((row: any) => row.senderMode)).toEqual([
      "default", "default", "default", "approved_sender_1", "approved_sender_1", "approved_sender_1",
      "approved_sender_2", "approved_sender_2", "approved_sender_2",
    ]);
    const requested = h.fetch.mock.calls.slice(1).map(([, options]) => new URLSearchParams(options.body));
    expect([...new Set(requested.map(body => body.get("sender")))]).toEqual([null, ...names.slice(0, 2)]);
    for (const body of requested) expect(body.getAll("cost")).toEqual(["1"]);
    for (const value of [...names, phone, phone.slice(1), secret, "000000"])
      expect(JSON.stringify(h.emit.mock.calls)).not.toContain(value);
    expect(Object.keys(h.prisma.systemSetting)).toEqual(["findMany"]);
  });

  it("bounds all existing brand variants plus extra probes to eleven calls without retrying", async () => {
    const names = ["ST MICHAEL", "st michael", "SMSC", "ForeignBusiness", "ThirdSender"];
    const h = harness("st michael", names);
    const report = await run(env, h.load, h.emit);
    expect(report).toMatchObject({ providerRequests: 10, additionalApprovedSendersEstimated: 0,
      configuredSenderStatus: "checked", automaticRetry: false });
    expect(h.fetch).toHaveBeenCalledTimes(10);
    const pairs = h.fetch.mock.calls.slice(1).map(([, options]) => {
      const params = new URLSearchParams(options.body);
      expect(params.getAll("cost")).toEqual(["1"]);
      return `${params.get("sender")}:${params.get("mes")}`;
    });
    expect(new Set(pairs).size).toBe(pairs.length);
    expect(pairs.some(pair => pair.startsWith("ThirdSender:"))).toBe(false);
    expect(report.estimate).toEqual({ ok: true, cost: 4.5, parts: 1 });
  });

  it("deduplicates approved generic names by case and skips malformed identities without leaking them", async () => {
    const names = ["SMSC", "smsc", "SMSC", " OtherSender", "Line\nSender", "x".repeat(65), "SecondSender"];
    const h = harness("", names);
    const report = await run(env, h.load, h.emit);
    expect(report.additionalApprovedSendersEstimated).toBe(2);
    expect(report.providerRequests).toBe(10);
    const requested = [...new Set(h.fetch.mock.calls.slice(1).map(([, options]) =>
      new URLSearchParams(options.body).get("sender")))];
    expect(requested).toEqual([null, "SMSC", "SecondSender"]);
    for (const value of names) expect(JSON.stringify(h.emit.mock.calls)).not.toContain(value);
  });

  it("reports only observed sender-dependent estimate results, not delivery or an operator cause", async () => {
    const h = harness("", ["TechnicalSender"]);
    h.fetch.mockImplementation(async (url, options) => response(url.endsWith("senders.php")
      ? [{ sender: "TechnicalSender", operator: "private-undocumented-value" }]
      : new URLSearchParams(options.body).has("sender")
        ? { cost: "4.50", cnt: 1, operator: "private-undocumented-value" }
        : { error_code: 6, error: `${secret} ${phone}` }));
    const report = await run(env, h.load, h.emit);
    expect(report.estimateComparison).toEqual({ providerResultDiffersBySender: true,
      providerResultDiffersByTemplate: false,
      costOrPartsDifferBySender: false, conclusion: "sender_dependent_estimate_result_observed", deliveryVerified: false });
    expect(report.additionalSenderSendingAuthorized).toBe(false);
    for (const value of ["TechnicalSender", "private-undocumented-value", secret, phone])
      expect(JSON.stringify(h.emit.mock.calls)).not.toContain(value);
  });

  it("does not establish a sender cause when all variants reject identically or transport is unknown", async () => {
    const h = harness("", ["TechnicalSender"]);
    h.fetch.mockImplementation(async url => response(url.endsWith("senders.php")
      ? [{ sender: "TechnicalSender" }] : { error_code: 6, error: secret }));
    const rejected = await run(env, h.load, h.emit);
    expect(rejected.estimateComparison).toEqual({ providerResultDiffersBySender: false,
      providerResultDiffersByTemplate: false,
      costOrPartsDifferBySender: false, conclusion: "no_sender_dependency_established", deliveryVerified: false });
    h.fetch.mockImplementation(async (url, options) => {
      if (url.endsWith("senders.php")) return response([{ sender: "TechnicalSender" }]);
      if (new URLSearchParams(options.body).has("sender")) throw new Error(secret);
      return response({ cost: "4.50", cnt: 1 });
    });
    const unknown = await run(env, h.load, h.emit);
    expect(unknown.estimateComparison.conclusion).toBe("no_sender_dependency_established");
    expect(unknown.estimateComparison.deliveryVerified).toBe(false);
  });

  it("compares prices only within the same text template, and never turns price differences into delivery claims", async () => {
    const h = harness("", ["TechnicalSender"]);
    h.fetch.mockImplementation(async (url, options) => {
      if (url.endsWith("senders.php")) return response([{ sender: "TechnicalSender" }]);
      const params = new URLSearchParams(options.body);
      return response({ cost: params.get("mes")!.startsWith("Тест") ? "3.00" : "4.50", cnt: 1 });
    });
    const identical = await run(env, h.load, h.emit);
    expect(identical.estimateComparison.conclusion).toBe("no_sender_dependency_established");
    h.fetch.mockImplementation(async (url, options) => response(url.endsWith("senders.php")
      ? [{ sender: "TechnicalSender" }] : {
        cost: new URLSearchParams(options.body).has("sender") ? "3.00" : "4.50", cnt: 1,
      }));
    const differing = await run(env, h.load, h.emit);
    expect(differing.estimateComparison).toEqual({ providerResultDiffersBySender: false,
      providerResultDiffersByTemplate: false,
      costOrPartsDifferBySender: true, conclusion: "sender_dependent_estimate_price_observed", deliveryVerified: false });
  });

  it("observes template dependence when neutral is accepted and both code texts reject for the same sender", async () => {
    const h = harness("", ["TechnicalSender", "OtherSender"]);
    h.fetch.mockImplementation(async (url, options) => response(url.endsWith("senders.php")
      ? [{ sender: "TechnicalSender" }, { sender: "OtherSender" }]
      : new URLSearchParams(options.body).get("mes") === "Тест."
        ? { cost: "4.50", cnt: 1 }
        : { error_code: 6, error: `${secret} ${phone}` }));
    const report = await run(env, h.load, h.emit);
    expect(report.providerRequests).toBe(10);
    expect(report.estimate).toEqual({ ok: false, errorCode: 6, failureTag: "PROVIDER_REJECTED" });
    expect(report.matrix.slice(0, 3).map((row: any) => [row.template, row.ok])).toEqual([
      ["test", false], ["password_reset", false], ["neutral", true],
    ]);
    expect(report.estimateComparison).toEqual({ providerResultDiffersBySender: false,
      providerResultDiffersByTemplate: true, costOrPartsDifferBySender: false,
      conclusion: "template_dependent_estimate_result_observed", deliveryVerified: false });
    for (const [, options] of h.fetch.mock.calls.slice(1))
      expect(new URLSearchParams(options.body).getAll("cost")).toEqual(["1"]);
    for (const value of ["TechnicalSender", "OtherSender", secret, phone, "000000"])
      expect(JSON.stringify(h.emit.mock.calls)).not.toContain(value);
  });

  it("reports both observed dimensions without asserting an exact delivery cause", async () => {
    const h = harness("", ["TechnicalSender"]);
    h.fetch.mockImplementation(async (url, options) => {
      if (url.endsWith("senders.php")) return response([{ sender: "TechnicalSender" }]);
      const params = new URLSearchParams(options.body);
      return response(params.has("sender") && params.get("mes") === "Тест."
        ? { cost: "4.50", cnt: 1 } : { error_code: 6, error: secret });
    });
    const report = await run(env, h.load, h.emit);
    expect(report.estimateComparison).toEqual({ providerResultDiffersBySender: true,
      providerResultDiffersByTemplate: true, costOrPartsDifferBySender: false,
      conclusion: "sender_and_template_dependent_estimate_result_observed", deliveryVerified: false });
    expect(report.smsSent).toBe(false);
    expect(report.additionalSenderSendingAuthorized).toBe(false);
  });

  it("unknown template transport failures never establish template dependence", async () => {
    const h = harness("", []);
    h.fetch.mockImplementation(async (url, options) => {
      if (url.endsWith("senders.php")) return response([]);
      if (new URLSearchParams(options.body).get("mes") !== "Тест.") throw new Error(secret);
      return response({ cost: "4.50", cnt: 1 });
    });
    const report = await run(env, h.load, h.emit);
    expect(report.estimateComparison.providerResultDiffersByTemplate).toBe(false);
    expect(report.estimateComparison.conclusion).toBe("no_sender_dependency_established");
    expect(report.estimateComparison.deliveryVerified).toBe(false);
    expect(JSON.stringify(h.emit.mock.calls)).not.toContain(secret);
  });
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
    expect(script).toContain("const MAX_PROVIDER_REQUESTS = 11;");
    expect(script).toContain("if (providerRequests >= MAX_PROVIDER_REQUESTS)");
    expect(script).toContain('const BRAND_SENDER = "ST MICHAEL";');
    expect(script).not.toContain('const BRAND_SENDER = "St. Michael";');
  });
});
