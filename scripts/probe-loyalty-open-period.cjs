"use strict";

// Same server-local, short-lived ADMIN test authentication as the existing
// qa-loyalty-filters script. Tokens and customer rows are never printed.
const crypto = require("node:crypto");
const { PrismaClient } = require("@st-michael/database");
const expectedSha = "dd9e37826faea59840b87ab5086f2cae8b512377";
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

async function main() {
  if (process.env.GIT_SHA !== expectedSha) throw new Error("Unexpected release SHA");
  const prisma = new PrismaClient();
  try {
    const admin = await prisma.broker.findFirst({
      where: { role: "ADMIN", status: "ACTIVE", mergedIntoId: null, passwordHash: { not: null } },
      select: { id: true, phone: true, authVersion: true }, orderBy: { createdAt: "asc" },
    });
    if (!admin || !process.env.JWT_SECRET) throw new Error("Test authentication unavailable");
    const issued = Math.floor(Date.now() / 1000);
    const data = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: admin.id, phone: admin.phone, role: "ADMIN", type: "access", authVersion: admin.authVersion, iat: issued, exp: issued + 300 })}`;
    const token = `${data}.${crypto.createHmac("sha256", process.env.JWT_SECRET).update(data).digest("base64url")}`;
    const today = new Date(Date.now() + 10800000).toISOString().slice(0, 10);
    const from = today.slice(0, 7) + "-01";
    const checks = [];
    for (const route of ["ours/brokers", "ours/agencies", "anna/brokers", "anna/agencies"]) {
      const results = [];
      for (const callPeriod of [{ from }, { from, to: today }]) {
        const response = await fetch(`http://localhost:4000/api/loyalty-base/${route}/search`, {
          method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ page: 1, pageSize: 1, search: "", sortBy: "name", sortOrder: "asc", filter: { callPeriod } }),
          signal: AbortSignal.timeout(45000),
        });
        const json = await response.json();
        if (!response.ok) throw new Error(`Search ${route} HTTP ${response.status}`);
        results.push({ status: response.status, total: json.total, filterHash: json.filterHash });
      }
      const [open, explicit] = results;
      const same = Number.isFinite(open.total) && open.total === explicit.total &&
        typeof open.filterHash === "string" && open.filterHash.length > 0 && open.filterHash === explicit.filterHash;
      checks.push({ route, openStatus: open.status, explicitStatus: explicit.status, total: open.total, sameSelectionAndPeriodHash: same });
      if (!same) throw new Error(`Period parity failed for ${route}`);
    }
    const invalid = await fetch("http://localhost:4000/api/loyalty-base/ours/brokers/search", {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ filter: { callPeriod: { from: "2026-02-30" } } }),
      signal: AbortSignal.timeout(15000),
    });
    if (invalid.status !== 400) throw new Error("Invalid date was not rejected");
    console.log("OPEN_PERIOD_SMOKE " + JSON.stringify({ checkedAt: new Date().toISOString(), deployedSha: expectedSha, from, effectiveTo: today, checks, invalidDateStatus: invalid.status }));
  } finally { await prisma.$disconnect(); }
}
main().catch((error) => {
  // Only fixed diagnostic strings above, never HTTP bodies or credentials.
  console.error("OPEN_PERIOD_SMOKE_FAILED " + String(error?.message || error?.name));
  process.exitCode = 1;
});
