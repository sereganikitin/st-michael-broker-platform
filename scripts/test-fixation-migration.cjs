// Rehearse the additive migration against a populated, disposable LOCAL database.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { PrismaClient } = require("@prisma/client");
const database = `fixation_upgrade_${Date.now()}`;
assert(/^fixation_upgrade_\d+$/.test(database));
const base = "postgresql://fixation_test:local-test-only@127.0.0.1:55441/";
const admin = new PrismaClient({
  datasources: { db: { url: `${base}fixation_local_test` } },
});
const db = new PrismaClient({ datasources: { db: { url: base + database } } });
const name = "20261117000100_durable_fixation_requests";
const work = path.resolve("tmp/fixation-local", database, "prisma");
async function main() {
  await admin.$executeRawUnsafe(
    `CREATE DATABASE "${database}" OWNER fixation_test`,
  );
  fs.mkdirSync(path.join(work, "migrations"), { recursive: true });
  fs.writeFileSync(
    path.join(work, "schema.prisma"),
    execFileSync(
      "git",
      ["show", "HEAD:packages/database/prisma/schema.prisma"],
      { windowsHide: true },
    ),
  );
  for (const entry of fs.readdirSync("packages/database/prisma/migrations", {
    withFileTypes: true,
  })) {
    if (
      entry.name === name ||
      (!entry.isDirectory() && entry.name !== "migration_lock.toml")
    )
      continue;
    fs.cpSync(
      path.resolve("packages/database/prisma/migrations", entry.name),
      path.join(work, "migrations", entry.name),
      { recursive: true },
    );
  }
  const migrate = () =>
    execFileSync(
      process.execPath,
      [
        path.resolve("node_modules/prisma/build/index.js"),
        "migrate",
        "deploy",
        "--schema",
        path.join(work, "schema.prisma"),
      ],
      {
        env: { ...process.env, DATABASE_URL: base + database },
        windowsHide: true,
        timeout: 60_000,
        encoding: "utf8",
        stdio: "pipe",
      },
    );
  migrate();
  const broker = await db.broker.create({
    data: {
      id: randomUUID(),
      phone: "+70000000001",
      fullName: "Synthetic migration broker",
      status: "ACTIVE",
    },
    select: { id: true },
  });
  const client = await db.client.create({
    data: {
      id: randomUUID(),
      brokerId: broker.id,
      phone: "+70000000002",
      fullName: "Synthetic preserved client",
      project: "SILVER_BOR",
      uniquenessStatus: "UNDER_REVIEW",
      uniquenessReason: "preserve-me",
      amoLeadId: 123456n,
    },
    select: {
      id: true,
      fullName: true,
      uniquenessStatus: true,
      uniquenessReason: true,
      amoLeadId: true,
    },
  });
  fs.cpSync(
    path.resolve("packages/database/prisma/migrations", name),
    path.join(work, "migrations", name),
    { recursive: true },
  );
  migrate();
  const current = await db.client.findUniqueOrThrow({
    where: { id: client.id },
  });
  for (const key of Object.keys(client))
    assert.equal(current[key], client[key]);
  assert.equal(current.fixationRequestId, null);
  const request = await db.fixationRequest.create({
    data: {
      actorId: broker.id,
      fingerprint: "test",
      phoneKey: "test",
      payload: {},
    },
  });
  await db.fixationRequestKey.create({
    data: { actorId: broker.id, key: "stable-key", requestId: request.id },
  });
  await assert.rejects(
    db.fixationRequestKey.create({
      data: { actorId: broker.id, key: "stable-key", requestId: request.id },
    }),
    (e) => e.code === "P2002",
  );
  await db.client.update({
    where: { id: client.id },
    data: { fixationRequestId: request.id },
  });
  await assert.rejects(
    db.client.create({
      data: {
        brokerId: broker.id,
        phone: "+70000000003",
        fullName: "Duplicate link",
        project: "SILVER_BOR",
        fixationRequestId: request.id,
      },
    }),
    (e) => e.code === "P2002",
  );
  await assert.rejects(
    db.fixationRequest.delete({ where: { id: request.id } }),
    (e) => e.code === "P2003",
  );
  assert(migrate().includes("No pending migrations"));
  const report = {
    database,
    passed: 5,
    checks: [
      "existing fields preserved",
      "nullable link backward compatible",
      "request keys unique",
      "client link unique and FK restrictive",
      "second deploy has no pending migrations",
    ],
  };
  fs.writeFileSync(
    "tmp/fixation-local/migration-upgrade.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
}
main()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
    await admin.$disconnect();
  });
