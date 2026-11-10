"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  crypto = require("node:crypto");
const publisher = require("./publish-installment-calculator-20261110.cjs");
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
function fixture() {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "calculator-publication-")),
  );
  const bytes = Buffer.from(
    "<!doctype html><html><body>Reviewed calculator fixture</body></html>",
  );
  const source = path.join(root, "reviewed.html"),
    old = path.join(root, path.basename(publisher.OLD_URL));
  fs.writeFileSync(source, bytes);
  fs.writeFileSync(old, "<html>Original published calculator</html>");
  const env = {
    MODE: "plan",
    SOURCE_SHA: "a".repeat(40),
    EXPECTED_DEPLOYED_SHA: "b".repeat(40),
    GIT_SHA: "b".repeat(40),
    SOURCE_HTML: source,
    SOURCE_HTML_SHA256: hash(bytes),
    PRODUCTION_PG_SYSTEM_IDENTIFIER: "987654321",
    PRODUCTION_MIN_BROKER_ROWS: "1",
    CONFIRM_APPLY: "true",
    SOURCE_CI_ATTESTED: "true",
    VERIFIED_BACKUP_SHA256: "c".repeat(64),
    VERIFIED_BACKUP_AT: new Date().toISOString(),
    VERIFIED_BACKUP_DEPLOYED_SHA: "b".repeat(40),
  };
  let rows = Array.from({ length: 4 }, (_, i) => ({
    id: i ? "other-" + i : publisher.DOC_ID,
    name: i ? "Other document " + i : "Calculator",
    description: "Keep description",
    category: "cooperation",
    type: i ? "PDF" : "HTML",
    project: null,
    subcategory: null,
    fileUrl: i ? "/files/cooperation/other-" + i + ".pdf" : publisher.OLD_URL,
    fileSize: i ? 12 : fs.statSync(old).size,
    isPublic: true,
    sortOrder: i,
    createdAt: new Date("2026-09-01"),
    updatedAt: new Date("2026-09-01"),
  }));
  let audits = [],
    updates = [],
    commands = [],
    hook = null;
  const tx = {
    $executeRaw: async (sql) => {
      commands.push(sql.join("?"));
    },
    $queryRaw: async (sql) => {
      commands.push(sql.join("?"));
      return sql.join("").includes("pg_control_system")
        ? [{ name: "broker_platform", identifier: "987654321" }]
        : [{ id: publisher.DOC_ID }];
    },
    broker: { count: async () => 10 },
    document: {
      findMany: async () => structuredClone(rows),
      updateMany: async ({ where, data }) => {
        const row = rows.find((item) => item.id === where.id);
        if (
          !row ||
          row.fileUrl !== where.fileUrl ||
          +row.updatedAt !== +where.updatedAt
        )
          return { count: 0 };
        updates.push(data);
        Object.assign(row, data, { updatedAt: new Date() });
        return { count: 1 };
      },
    },
    auditLog: {
      findMany: async () => structuredClone(audits),
      create: async ({ data }) => {
        audits.push(data);
      },
    },
  };
  let transactions = 0;
  const prisma = {
    $transaction: async (fn) => {
      transactions++;
      if (hook) await hook(transactions);
      const before = {
        rows: structuredClone(rows),
        audits: structuredClone(audits),
      };
      try {
        return await fn(tx);
      } catch (error) {
        rows = before.rows;
        audits = before.audits;
        throw error;
      }
    },
  };
  const fetchImpl = async (url) =>
    new Response(
      fs.readFileSync(path.join(root, path.basename(new URL(url).pathname))),
    );
  // Windows does not expose a directory fd. Only the local durability syscall is
  // substituted; file creation, permissions, file fsync and hashing remain real.
  const originalOpen = fs.openSync;
  const probe = path.join(root, ".directory-fsync-probe");
  fs.writeFileSync(probe, "probe");
  const useDirectoryShim = () => {
    if (process.platform === "win32")
      fs.openSync = (file, flags, ...rest) =>
        file === root && flags === fs.constants.O_RDONLY
          ? originalOpen(probe, "r+")
          : originalOpen(file, flags, ...rest);
  };
  const restore = () => {
    fs.openSync = originalOpen;
    fs.rmSync(root, { recursive: true, force: true });
  };
  return {
    root,
    bytes,
    source,
    old,
    env,
    prisma,
    tx,
    fetchImpl,
    rows: () => rows,
    audits: () => audits,
    updates,
    commands,
    setHook: (value) => {
      hook = value;
    },
    useDirectoryShim,
    restore,
  };
}
async function prepared(f) {
  const receipt = await publisher.run({
    prisma: f.prisma,
    env: f.env,
    uploadRoot: f.root,
    fetchImpl: f.fetchImpl,
  });
  return { ...f.env, MODE: "apply", EXPECTED_PLAN_HASH: receipt.planHash };
}
test("default plan is read-only, hashes all four documents and reads the original file", async () => {
  const f = fixture();
  try {
    const result = await publisher.run({
      prisma: f.prisma,
      env: f.env,
      uploadRoot: f.root,
      fetchImpl: () => {
        throw Error("PLAN_MUST_NOT_FETCH_NEW_FILE");
      },
    });
    assert.equal(result.status, "PLANNED");
    assert.equal(result.currentFileHash, hash(fs.readFileSync(f.old)));
    assert.equal(result.publicCooperationDocuments, 4);
    assert.equal(f.updates.length, 0);
    assert.equal(f.audits().length, 0);
    assert.ok(
      f.commands.some((sql) => sql.includes("SET TRANSACTION READ ONLY")),
    );
    assert.ok(!fs.existsSync(path.join(f.root, path.basename(result.newUrl))));
  } finally {
    f.restore();
  }
});
test("apply creates immutable bytes before nginx verification, updates only URL/size and retains every other field/file", async () => {
  const f = fixture();
  try {
    const env = await prepared(f),
      before = structuredClone(f.rows()),
      oldBytes = fs.readFileSync(f.old);
    f.useDirectoryShim();
    const result = await publisher.run({
      prisma: f.prisma,
      env,
      uploadRoot: f.root,
      fetchImpl: f.fetchImpl,
    });
    assert.equal(result.status, "PUBLISHED");
    assert.equal(result.verified, true);
    assert.deepEqual(Object.keys(f.updates[0]).sort(), ["fileSize", "fileUrl"]);
    assert.deepEqual(f.rows().slice(1), before.slice(1));
    for (const key of Object.keys(before[0]).filter(
      (key) => !["fileUrl", "fileSize", "updatedAt"].includes(key),
    ))
      assert.deepEqual(f.rows()[0][key], before[0][key]);
    assert.deepEqual(fs.readFileSync(f.old), oldBytes);
    assert.equal(f.audits().length, 1);
    const applyStart = f.commands.findIndex((sql) =>
      sql.includes("LOCK TABLE documents"),
    );
    assert.ok(applyStart > 0);
    assert.ok(
      f.commands
        .slice(applyStart + 1)
        .find((sql) => sql.includes("SELECT"))
        .includes("pg_control_system"),
    );
    const already = await publisher.run({
      prisma: f.prisma,
      env,
      uploadRoot: f.root,
      fetchImpl: f.fetchImpl,
    });
    assert.equal(already.status, "ALREADY_PUBLISHED");
    assert.equal(f.updates.length, 1);
    assert.equal(f.audits().length, 1);
  } finally {
    f.restore();
  }
});
test("nginx mismatch prevents DB writes and preserves both original and unreferenced immutable file", async () => {
  const f = fixture();
  try {
    const env = await prepared(f);
    f.useDirectoryShim();
    await assert.rejects(
      publisher.run({
        prisma: f.prisma,
        env,
        uploadRoot: f.root,
        fetchImpl: async () => new Response("wrong"),
      }),
      { safeCode: "PUBLIC_FILE_HASH_MISMATCH" },
    );
    assert.equal(f.updates.length, 0);
    assert.equal(f.rows()[0].fileUrl, publisher.OLD_URL);
    assert.ok(fs.existsSync(f.old));
    assert.ok(
      fs.existsSync(
        path.join(
          f.root,
          "calculator-rassrochki-" + env.SOURCE_HTML_SHA256 + ".html",
        ),
      ),
    );
  } finally {
    f.restore();
  }
});
test("a changed other document after plan refuses CAS without hiding or replacing documents", async () => {
  const f = fixture();
  try {
    const env = await prepared(f);
    f.useDirectoryShim();
    f.setHook((count) => {
      if (count === 3) f.rows()[1].description = "Changed by another writer";
    });
    await assert.rejects(
      publisher.run({
        prisma: f.prisma,
        env,
        uploadRoot: f.root,
        fetchImpl: f.fetchImpl,
      }),
      { safeCode: "DOCUMENT_SNAPSHOT_CHANGED" },
    );
    assert.equal(f.updates.length, 0);
    assert.equal(f.rows()[0].fileUrl, publisher.OLD_URL);
    assert.equal(f.rows().length, 4);
  } finally {
    f.restore();
  }
});
for (const patch of [
  { CONFIRM_APPLY: "false" },
  { SOURCE_CI_ATTESTED: "false" },
  { EXPECTED_PLAN_HASH: "" },
  { GIT_SHA: "d".repeat(40) },
  { VERIFIED_BACKUP_DEPLOYED_SHA: "e".repeat(40) },
  { VERIFIED_BACKUP_AT: "2020-01-01" },
]) {
  test("apply gate refuses " + Object.keys(patch)[0], async () => {
    const f = fixture();
    try {
      const env = { ...(await prepared(f)), ...patch };
      await assert.rejects(
        publisher.run({
          prisma: f.prisma,
          env,
          uploadRoot: f.root,
          fetchImpl: f.fetchImpl,
        }),
      );
      assert.equal(f.updates.length, 0);
    } finally {
      f.restore();
    }
  });
}
test("exact plan hash binds runtime and source hashes", async () => {
  const f = fixture();
  try {
    const env = { ...(await prepared(f)), SOURCE_SHA: "e".repeat(40) };
    await assert.rejects(
      publisher.run({
        prisma: f.prisma,
        env,
        uploadRoot: f.root,
        fetchImpl: f.fetchImpl,
      }),
      { safeCode: "PLAN_CHANGED" },
    );
    assert.equal(f.updates.length, 0);
  } finally {
    f.restore();
  }
});
test("existing immutable hash path is never overwritten on collision", () => {
  const f = fixture();
  try {
    const target = path.join(f.root, "existing.html");
    fs.writeFileSync(target, "OTHER");
    assert.throws(() => publisher.ensureImmutableFile(target, f.bytes), {
      safeCode: "IMMUTABLE_FILE_COLLISION",
    });
    assert.equal(fs.readFileSync(target, "utf8"), "OTHER");
  } finally {
    f.restore();
  }
});
test("workflow preserves reviewed-source, backup, SSH and runtime gates without live git mutations", () => {
  const code = fs.readFileSync(
    path.join(
      __dirname,
      "../.github/workflows/publish-installment-calculator-20261110.yml",
    ),
    "utf8",
  );
  for (const required of [
    "default: plan",
    "group: production-deploy",
    "environment: production",
    "Build and test release commit",
    "SOURCE_CI_ATTESTED=true",
    "SOURCE_HTML_SHA256",
    "EXPECTED_PLAN_HASH",
    "PRODUCTION_PG_SYSTEM_IDENTIFIER",
    "pg_restore --exit-on-error --no-owner --file=/dev/null",
    "StrictHostKeyChecking=yes",
    "flock -x -n 9",
    "git diff --exit-code",
    "unexpected_source_change=true",
    "assert_runtime",
    "VERIFIED_BACKUP_DEPLOYED_SHA",
    "PUBLISH_APPROVED_INSTALLMENT_CALCULATOR_2026_11_10",
  ])
    assert.ok(code.includes(required), required);
  assert.ok(
    !/git (fetch|pull|reset|clean)|StrictHostKeyChecking=no|apply-cooperation-script/.test(
      code,
    ),
  );
});
test("prior matching publication audit with a reverted row refuses an inconsistent replay", async () => {
  const f = fixture();
  try {
    f.audits().push({ payload: { newHash: f.env.SOURCE_HTML_SHA256 } });
    await assert.rejects(
      publisher.run({
        prisma: f.prisma,
        env: f.env,
        uploadRoot: f.root,
        fetchImpl: f.fetchImpl,
      }),
      { safeCode: "PRIOR_AUDIT_STATE_MISMATCH" },
    );
    assert.equal(f.updates.length, 0);
  } finally {
    f.restore();
  }
});
test("changed original HTML after planning refuses without a document mutation", async () => {
  const f = fixture();
  try {
    const env = await prepared(f);
    fs.writeFileSync(f.old, "<html>Changed old file</html>");
    await assert.rejects(
      publisher.run({
        prisma: f.prisma,
        env,
        uploadRoot: f.root,
        fetchImpl: f.fetchImpl,
      }),
      { safeCode: "PLAN_CHANGED" },
    );
    assert.equal(f.updates.length, 0);
  } finally {
    f.restore();
  }
});
test("non-200 or oversized public responses fail closed and cancel bounded streams", async () => {
  const target = {
    fileUrl: "/files/cooperation/calculator-test.html",
    hash: "a".repeat(64),
    size: 8,
  };
  await assert.rejects(
    publisher.verifyPublic(
      target,
      async () => new Response("missing", { status: 404 }),
    ),
    { safeCode: "PUBLIC_FILE_UNAVAILABLE" },
  );
  let canceled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(9));
    },
    cancel() {
      canceled = true;
    },
  });
  await assert.rejects(
    publisher.verifyPublic(target, async () => new Response(body)),
    { safeCode: "PUBLIC_FILE_HASH_MISMATCH" },
  );
  assert.equal(canceled, true);
});
test("backup freshness rejects future and exactly six-hour-old attestations", () => {
  const f = fixture();
  try {
    for (const timestamp of [Date.now() + 1000, Date.now() - 21600000])
      assert.throws(
        () =>
          publisher.environment({
            ...f.env,
            MODE: "apply",
            EXPECTED_PLAN_HASH: "d".repeat(64),
            VERIFIED_BACKUP_AT: new Date(timestamp).toISOString(),
          }),
        { safeCode: "BACKUP_STALE" },
      );
  } finally {
    f.restore();
  }
});
