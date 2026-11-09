"use strict";

// Read-only audit. Only aggregate counts and dates leave this process.
const { PrismaClient } = require("@st-michael/database");
const crypto = require("node:crypto");
const auditPublicKey = `-----BEGIN PUBLIC KEY-----
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
const { LoyaltyBaseService, fixationClientWhere } = require("/app/apps/api/dist/loyalty-base/loyalty-base.service");
const moscowDay = (value) => new Date(new Date(value).getTime() + 10800000).toISOString().slice(0, 10);
const earliest = (rows, brokerId) => rows.filter((r) => r.brokerId === brokerId)
  .map((r) => new Date(r.at)).sort((a, b) => a - b)[0] || null;

async function main() {
  const prisma = new PrismaClient();
  const now = new Date();
  const today = moscowDay(now);
  const year = today.slice(0, 4);
  const month = Number(today.slice(5, 7));
  const quarterStart = `${year}-${String(Math.floor((month - 1) / 3) * 3 + 1).padStart(2, "0")}-01`;
  let sourceIds = [];
  let sourceTours = [];
  let privateEvidence;
  try {
    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '45s'");
      const service = new LoyaltyBaseService(tx);
      const marked = await tx.broker.findMany({
        where: { role: "BROKER", mergedIntoId: null, brokerTourVisited: true },
        select: { id: true, brokerTourDate: true, amoContactId: true },
      });
      const dated = marked.filter((b) => b.brokerTourDate);
      const quarter = dated.filter((b) => moscowDay(b.brokerTourDate) >= quarterStart && moscowDay(b.brokerTourDate) <= today);
      const annual = dated.filter((b) => moscowDay(b.brokerTourDate) >= `${year}-01-01` && moscowDay(b.brokerTourDate) <= today);
      const anomalous = dated.filter((b) => moscowDay(b.brokerTourDate) < "2015-01-01");
      sourceIds = [...new Set([...quarter, ...anomalous].map((b) => b.amoContactId).filter(Boolean))];
      const latest = dated.filter((b) => b.brokerTourDate <= now).sort((a, b) => b.brokerTourDate - a.brokerTourDate)[0];
      const completed = await tx.meeting.aggregate({ where: { type: "BROKER_TOUR", status: "COMPLETED", date: { lte: now } }, _max: { date: true } });
      const responses = [];
      for (const from of [quarterStart, `${year}-01-01`]) {
        for (const cabinetSource of ["new", "all"]) {
          const response = await service.brokerFunnel("ours", { mode: "strict", from, to: today, cabinetSource });
          responses.push({ from, to: today, cabinetSource, totals: response.totals, funnel: response.funnel, byMonth: response.byMonth });
        }
      }
      const ids = annual.map((b) => b.id);
      const registry = await tx.registryDeal.findMany({ where: { brokerId: { in: ids }, paidAt: { not: null } }, select: {
        id: true, brokerId: true, brokerAmoContactId: true, amoLeadId: true, contractNumber: true,
        source: true, signedAt: true, paidAt: true, project: true, saleChannel: true,
      } });
      const deals = await tx.deal.findMany({ where: { brokerId: { in: ids }, ...service.ourConfirmedDealWhere() }, select: {
        id: true, brokerId: true, amoDealId: true, amoParentDealId: true, signedAt: true, paidAt: true, project: true, status: true,
      } });
      const dealEvents = [
        ...registry.map((r) => ({ brokerId: r.brokerId, at: r.paidAt })),
        ...deals.map((r) => ({ brokerId: r.brokerId, at: r.signedAt })),
      ];
      const displayedDealBrokers = annual.filter((b) => {
        const first = earliest(dealEvents, b.id);
        return first && first >= b.brokerTourDate;
      });
      const anyDealAfter = annual.filter((b) => dealEvents.some((r) => r.brokerId === b.id && r.at >= b.brokerTourDate && r.at <= now));
      const evidenceBrokers = [...new Map([...displayedDealBrokers, ...anyDealAfter].map((b) => [b.id, b])).values()];
      const evidenceIds = new Set(evidenceBrokers.map((b) => b.id));
      privateEvidence = {
        checkedAt: now.toISOString(), year, displayedBrokerIds: displayedDealBrokers.map((b) => b.id),
        brokers: evidenceBrokers, quarterBrokers: quarter, registryDeals: registry.filter((r) => evidenceIds.has(r.brokerId)),
        cabinetDeals: deals.filter((r) => evidenceIds.has(r.brokerId)),
      };
      sourceIds = [...new Set([...sourceIds, ...evidenceBrokers.map((b) => b.amoContactId).filter(Boolean)])];
      sourceTours = marked.filter((b) => sourceIds.some((id) => String(id) === String(b.amoContactId)));
      const fixes = await tx.client.findMany({ where: { brokerId: { in: ids }, ...fixationClientWhere("new") }, select: { brokerId: true, createdAt: true } });
      const meetings = await tx.meeting.findMany({ where: { brokerId: { in: ids }, status: { in: ["CONFIRMED", "COMPLETED"] }, type: { not: "BROKER_TOUR" } }, select: { brokerId: true, date: true } });
      const fixRows = fixes.map((r) => ({ brokerId: r.brokerId, at: r.createdAt }));
      const meetingRows = meetings.map((r) => ({ brokerId: r.brokerId, at: r.date }));
      const comparisons = [];
      for (const [label, group] of [["quarter", quarter], ["year", annual]]) {
        let earliestFixAfter = 0, anyFixAfter = 0, hiddenLaterFix = 0, anyMeetingAfter = 0, meetingWithoutNewFixAfter = 0, fixThenMeeting = 0;
        for (const b of group) {
          const first = earliest(fixRows, b.id);
          const after = fixRows.filter((r) => r.brokerId === b.id && r.at >= b.brokerTourDate && r.at <= now).sort((a, c) => a.at - c.at)[0];
          const meetAfter = meetingRows.some((r) => r.brokerId === b.id && r.at >= b.brokerTourDate && r.at <= now);
          if (first && first >= b.brokerTourDate) earliestFixAfter++;
          if (after) anyFixAfter++;
          if (after && first < b.brokerTourDate) hiddenLaterFix++;
          if (meetAfter) anyMeetingAfter++;
          if (meetAfter && !after) meetingWithoutNewFixAfter++;
          if (after && meetingRows.some((r) => r.brokerId === b.id && r.at >= after.at && r.at <= now)) fixThenMeeting++;
        }
        comparisons.push({ label, cohort: group.length, earliestFixAfter, anyFixAfter, hiddenLaterFix, anyMeetingAfter, meetingWithoutNewFixAfter, fixThenMeeting });
      }
      return {
        checkedAt: now.toISOString(), deployedSha: process.env.GIT_SHA,
        today, quarterStart, marked: marked.length, dated: dated.length, undated: marked.length - dated.length,
        latestMarkedTourAt: latest?.brokerTourDate || null,
        latestMarkedTourMoscowDay: latest ? moscowDay(latest.brokerTourDate) : null,
        latestCompletedMeetingAt: completed._max.date,
        anomalousTourDates: anomalous.map((b) => b.brokerTourDate),
        displayedDealBrokers: displayedDealBrokers.length,
        brokersWithAnyDealAfterTour: anyDealAfter.length,
        responses, comparisons,
      };
    }, { isolationLevel: "RepeatableRead", timeout: 180000, maxWait: 10000 });

    const setting = await prisma.systemSetting.findUnique({ where: { key: "AMO_ACCESS_TOKEN" }, select: { value: true } });
    const token = setting?.value || process.env.AMO_ACCESS_TOKEN;
    const subdomain = process.env.AMO_SUBDOMAIN || "stmichael";
    if (!/^[a-z0-9-]+$/i.test(subdomain)) throw new Error("Invalid amo subdomain");
    if (token && sourceIds.length) {
      const query = sourceIds.map((id) => `filter[id][]=${encodeURIComponent(String(id))}`).join("&");
      const response = await fetch(`https://${subdomain}.amocrm.ru/api/v4/contacts?${query}&limit=250`, {
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000),
      });
      const source = { status: response.status, requested: sourceIds.length };
      if (response.ok) {
        const json = await response.json();
        const contacts = (json?._embedded?.contacts || []).filter((c) => sourceIds.some((id) => String(id) === String(c.id)));
        source.found = contacts.length;
        source.visited = contacts.filter((c) => c.custom_fields_values?.find((f) => f.field_id === 842303)?.values?.[0]?.value === true).length;
        source.dateYears = {};
        source.sameMoscowDay = 0;
        source.differentMoscowDay = 0;
        source.latestTourMoscowDay = null;
        for (const c of contacts) {
          const raw = c.custom_fields_values?.find((f) => f.field_id === 842305)?.values?.[0]?.value;
          if (!raw) continue;
          const date = /^\d+$/.test(String(raw)) ? new Date(Number(raw) * 1000) : new Date(raw);
          if (!Number.isFinite(date.getTime())) continue;
          const key = moscowDay(date).slice(0, 4);
          source.dateYears[key] = (source.dateYears[key] || 0) + 1;
          const expected = sourceTours.find((b) => String(b.amoContactId) === String(c.id));
          if (expected?.brokerTourDate && moscowDay(expected.brokerTourDate) === moscowDay(date)) source.sameMoscowDay++;
          else source.differentMoscowDay++;
          if (date <= now && (!source.latestTourMoscowDay || moscowDay(date) > source.latestTourMoscowDay)) source.latestTourMoscowDay = moscowDay(date);
        }
      }
      result.amoSource = source;
    }
    const key = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const plaintext = JSON.stringify(privateEvidence, (_key, value) => typeof value === "bigint" ? value.toString() : value);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const encryptedKey = crypto.publicEncrypt({ key: auditPublicKey, oaepHash: "sha256" }, key);
    console.log("TOUR_AUDIT_PRIVATE " + JSON.stringify({ key: encryptedKey.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: ciphertext.toString("base64") }));
    console.log("TOUR_AUDIT_RESULT " + JSON.stringify(result));
  } finally { await prisma.$disconnect(); }
}
main().catch((error) => {
  console.error("TOUR_AUDIT_FAILED " + String(error?.code || error?.name || "unknown"));
  process.exitCode = 1;
});
