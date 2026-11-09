"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  run,
  inputs,
  signJwt,
  syncReceipt,
  sourceCounts,
  detailReceipt,
  reportFailure,
  TARGET_AGENCY_ID,
} = require("./refresh-agency-profiles.cjs");
const sha = "a".repeat(40);
const env = {
  EXPECTED_DEPLOYED_SHA: sha,
  GIT_SHA: sha,
  JWT_SECRET: "local-test-secret",
};
const result = (global = false) => ({
  status: "SUCCEEDED",
  errorCode: null,
  stats: {
    total: 1,
    remainingAtStart: 1,
    attempted: 1,
    processed: 1,
    linked: 1,
    conflicts: 0,
    notFound: 0,
    invalidInn: 0,
    cycleInvalidInn: 0,
    errors: 0,
    lookups: 1,
    deduplicatedLookups: 0,
    pagesRead: 1,
    changed: 1,
    unchanged: 0,
    written: global ? 1 : 0,
    deferred: 0,
    durationMs: 5,
    scopeComplete: true,
    cycleComplete: global,
  },
});
function fixture(extraEnv = {}) {
  const calls = [],
    emitted = [];
  let disconnected = 0;
  const prisma = {
    broker: {
      findFirst: async () => ({ id: "existing-admin", authVersion: 4 }),
    },
    agency: {
      findMany: async () => [
        {
          inn: "9702028892",
          amoCompanySync: {
            lastSuccessAt: new Date(),
            errorCode: null,
            profile: { _sourceInn: "9702028892" },
            linkStatus: "LINKED",
          },
        },
      ],
    },
    $disconnect: async () => {
      disconnected++;
    },
  };
  const fetch = async (url, options) => {
    const route = new URL(url).pathname;
    calls.push({
      route,
      method: options.method,
      body: options.body ? JSON.parse(options.body) : null,
      authorization: options.headers.authorization,
      signal: options.signal,
    });
    let body;
    if (route === "/api/health") body = { deployedSha: sha };
    else if (route === "/api/health/ready")
      body = { status: "ok", checks: { postgresql: "ok", redis: "ok" } };
    else if (route === "/api/amocrm/agency-profiles/sync") body = result();
    else if (route === "/api/amocrm/agency-profiles/sync-all")
      body = result(true);
    else if (route === `/api/loyalty-base/ours/agencies/${TARGET_AGENCY_ID}`)
      body = {
        item: {
          id: TARGET_AGENCY_ID,
          attributes: {
            brokerCount: 12,
            activeBrokers: 4,
            activeBrokerWindowDays: 90,
            lastContractDate: "2025-11-22",
            legalName: "DO_NOT_OUTPUT",
            lastContractNumber: "DO_NOT_OUTPUT",
          },
          sourceFreshness: { status: "CURRENT" },
          fieldAvailability: { website: { status: "AVAILABLE" } },
          phone: "DO_NOT_OUTPUT",
        },
      };
    else throw Error("Unexpected request");
    return { ok: true, text: async () => JSON.stringify(body) };
  };
  return {
    deps: {
      env: { ...env, ...extraEnv },
      prisma,
      fetch,
      emit: (text) => emitted.push(text),
    },
    calls,
    emitted,
    disconnected: () => disconnected,
  };
}
test("default is targeted dry run and apply is separately confirmed", () => {
  assert.equal(inputs(env).mode, "dry-run");
  for (const overrides of [
    { MODE: "apply" },
    { MODE: "wrong" },
    { EXPECTED_DEPLOYED_SHA: "short" },
    { GIT_SHA: "b".repeat(40) },
    { JWT_SECRET: "" },
  ])
    assert.throws(() => inputs({ ...env, ...overrides }));
  assert.equal(
    inputs({ ...env, MODE: "apply", CONFIRM_APPLY: "true" }).mode,
    "apply",
  );
});
test("JWT is versioned, short-lived and excludes phone and secrets from payload", () => {
  const token = signJwt(
    { id: "admin", authVersion: 4 },
    "secret",
    1700000000000,
  );
  const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url"));
  assert.deepEqual(payload, {
    sub: "admin",
    role: "ADMIN",
    type: "access",
    authVersion: 4,
    iat: 1700000000,
    exp: 1700001800,
  });
});
test("dry run checks health/readiness before authentication and never calls global apply", async () => {
  const f = fixture();
  const receipt = await run(f.deps);
  assert.deepEqual(
    f.calls.map((c) => c.route),
    [
      "/api/health",
      "/api/health/ready",
      "/api/amocrm/agency-profiles/sync",
      `/api/loyalty-base/ours/agencies/${TARGET_AGENCY_ID}`,
      "/api/health",
    ],
  );
  assert.deepEqual(f.calls[2].body, {
    mode: "dry-run",
    agencyId: TARGET_AGENCY_ID,
  });
  assert.equal(f.calls[0].authorization, undefined);
  assert.ok(f.calls[2].authorization.startsWith("Bearer "));
  assert.ok(f.calls.every((c) => c.signal instanceof AbortSignal));
  assert.equal(receipt.mode, "dry-run");
  assert.equal(f.disconnected(), 1);
  assert.ok(!f.emitted.join("").includes("DO_NOT_OUTPUT"));
});
test("confirmed apply calls normal HTTP after target dry run and verifies all source snapshots", async () => {
  const f = fixture({ MODE: "apply", CONFIRM_APPLY: "true" });
  const receipt = await run(f.deps);
  assert.deepEqual(f.calls[3].body, { mode: "apply" });
  assert.equal(f.calls[3].route, "/api/amocrm/agency-profiles/sync-all");
  assert.equal(receipt.sources.current, 1);
  assert.equal(f.disconnected(), 1);
});
test("health mismatch stops before Prisma reads or sync", async () => {
  const f = fixture();
  f.deps.fetch = async () => ({
    ok: true,
    text: async () => JSON.stringify({ deployedSha: "b".repeat(40) }),
  });
  f.deps.prisma.broker.findFirst = () => {
    throw Error("must not read");
  };
  await assert.rejects(run(f.deps), { safeCode: "HEALTH_MISMATCH" });
});
test("readiness rejects failed dependencies before sync", async () => {
  const f = fixture();
  const original = f.deps.fetch;
  f.deps.fetch = async (url, options) =>
    url.endsWith("/ready")
      ? {
          ok: true,
          text: async () =>
            JSON.stringify({
              status: "error",
              checks: { postgresql: "ok", redis: "error" },
            }),
        }
      : original(url, options);
  await assert.rejects(run(f.deps), { safeCode: "NOT_READY" });
  assert.equal(f.calls.length, 1);
});
test("no active eligible admin causes failure without rights changes or sync calls", async () => {
  const f = fixture();
  f.deps.prisma.broker.findFirst = async () => null;
  await assert.rejects(run(f.deps), { safeCode: "NO_ADMIN" });
  assert.equal(f.calls.length, 2);
  assert.equal(f.disconnected(), 1);
});
test("failed, skipped, partial, malformed and writing dry runs fail closed", () => {
  for (const mutate of [
    (r) => (r.status = "FAILED"),
    (r) => (r.status = "SKIPPED"),
    (r) => (r.stats.scopeComplete = false),
    (r) => (r.stats.deferred = 1),
    (r) => (r.stats.errors = 1),
    (r) => (r.stats.cycleInvalidInn = 1),
    (r) => (r.stats.processed = 0),
    (r) => (r.stats.written = 1),
    (r) => (r.stats.total = "1"),
  ]) {
    const r = result();
    mutate(r);
    assert.throws(() => syncReceipt(r, "dry-run", false));
  }
  assert.throws(() => syncReceipt(result(), "apply", true));
});
test("all-source check distinguishes missing errors identity stale and conflict", () => {
  const snapshot = {
    lastSuccessAt: new Date(),
    profile: { _sourceInn: "9702028892" },
    errorCode: null,
    linkStatus: "LINKED",
  };
  const rows = [
    null,
    { ...snapshot, errorCode: "AUTH" },
    { ...snapshot, profile: { _sourceInn: "wrong" } },
    { ...snapshot, lastSuccessAt: "2020-01-01" },
    { ...snapshot, linkStatus: "CONFLICT" },
  ].map((amoCompanySync) => ({ inn: "9702028892", amoCompanySync }));
  assert.deepEqual(sourceCounts(rows), {
    total: 5,
    validInn: 5,
    missingConfirmedInn: 0,
    invalidNotClassified: 0,
    current: 1,
    notFound: 0,
    missing: 1,
    errors: 1,
    identityMismatch: 1,
    stale: 1,
    conflicts: 1,
  });
});
test("incomplete all-source coverage fails after apply without printing raw response", async () => {
  const f = fixture({ MODE: "apply", CONFIRM_APPLY: "true" });
  f.deps.prisma.agency.findMany = async () => [
    { inn: "SECRET", amoCompanySync: null },
  ];
  await assert.rejects(run(f.deps), { safeCode: "SOURCE_INCOMPLETE" });
  assert.equal(f.emitted.length, 0);
  assert.equal(f.disconnected(), 1);
});
test("detail receipt has a narrow non-PII allowlist", () => {
  const detail = detailReceipt({
    item: {
      id: TARGET_AGENCY_ID,
      attributes: {
        brokerCount: 0,
        phone: "SECRET",
        lastContractDate: "2026-11-09",
        lastContractNumber: "SECRET",
      },
      sourceFreshness: { status: "ERROR", errorCode: "SECRET" },
    },
  });
  assert.equal(detail.brokerCount, 0);
  assert.ok(!JSON.stringify(detail).includes("SECRET"));
});
test("safe failure handler excludes message stack and untrusted codes", () => {
  const output = [];
  const original = console.error;
  console.error = (s) => output.push(s);
  try {
    reportFailure({ message: "SECRET", stack: "SECRET", safeCode: "SECRET" });
  } finally {
    console.error = original;
  }
  assert.deepEqual(JSON.parse(output[0]), {
    agencyProfileRefresh: { status: "FAILED", code: "UNEXPECTED" },
  });
});
test("workflow retains exact master, production concurrency, fingerprint and streamed entrypoint gates", () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, "../.github/workflows/refresh-agency-profiles.yml"),
    "utf8",
  );
  for (const gate of [
    "group: production-deploy",
    "cancel-in-progress: false",
    "environment: production",
    "timeout-minutes: 35",
    "refs/heads/master",
    'test "$SOURCE_SHA" = "$EXPECTED_SHA"',
    'test "$master_sha" = "$SOURCE_SHA"',
    "StrictHostKeyChecking=yes",
    "DEPLOY_HOST_FINGERPRINT",
    "flock -n 9",
    'EXPECTED_DEPLOYED_SHA="$expected_sha"',
    "run().catch(error => { reportFailure(error); process.exitCode = 1; });",
  ])
    assert.ok(workflow.includes(gate), gate);
  assert.ok(
    !/git (fetch|pull|reset|checkout)|docker compose (up|restart)|JWT_SECRET:/.test(
      workflow,
    ),
  );
  assert.ok(
    !/AppModule|createApplicationContext|prisma\.[\w.]+\.(create|update|delete)/.test(
      fs.readFileSync(
        path.join(__dirname, "refresh-agency-profiles.cjs"),
        "utf8",
      ),
    ),
  );
});

