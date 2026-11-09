"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  http,
  responseLimit,
  requireFreshBackup,
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
  REFRESH_SOURCE_SHA: "c".repeat(40),
  REFRESH_BACKUP_DEPLOYED_SHA: sha,
  REFRESH_BACKUP_COMPLETED_AT: new Date().toISOString(),
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
    return new Response(JSON.stringify(body));
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
  f.deps.fetch = async () =>
    new Response(JSON.stringify({ deployedSha: "b".repeat(40) }));
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
      ? new Response(
          JSON.stringify({
            status: "error",
            checks: { postgresql: "ok", redis: "error" },
          }),
        )
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
    'git merge-base --is-ancestor "$EXPECTED_SHA" "$SOURCE_SHA"',
    'git diff --exit-code "$EXPECTED_SHA" "$SOURCE_SHA" -- apps/api packages/database packages/integrations packages/shared',
    "Build and test release commit",
    'head_sha="$SOURCE_SHA"',
    'backup-production-loyalty-predeploy.yml/runs -f head_sha="$EXPECTED_SHA"',
    "21600",
    'test "$master_sha" = "$SOURCE_SHA"',
    "StrictHostKeyChecking=yes",
    "DEPLOY_HOST_FINGERPRINT",
    "flock -n 9",
    'EXPECTED_DEPLOYED_SHA="$expected_sha"',
    'st-michael-api sh -c "$file_runner"',
    "$REFRESH_EXPECTED_SCRIPT_HASH",
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
    Uint8Array,
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
    return new Response(JSON.stringify(response));
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

test("large valid target detail is streamed and only its safe receipt is emitted", async () => {
  const f = fixture();
  const original = f.deps.fetch;
  f.deps.fetch = async (url, options) => {
    if (!url.endsWith(`/agencies/${TARGET_AGENCY_ID}`))
      return original(url, options);
    return new Response(
      JSON.stringify({
        item: {
          id: TARGET_AGENCY_ID,
          attributes: {
            brokerCount: 368,
            activeBrokers: 20,
            activeBrokerWindowDays: 90,
          },
          sourceFreshness: { status: "CURRENT" },
          privateHistory:
            "PRIVATE_CONTACT_DO_NOT_PRINT" + "x".repeat(16 * 1024 * 1024),
        },
      }),
    );
  };
  const receipt = await run(f.deps);
  assert.equal(receipt.target.brokerCount, 368);
  assert.equal(receipt.target.activeBrokers, 20);
  assert.ok(!f.emitted.join("").includes("PRIVATE_CONTACT_DO_NOT_PRINT"));
  assert.ok(f.emitted.join("").length < 4096);
});

test("only the exact target GET has a 32MiB response budget", () => {
  const target = `/loyalty-base/ours/agencies/${TARGET_AGENCY_ID}`;
  assert.equal(responseLimit("GET", target), 32 * 1024 * 1024);
  for (const [method, route] of [
    ["POST", target],
    ["GET", `${target}?extra=1`],
    ["GET", `${target}/`],
    ["GET", "/loyalty-base/ours/agencies/other"],
    ["POST", "/amocrm/agency-profiles/sync-all"],
    ["GET", "/health"],
  ])
    assert.equal(responseLimit(method, route), 1024 * 1024);
});

for (const [method, route, limit] of [
  ["POST", "/amocrm/agency-profiles/sync-all", 1024 * 1024],
  ["GET", `/loyalty-base/ours/agencies/${TARGET_AGENCY_ID}`, 32 * 1024 * 1024],
]) {
  test(`oversized ${method} response stops at its byte budget and cancels the body`, async () => {
    let reads = 0,
      canceled = 0,
      released = 0;
    const chunk = new Uint8Array(65536);
    const response = {
      ok: true,
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: async () => {
            reads++;
            return { done: false, value: chunk };
          },
          cancel: async () => {
            canceled++;
          },
          releaseLock: () => {
            released++;
          },
        }),
      },
      text: () => {
        throw Error("UNBOUNDED_TEXT_FORBIDDEN");
      },
    };
    await assert.rejects(
      http(async () => response, method, route),
      { safeCode: "INVALID_RESPONSE" },
    );
    assert.equal(reads, limit / chunk.byteLength + 1);
    assert.ok(canceled >= 1);
    assert.equal(released, 1);
  });
}

