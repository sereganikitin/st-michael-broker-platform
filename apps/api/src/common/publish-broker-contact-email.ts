import { createHash } from "node:crypto";
import { Prisma, PrismaClient } from "@st-michael/database";
import { DEFAULT_OFFER } from "../offer/offer.service";
import { DEFAULT_PRIVACY } from "../privacy/privacy.service";
import {
  BROKER_CONTACT_EMAIL,
  CONTACT_EMAIL_TERMS_VERSION,
  LEGACY_BROKER_CONTACT_EMAIL,
  PREVIOUS_DEFAULT_TERMS_VERSION,
  normalizeLegacyContactBlock,
  replaceLegacyTermsContact,
} from "./broker-contact-email";
import {
  getArchivedLegalTerms,
  isLegalTermsRecord,
  LegalTermsRecord,
  sameLegalEdition,
} from "./legal-terms-archive";

const KEYS = ["contact", "offer_terms", "privacy_terms"] as const;
type ContentRow = { key: string; value: Prisma.JsonValue; updatedAt: Date };
type Change = {
  key: (typeof KEYS)[number];
  row?: ContentRow;
  previous?: any;
  next: any;
};

function stable(value: any): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function previousFallback(current: {
  version: string;
  title: string;
  body: string;
  updatedAt: string;
}): LegalTermsRecord {
  return {
    ...current,
    version: PREVIOUS_DEFAULT_TERMS_VERSION,
    body: current.body.replaceAll(
      BROKER_CONTACT_EMAIL,
      LEGACY_BROKER_CONTACT_EMAIL,
    ),
    updatedAt: "2026-06-15T00:00:00.000Z",
  };
}

function buildPlan(rows: ContentRow[], now: Date) {
  if (
    rows.some((row) => !KEYS.includes(row.key as any)) ||
    new Set(rows.map((row) => row.key)).size !== rows.length
  )
    throw new Error("PUBLICATION_ROWS_INVALID");
  const changes: Change[] = [];
  const map = new Map(rows.map((row) => [row.key, row]));
  const contact = map.get("contact");
  if (contact) {
    const next = normalizeLegacyContactBlock(contact.value);
    if (next !== contact.value)
      changes.push({
        key: "contact",
        row: contact,
        previous: contact.value,
        next,
      });
  }
  for (const key of ["offer_terms", "privacy_terms"] as const) {
    const row = map.get(key);
    const defaults = key === "offer_terms" ? DEFAULT_OFFER : DEFAULT_PRIVACY;
    const previous = row ? row.value : previousFallback(defaults);
    if (!isLegalTermsRecord(previous))
      throw new Error("PUBLICATION_TERMS_INVALID");
    const body = replaceLegacyTermsContact(previous.body);
    if (!body.includes(BROKER_CONTACT_EMAIL))
      throw new Error("PUBLICATION_CONTACT_MISSING");
    if (previous.version === CONTACT_EMAIL_TERMS_VERSION) {
      if (body !== previous.body)
        throw new Error("PUBLICATION_VERSION_CONFLICT");
      continue;
    }
    changes.push({
      key,
      row,
      previous,
      next: {
        ...previous,
        body,
        version: CONTACT_EMAIL_TERMS_VERSION,
        updatedAt: now.toISOString(),
      },
    });
  }
  const snapshot = KEYS.map((key) => {
    const row = map.get(key);
    return row
      ? { key, value: row.value, updatedAt: row.updatedAt.toISOString() }
      : { key, missing: true };
  });
  return {
    changes,
    hash: createHash("sha256").update(stable(snapshot)).digest("hex"),
    snapshot,
  };
}

async function archive(
  tx: Prisma.TransactionClient,
  key: (typeof KEYS)[number],
  value: any,
) {
  if (key !== "contact") {
    const existing = await getArchivedLegalTerms(tx, key, value.version);
    if (existing) {
      if (!sameLegalEdition(existing, value))
        throw new Error("PUBLICATION_ARCHIVE_CONFLICT");
      return;
    }
  }
  await tx.siteContentRevision.create({
    data: {
      key,
      value,
      editorId: null,
      editorName: "contact-email publication 2026-10-06",
    },
  });
  if (key !== "contact") {
    const readback = await getArchivedLegalTerms(tx, key, value.version);
    if (!readback || !sameLegalEdition(readback, value))
      throw new Error("PUBLICATION_ARCHIVE_READBACK_FAILED");
  }
}

/** Explicit operator operation only. Default is a read-only plan, never a startup hook.
 * APPLY requires the exact hash from a reviewed plan. No automatic retries.
 */
export async function publishBrokerContactEmail(
  prisma: PrismaClient,
  options: { apply?: boolean; expectedPlanHash?: string; now?: Date } = {},
) {
  if (options.apply && !/^[a-f0-9]{64}$/.test(options.expectedPlanHash || ""))
    throw new Error("PUBLICATION_PLAN_REQUIRED");
  const now = options.now || new Date();
  if (!Number.isFinite(now.getTime()))
    throw new Error("PUBLICATION_DATE_INVALID");
  return prisma.$transaction(
    async (tx) => {
      const rows = await tx.siteContent.findMany({
        where: { key: { in: [...KEYS] } },
      });
      const plan = buildPlan(rows, now);
      const summary = {
        version: CONTACT_EMAIL_TERMS_VERSION,
        planHash: plan.hash,
        changedKeys: plan.changes.map((change) => change.key),
        applied: false,
      };
      if (!options.apply) return summary;
      if (plan.hash !== options.expectedPlanHash)
        throw new Error("PUBLICATION_PLAN_CHANGED");
      for (const change of plan.changes) {
        await archive(tx, change.key, change.previous);
        if (change.row) {
          const result = await tx.siteContent.updateMany({
            where: { key: change.key, updatedAt: change.row.updatedAt },
            data: { value: change.next },
          });
          if (result.count !== 1) throw new Error("PUBLICATION_CAS_CONFLICT");
        } else {
          await tx.siteContent.create({
            data: { key: change.key, value: change.next },
          });
        }
        await archive(tx, change.key, change.next);
      }
      const readback = await tx.siteContent.findMany({
        where: { key: { in: [...KEYS] } },
      });
      const expected = new Map(rows.map((row) => [row.key, row.value]));
      for (const change of plan.changes) expected.set(change.key, change.next);
      if (
        readback.length !== expected.size ||
        readback.some(
          (row) =>
            !expected.has(row.key) ||
            stable(row.value) !== stable(expected.get(row.key)),
        )
      )
        throw new Error("PUBLICATION_READBACK_FAILED");
      for (const key of ["offer_terms", "privacy_terms"] as const) {
        const terms = readback.find((row) => row.key === key)?.value;
        if (
          !isLegalTermsRecord(terms) ||
          terms.version !== CONTACT_EMAIL_TERMS_VERSION
        )
          throw new Error("PUBLICATION_READBACK_FAILED");
        const edition = await getArchivedLegalTerms(tx, key, terms.version);
        if (!edition || !sameLegalEdition(edition, terms))
          throw new Error("PUBLICATION_ARCHIVE_READBACK_FAILED");
      }
      return { ...summary, applied: true };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      timeout: 15000,
    },
  );
}