test("known missing INN and checked not-found companies are explicit completed data gaps", () => {
  const current = {
    lastSuccessAt: new Date(),
    profile: { _sourceInn: "9702028892" },
    errorCode: null,
    linkStatus: "LINKED",
  };
  const rows = [
    { inn: "", amoCompanySync: { errorCode: "INVALID_INN" } },
    { inn: "pending", amoCompanySync: null },
    { inn: "9702028892", amoCompanySync: current },
    {
      inn: "7701234567",
      amoCompanySync: {
        errorCode: "COMPANY_NOT_FOUND",
        lastAttemptAt: new Date(),
      },
    },
  ];
  assert.deepEqual(sourceCounts(rows), {
    total: 4,
    validInn: 2,
    missingConfirmedInn: 2,
    invalidNotClassified: 1,
    current: 1,
    notFound: 1,
    missing: 0,
    errors: 0,
    identityMismatch: 0,
    stale: 0,
    conflicts: 0,
  });
  const global = result(true);
  global.stats.invalidInn = 1315;
  global.stats.cycleInvalidInn = 1315;
  assert.equal(syncReceipt(global, "apply", true).counts.invalidInn, 1315);
});

test("streamed stdin entrypoint executes the reviewed runner exactly once", async () => {
  const vm = require("node:vm");
  const f = fixture();
  const context = {
    require,
    module: { exports: {} },
    Buffer,
    process: { env },
    AbortSignal,
    console,
    deps: f.deps,
  };
  vm.runInNewContext(
    fs.readFileSync(
      path.join(__dirname, "refresh-agency-profiles.cjs"),
      "utf8",
    ) + "\nthis.finished = run(deps);",
    context,
  );
  await context.finished;
  assert.equal(f.emitted.length, 1);
  assert.equal(
    f.calls.filter((call) => call.route.endsWith("/sync")).length,
    1,
  );
});
test("old not-found checks fail source completeness", () => {
  const counts = sourceCounts([
    {
      inn: "9702028892",
      amoCompanySync: {
        errorCode: "COMPANY_NOT_FOUND",
        lastAttemptAt: "2020-01-01",
      },
    },
  ]);
  assert.equal(counts.notFound, 0);
  assert.equal(counts.stale, 1);
});