test("declared oversize cancels before acquiring a reader and bounds count bytes rather than characters", async () => {
  let canceled = 0,
    readers = 0;
  const response = {
    ok: true,
    headers: new Headers({ "content-length": String(1024 * 1024 + 1) }),
    body: {
      cancel: async () => {
        canceled++;
      },
      getReader: () => {
        readers++;
        throw Error("must not read");
      },
    },
  };
  await assert.rejects(
    http(async () => response, "GET", "/health"),
    { safeCode: "INVALID_RESPONSE" },
  );
  assert.equal(canceled, 1);
  assert.equal(readers, 0);
  await assert.rejects(
    http(
      async () => new Response(JSON.stringify({ private: "я".repeat(600000) })),
      "GET",
      "/health",
    ),
    { safeCode: "INVALID_RESPONSE" },
  );
});

test("apply requires a fresh backup for the deployed SHA and rechecks it after the dry run", async () => {
  for (const patch of [
    { REFRESH_BACKUP_DEPLOYED_SHA: "b".repeat(40) },
    { REFRESH_BACKUP_COMPLETED_AT: "" },
    {
      REFRESH_BACKUP_COMPLETED_AT: new Date(
        Date.now() - 6 * 3600000,
      ).toISOString(),
    },
    {
      REFRESH_BACKUP_COMPLETED_AT: new Date(Date.now() + 3600000).toISOString(),
    },
  ])
    assert.throws(() => requireFreshBackup({ ...env, ...patch }), {
      safeCode: "BACKUP_NOT_CURRENT",
    });
  const f = fixture({ MODE: "apply", CONFIRM_APPLY: "true" });
  const original = f.deps.fetch;
  f.deps.fetch = async (url, options) => {
    const response = await original(url, options);
    if (url.endsWith("/sync"))
      f.deps.env.REFRESH_BACKUP_COMPLETED_AT = "2020-01-01";
    return response;
  };
  await assert.rejects(run(f.deps), { safeCode: "BACKUP_NOT_CURRENT" });
  assert.ok(!f.calls.some((call) => call.route.endsWith("/sync-all")));
});

