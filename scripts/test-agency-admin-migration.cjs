// Upgrade a populated, disposable loopback database through the real migration.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { PrismaClient } = require("@prisma/client");
const { randomUUID } = require("node:crypto");

const database = `fixation_agency_upgrade_${Date.now()}`;
assert(/^fixation_agency_upgrade_\d+$/.test(database));
const base = "postgresql://fixation_test:local-test-only@127.0.0.1:55441/";
const admin = new PrismaClient({
  datasources: { db: { url: base + "fixation_local_test" } },
});
const db = new PrismaClient({ datasources: { db: { url: base + database } } });
const migration = "20261119000100_agency_admin_fixation_visibility";
const root = path.resolve("packages/database/prisma");
const work = path.resolve("tmp/agency-admin", database);

function migrate() {
  return execFileSync(
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
}

async function main() {
  await admin.$executeRawUnsafe(
    `CREATE DATABASE "${database}" OWNER fixation_test`,
  );
  fs.mkdirSync(path.join(work, "migrations"), { recursive: true });
  fs.copyFileSync(
    path.join(root, "schema.prisma"),
    path.join(work, "schema.prisma"),
  );
  for (const entry of fs.readdirSync(path.join(root, "migrations"), {
    withFileTypes: true,
  })) {
    if (
      entry.name === migration ||
      (!entry.isDirectory() && entry.name !== "migration_lock.toml")
    )
      continue;
    fs.cpSync(
      path.join(root, "migrations", entry.name),
      path.join(work, "migrations", entry.name),
      { recursive: true },
    );
  }
  migrate();
  const author = await db.broker.create({
    data: {
      phone: "+70000000011",
      fullName: "Synthetic author",
      status: "ACTIVE",
    },
    select: { id: true },
  });
  const recipient = await db.broker.create({
    data: {
      phone: "+70000000012",
      fullName: "Synthetic recipient",
      status: "ACTIVE",
    },
    select: { id: true },
  });
  const agency = await db.agency.create({
    data: { inn: "7700000000", name: "Synthetic agency" },
    select: { id: true },
  });
  const membership = { id: randomUUID() };
  await db.$executeRaw`INSERT INTO broker_agencies(id, broker_id, agency_id) VALUES (${membership.id}, ${author.id}, ${agency.id})`;
  const receipt = await db.fixationRequest.create({
    data: {
      actorId: author.id,
      fingerprint: "legacy",
      phoneKey: "legacy",
      payload: {},
      state: "DELIVERY_PENDING",
      phase: "MUTATING",
      attempts: 3,
    },
    select: { id: true, state: true, phase: true, attempts: true },
  });
  const unverified = await db.fixationRequest.create({
    data: {
      actorId: author.id,
      fingerprint: "unverified",
      phoneKey: "unverified",
      payload: { responsibleBrokerId: recipient.id },
      state: "NEEDS_REVIEW",
      phase: "MUTATING",
    },
    select: { id: true },
  });
  const client = await db.client.create({
    data: {
      brokerId: author.id,
      responsibleBrokerId: recipient.id,
      fixationAgencyId: agency.id,
      fixationRequestId: receipt.id,
      phone: "+70000000013",
      fullName: "Synthetic legacy client",
      project: "SILVER_BOR",
      amoLeadId: 123456n,
      uniquenessStatus: "UNDER_REVIEW",
    },
  });
  fs.cpSync(
    path.join(root, "migrations", migration),
    path.join(work, "migrations", migration),
    { recursive: true },
  );
  migrate();
  assert.deepEqual(
    await db.client.findUnique({ where: { id: client.id } }),
    client,
  );
  const verified = await db.fixationRequest.findUniqueOrThrow({
    where: { id: receipt.id },
  });
  assert.equal(verified.responsibleBrokerId, recipient.id);
  assert.equal(verified.fixationAgencyId, agency.id);
  for (const key of ["state", "phase", "attempts"])
    assert.equal(verified[key], receipt[key]);
  assert.equal(
    (
      await db.fixationRequest.findUniqueOrThrow({
        where: { id: unverified.id },
      })
    ).responsibleBrokerId,
    null,
  );
  assert.equal(
    (await db.brokerAgency.findUniqueOrThrow({ where: { id: membership.id } }))
      .isAgencyAdmin,
    false,
  );
  await assert.rejects(
    db.fixationRequest.update({
      where: { id: receipt.id },
      data: { responsibleBrokerId: "missing" },
    }),
    (e) => e.code === "P2003",
  );
  assert(migrate().includes("No pending migrations"));
  const report = {
    database,
    passed: 7,
    checks: [
      "client fields preserved",
      "recipient and agency restored from exact Client link",
      "queue state and attempts preserved",
      "unverified payload does not grant access",
      "no automatic administrator grants",
      "destination foreign key",
      "repeat deploy has no pending migrations",
    ],
  };
  fs.writeFileSync(
    "tmp/agency-admin/migration-results.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
}
main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
    await admin.$disconnect();
  });
