import type { PrismaClient } from "@st-michael/database";
import { normalizeAmoFixationClientPhone } from "@st-michael/integrations";

/** Only for phone-based delegated fixation routing, never login or self-ownership. */
export async function findLatestFixationBrokerId(
  prisma: Pick<PrismaClient, "$queryRaw">,
  phone: string,
): Promise<string | null> {
  const normalized = normalizeAmoFixationClientPhone(phone).slice(1);
  const rows = await prisma.$queryRaw<
    Array<{ id: string; role: string; status: string }>
  >`
    WITH numbers AS (
      SELECT "id" AS "broker_id", regexp_replace("phone", '[^0-9]', '', 'g') AS digits
      FROM "brokers"
      UNION ALL
      SELECT "broker_id", regexp_replace("phone", '[^0-9]', '', 'g') AS digits
      FROM "broker_phones"
    ), matched AS (
      SELECT DISTINCT CASE WHEN source."role" = 'BROKER'
        THEN COALESCE(source."merged_into_id", source."id") ELSE source."id" END AS id
      FROM numbers
      JOIN "brokers" source ON source."id" = numbers."broker_id"
      WHERE CASE
        WHEN length(digits) = 10 THEN '7' || digits
        WHEN length(digits) = 11 AND left(digits, 1) = '8' THEN '7' || right(digits, 10)
        WHEN length(digits) = 12 AND left(digits, 2) = '77' THEN right(digits, 11)
        ELSE digits
      END = ${normalized}
    )
    SELECT matched.id AS id,
      CASE WHEN target."id" IS NULL OR target."merged_into_id" IS NOT NULL
        THEN 'UNRESOLVED' ELSE target."role"::text END AS role,
      COALESCE(target."status"::text, 'BLOCKED') AS status
    FROM matched
    LEFT JOIN "brokers" target ON target."id" = matched.id
    ORDER BY target."created_at" DESC, target."id" DESC
    LIMIT 21
  `;
  if (
    !Array.isArray(rows) ||
    rows.length > 20 ||
    new Set(rows.map((row) => row?.id)).size !== rows.length ||
    rows.some(
      (row) =>
        !row ||
        typeof row.id !== "string" ||
        !row.id ||
        !["BROKER", "MANAGER", "ADMIN"].includes(row.role) ||
        !["ACTIVE", "PENDING", "BLOCKED"].includes(row.status),
    )
  )
    throw new Error("FIXATION_BROKER_PHONE_CANDIDATES_INVALID");
  // An unresolved merge chain or dangling target has role UNRESOLVED above:
  // it is not absence and must never let the caller create another card.
  // A staff identity is not a broker destination. Never create a new card
  // over a staff phone or grant its cabinet access through this resolver.
  const brokers = rows.filter((row) => row.role === "BROKER");
  const eligible = brokers.find((row) => row.status !== "BLOCKED");
  if (eligible) return eligible.id;
  if (brokers.length) return brokers[0].id; // Existing blocked-card error remains.
  if (rows.length) throw new Error("FIXATION_BROKER_PHONE_IS_STAFF");
  return null;
}