test("API compatibility gate permits ops-only descendants and rejects changed API or non-ancestor commits", () => {
  const cp = require("node:child_process"),
    os = require("node:os");
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "agency-refresh-api-compat-"),
  );
  const git = (...args) =>
    cp
      .execFileSync("git", args, {
        cwd: directory,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      })
      .trim();
  try {
    git("init");
    git("config", "user.name", "Local QA");
    git("config", "user.email", "qa@example.test");
    fs.mkdirSync(path.join(directory, "apps/api"), { recursive: true });
    fs.writeFileSync(path.join(directory, "apps/api/contract.txt"), "deployed");
    git("add", ".");
    git("commit", "-m", "deployed");
    const deployed = git("rev-parse", "HEAD");
    fs.mkdirSync(path.join(directory, "scripts"));
    fs.writeFileSync(path.join(directory, "scripts/ops.txt"), "ops-only");
    git("add", ".");
    git("commit", "-m", "ops");
    const source = git("rev-parse", "HEAD");
    git("merge-base", "--is-ancestor", deployed, source);
    git(
      "diff",
      "--exit-code",
      deployed,
      source,
      "--",
      "apps/api",
      "packages/database",
      "packages/integrations",
      "packages/shared",
    );
    fs.appendFileSync(path.join(directory, "apps/api/contract.txt"), "changed");
    git("add", ".");
    git("commit", "-m", "changed api");
    assert.throws(() =>
      git(
        "diff",
        "--exit-code",
        deployed,
        "HEAD",
        "--",
        "apps/api",
        "packages/database",
        "packages/integrations",
        "packages/shared",
      ),
    );
    assert.throws(() => git("merge-base", "--is-ancestor", "HEAD", deployed));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("runner never falls back to unbounded text or prints private body fields", () => {
  const code = fs.readFileSync(
    path.join(__dirname, "refresh-agency-profiles.cjs"),
    "utf8",
  );
  assert.ok(!/response\.(text|json)\(/.test(code));
  assert.ok(code.includes("reader.cancel"));
  assert.ok(code.includes("reader.releaseLock"));
  assert.ok(code.includes("120000"));
});

test("real node file entrypoint runs the dry refresh once with private mocked dependencies", () => {
  const cp = require("node:child_process"),
    os = require("node:os");
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "agency-refresh-file-"),
  );
  try {
    const runner = path.join(directory, ".agency-refresh.fixture");
    fs.copyFileSync(
      path.join(__dirname, "refresh-agency-profiles.cjs"),
      runner,
    );
    const database = path.join(directory, "node_modules/@st-michael/database");
    fs.mkdirSync(database, { recursive: true });
    fs.writeFileSync(
      path.join(database, "index.js"),
      'exports.PrismaClient=class {broker={findFirst:async()=>({id:"private-existing-admin",authVersion:2})}; async $disconnect(){}};',
    );
    const preload = path.join(directory, "fixture-preload.cjs");
    fs.writeFileSync(
      preload,
      `
      if (!process.argv[1]) throw Error("FILE_ENTRY_REQUIRED");
      let posts = 0;
      global.fetch = async (url, options) => {
        let body;
        if (url.endsWith("/health")) body = { deployedSha: ${JSON.stringify(sha)} };
        else if (url.endsWith("/health/ready")) body = { status:"ok",checks:{postgresql:"ok",redis:"ok"} };
        else if (url.endsWith("/sync")) { posts++;body=${JSON.stringify(result())}; }
        else if (url.endsWith(${JSON.stringify(TARGET_AGENCY_ID)})) body = {item:{id:${JSON.stringify(TARGET_AGENCY_ID)},attributes:{brokerCount:368,activeBrokers:20,activeBrokerWindowDays:90},sourceFreshness:{status:"CURRENT"},phone:"PRIVATE_DO_NOT_PRINT",history:"x".repeat(16*1024*1024)}};
        else throw Error("UNEXPECTED_LOCAL_ROUTE");
        return new Response(JSON.stringify(body));
      };
      process.on("exit",()=>{if(posts!==1)process.exitCode=9;});
    `,
    );
    const child = cp.spawnSync(
      process.execPath,
      ["--require", preload, runner],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          ...env,
          MODE: "dry-run",
          NODE_PATH: path.join(directory, "node_modules"),
        },
      },
    );
    assert.equal(child.status, 0, child.stderr);
    const lines = child.stdout.trim().split("\n");
    assert.equal(lines.length, 1);
    const receipt = JSON.parse(lines[0]).agencyProfileRefresh;
    assert.equal(receipt.target.brokerCount, 368);
    assert.equal(receipt.target.activeBrokers, 20);
    assert.ok(!child.stdout.includes("PRIVATE_DO_NOT_PRINT"));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("container file runner verifies exact bytes, runs normal main once, and cleans only its temp file", () => {
  const cp = require("node:child_process"),
    os = require("node:os"),
    crypto = require("node:crypto");
  const workflow = fs.readFileSync(
    path.join(__dirname, "../.github/workflows/refresh-agency-profiles.yml"),
    "utf8",
  );
  const wrapper =
    /file_runner=\$\(cat <<'RUN_REVIEWED_FILE'\r?\n([\s\S]*?)\r?\n\s*RUN_REVIEWED_FILE/.exec(
      workflow,
    )?.[1];
  assert.ok(wrapper);
  assert.ok(!workflow.includes("Module._compile"));
  assert.ok(!workflow.includes("runner._compile"));
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "agency-refresh-owned-file-"),
  );
  const scriptsDirectory = path.join(directory, "scripts");
  fs.mkdirSync(scriptsDirectory);
  const unrelated = path.join(scriptsDirectory, "untouched.txt");
  fs.writeFileSync(unrelated, "keep");
  const shell =
    process.platform === "win32"
      ? "C:/Program Files/Git/bin/bash.exe"
      : "/bin/sh";
  const script = wrapper.replaceAll(
    "/app/scripts/",
    scriptsDirectory.replaceAll("\\", "/") + "/",
  );
  const source =
    'if(require.main!==module)process.exit(17);console.log("SAFE_ONCE");';
  const expectedHash = crypto.createHash("sha256").update(source).digest("hex");
  const invoke = (digest, input = source) =>
    cp.spawnSync(shell, ["-c", script], {
      input,
      encoding: "utf8",
      env: { ...process.env, REFRESH_EXPECTED_SCRIPT_HASH: digest },
    });
  try {
    const valid = invoke(expectedHash);
    assert.equal(valid.status, 0, valid.stderr);
    assert.equal(valid.stdout.trim(), "SAFE_ONCE");
    const tampered = invoke(expectedHash, source + "// changed");
    assert.equal(tampered.status, 1);
    assert.equal(tampered.stdout, "");
    assert.ok(tampered.stderr.includes("SOURCE_HASH_MISMATCH"));
    const oversizedSource = " ".repeat(1048577);
    const oversized = invoke(
      crypto.createHash("sha256").update(oversizedSource).digest("hex"),
      oversizedSource,
    );
    assert.equal(oversized.status, 1);
    assert.equal(oversized.stdout, "");
    assert.ok(oversized.stderr.includes("SOURCE_SIZE_INVALID"));
    const failingSource = "process.exit(7);";
    const failed = invoke(
      crypto.createHash("sha256").update(failingSource).digest("hex"),
      failingSource,
    );
    assert.equal(failed.status, 7);
    assert.deepEqual(fs.readdirSync(scriptsDirectory), ["untouched.txt"]);
    assert.equal(fs.readFileSync(unrelated, "utf8"), "keep");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