test("complete apply accepts classified missing INN with resumed cumulative cycle counts", async () => {
  const f = fixture({ MODE: "apply", CONFIRM_APPLY: "true" });
  const original = f.deps.fetch;
  f.deps.fetch = async (url, options) => {
    if (!url.endsWith("/sync-all")) return original(url, options);
    const response = result(true);
    Object.assign(response.stats, {
      total: 1379,
      remainingAtStart: 1378,
      attempted: 1378,
      processed: 1378,
      linked: 64,
      invalidInn: 1314,
      cycleInvalidInn: 1315,
      written: 1378,
      resumed: true,
    });
    return { ok: true, text: async () => JSON.stringify(response) };
  };
  f.deps.prisma.agency.findMany = async () => [
    ...Array.from({ length: 64 }, () => ({
      inn: "9702028892",
      amoCompanySync: {
        lastSuccessAt: new Date(),
        errorCode: null,
        profile: { _sourceInn: "9702028892" },
        linkStatus: "LINKED",
      },
    })),
    ...Array.from({ length: 1315 }, () => ({
      inn: "",
      amoCompanySync: { errorCode: "INVALID_INN" },
    })),
  ];
  const receipt = await run(f.deps);
  assert.equal(receipt.sources.validInn, 64);
  assert.equal(receipt.sources.missingConfirmedInn, 1315);
  assert.equal(receipt.sources.total, 1379);
});
