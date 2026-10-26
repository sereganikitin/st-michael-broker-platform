"use strict";
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { PGlite } = require(process.env.PGLITE_MODULE || "@electric-sql/pglite");
const sql = readFileSync(
  join(
    __dirname,
    "../packages/database/prisma/migrations/20261026120000_agency_call_control/migration.sql",
  ),
  "utf8",
);
const init = `CREATE TABLE agencies(id text PRIMARY KEY);
CREATE TYPE assignment_status AS ENUM ('PENDING','IN_PROGRESS','COMPLETED','CANCELLED');
CREATE TABLE loyalty_call_assignments(id text PRIMARY KEY, our_agency_id text REFERENCES agencies(id), status assignment_status);
INSERT INTO agencies VALUES ('synthetic-agency');`;
(async () => {
  const db = new PGlite();
  try {
    await db.exec(init);
    await db.exec(sql);
    await db.query(
      "INSERT INTO loyalty_call_assignments VALUES ('first','synthetic-agency','PENDING')",
    );
    await assert.rejects(
      db.query(
        "INSERT INTO loyalty_call_assignments VALUES ('duplicate','synthetic-agency','IN_PROGRESS')",
      ),
      (e) => e.code === "23505",
    );
    await db.query(
      "UPDATE loyalty_call_assignments SET status='COMPLETED' WHERE id='first'",
    );
    await db.query(
      "INSERT INTO loyalty_call_assignments VALUES ('follow-up','synthetic-agency','PENDING')",
    );
    await db.query(
      "INSERT INTO loyalty_call_assignments VALUES ('broker-a',NULL,'PENDING'),('broker-b',NULL,'PENDING')",
    );
    const result = await db.query(
      "SELECT do_not_call, call_contacts, call_contacts_version FROM agencies",
    );
    assert.deepEqual(result.rows[0], {
      do_not_call: false,
      call_contacts: [],
      call_contacts_version: 1,
    });
  } finally {
    await db.close();
  }
  const legacy = new PGlite();
  try {
    await legacy.exec(init);
    await legacy.query(
      "INSERT INTO loyalty_call_assignments VALUES ('first','synthetic-agency','PENDING'),('duplicate','synthetic-agency','PENDING')",
    );
    await assert.rejects(legacy.exec(sql), (e) => e.code === "23505");
    await legacy.exec("ROLLBACK");
    const columns = await legacy.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name='agencies'",
    );
    assert.deepEqual(
      columns.rows.map((c) => c.column_name),
      ["id"],
      "failed preflight must roll back added columns",
    );
    assert.equal(
      (
        await legacy.query(
          "SELECT count(*)::int AS count FROM loyalty_call_assignments",
        )
      ).rows[0].count,
      2,
    );
  } finally {
    await legacy.close();
  }
  console.log(
    "PASS: PostgreSQL migration defaults, active-agency uniqueness, completed follow-up, broker isolation, legacy-duplicate rollback",
  );
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
