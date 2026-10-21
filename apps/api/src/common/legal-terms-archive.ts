import { Prisma, PrismaClient } from "@st-michael/database";

export type LegalTermsRecord = Record<string, unknown> & {
  version: string;
  title: string;
  body: string;
  updatedAt: string;
};

export function isLegalTermsRecord(value: unknown): value is LegalTermsRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const terms = value as LegalTermsRecord;
  return (
    [terms.version, terms.title, terms.body, terms.updatedAt].every(
      (item) => typeof item === "string" && Boolean(item.trim()),
    ) &&
    terms.version.length <= 128 &&
    Number.isFinite(Date.parse(terms.updatedAt))
  );
}

export function sameLegalEdition(
  a: LegalTermsRecord,
  b: LegalTermsRecord,
): boolean {
  return a.version === b.version && a.title === b.title && a.body === b.body;
}

/** Lookup only an acceptance-bound version; never substitute another edition. */
export async function getArchivedLegalTerms(
  prisma: PrismaClient | Prisma.TransactionClient,
  key: "offer_terms" | "privacy_terms",
  version: string,
): Promise<LegalTermsRecord | null> {
  if (typeof version !== "string" || !version.trim() || version.length > 128)
    throw new Error("ARCHIVED_TERMS_INVALID");
  const rows = await prisma.siteContentRevision.findMany({
    where: { key, value: { path: ["version"], equals: version } },
    orderBy: { createdAt: "desc" },
  });
  if (!rows.length) return null;
  const values = rows.map((row) => row.value);
  if (
    values.some(
      (value) => !isLegalTermsRecord(value) || value.version !== version,
    )
  )
    throw new Error("ARCHIVED_TERMS_INVALID");
  const first = values[0] as LegalTermsRecord;
  if (
    values.some((value) => !sameLegalEdition(first, value as LegalTermsRecord))
  )
    throw new Error("ARCHIVED_TERMS_AMBIGUOUS");
  return first;
}
