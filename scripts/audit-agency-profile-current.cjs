"use strict";
const crypto = require("node:crypto");
const { PrismaClient } = require("@st-michael/database");
const publicKey = `-----BEGIN PUBLIC KEY-----
MIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEAo2EqU+y/1z3aYx7wU+gd
HCX43mPhEZnlO3exf6QpsNpFonBb2qSxmm4etKl52m4R4IXFxYKpibkT8KuY4aID
SUgl9nU8e6HJP3eKPl7JKvfGe9cx5Q1n+xbr9QrtrpBmS8fqTnPtwzbufF9FBLHl
VkXHVM2ECIAMdH8pShb43dxMbB/POKmvtjLVjiDFQ1MyWDmG8O46dTBS1isZM7sf
wpxS6hmX2X1vYL0D+uQLX2frbZ08JOWatgSTDRe5m2AvivuJU9uSUvX2XWZVCcuj
Id4B4ZuuesVXz0Jtix80pvDbq/RJyupttmDrFk3/LPTRLKAXtKIzlqaOmVA9CNqn
v8cJp9qqel9GZaggBf2waK/p9sN5Uu8y4Ng1Vv0Jeo7vkKCi+OGJiFv9ttFgJICv
KKH3SJJJNtqB5QCgYFVhguL+OrAuf/NW3MIsQ8ETBt/fNegxgiKBF7JjgWq41bj8
5a3CsSkqmIw5M4DghKJn4Rn5tDyE4J7Z2M/fnggq2Y2VAgMBAAE=
-----END PUBLIC KEY-----`;
async function main() {
  console.log("AGENCY_AUDIT_STARTED");
  const prisma = new PrismaClient();
  try {
    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '30s'");
      const agencies = await tx.agency.findMany({ where: { OR: [{ inn: "9702028892" }, { name: { contains: "Онлайн Недвижимость", mode: "insensitive" } }] }, select: {
        id: true, name: true, inn: true, legalName: true, createdAt: true, updatedAt: true,
        _count: { select: { brokerAgencies: true } },
      } });
      const ids = agencies.map((a) => a.id);
      const brokers = await tx.brokerAgency.findMany({ where: { agencyId: { in: ids } }, select: {
        agencyId: true, isPrimary: true, joinedAt: true,
        broker: { select: { id: true, role: true, status: true, mergedIntoId: true, amoContactId: true } },
      } });
      const links = await tx.loyaltyEntityLink.findMany({ where: { targetType: "AGENCY", targetId: { in: ids }, status: "CONFIRMED", revokedAt: null }, select: { organizationId: true, targetId: true, decidedAt: true } });
      const dataset = await tx.loyaltyDataset.findUnique({ where: { code: "ANNA" }, select: { activeSnapshotId: true } });
      const fields = ["agencySize", "brokerCount", "activeBrokers", "website", "projectsOnSite", "sitePlacementRequirements", "lastAgencyMeetingDate", "agencyBtFormat", "agencyBtDate", "lastContractDate", "nextAgreement", "specialTerms", "specialTermsStatus", "specialTermsValidUntil", "partnershipStatus"];
      const sourceRecords = dataset?.activeSnapshotId ? await tx.loyaltySourceRecord.findMany({ where: {
        snapshotId: dataset.activeSnapshotId, entityType: "AGENCY", OR: [{ taxId: "9702028892" }, { organizationId: { in: links.map((l) => l.organizationId).filter(Boolean) } }],
      }, select: { id: true, organizationId: true, displayName: true, taxId: true, sourceKey: true, createdAt: true, attributes: true } }) : [];
      const syncRuns = await tx.loyaltySyncRun.findMany({ where: { source: "AMOCRM" }, orderBy: { startedAt: "desc" }, take: 5, select: { status: true, ruleVersion: true, startedAt: true, completedAt: true, errorCode: true, counts: true } });
      return {
        agencies, brokers, links,
        sourceRecords: sourceRecords.map((r) => ({ ...r, attributes: Object.fromEntries(fields.map((key) => [key, r.attributes?.[key] ?? null])) })),
        syncRuns,
      };
    }, { isolationLevel: "RepeatableRead", timeout: 60000 });
    const key = crypto.randomBytes(32), iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const text = JSON.stringify(result, (_key, value) => typeof value === "bigint" ? value.toString() : value);
    const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
    console.log("AGENCY_AUDIT_PRIVATE " + JSON.stringify({ key: crypto.publicEncrypt({ key: publicKey, oaepHash: "sha256" }, key).toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: encrypted.toString("base64") }));
    console.log("AGENCY_AUDIT_RESULT " + JSON.stringify({
      checkedAt: new Date().toISOString(), deployedSha: process.env.GIT_SHA,
      matchingAgencies: result.agencies.length, localRelations: result.brokers.length, confirmedAnnaLinks: result.links.length, annaRecords: result.sourceRecords.length,
      amoConfigured: Boolean(process.env.AMO_ACCESS_TOKEN), touchSyncEnabled: process.env.AMO_TOUCH_SYNC_ENABLED !== "false",
      opsTokenConfigured: Boolean(process.env.OPS_TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN),
      opsRecipientsConfigured: Boolean(process.env.OPS_ALERT_CHAT_ID || process.env.OPS_ALERT_CHAT_IDS),
      timezone: process.env.TZ || "system-default", utcOffsetMinutes: new Date().getTimezoneOffset(),
      syncRuns: result.syncRuns.map(({ counts, ...run }) => run),
    }));
  } finally { await prisma.$disconnect(); }
}
const keepAlive = setInterval(() => {}, 1000);
main().catch((error) => { console.error("AGENCY_AUDIT_FAILED " + String(error?.code || error?.name || "unknown")); process.exitCode = 1; }).finally(() => clearInterval(keepAlive));
