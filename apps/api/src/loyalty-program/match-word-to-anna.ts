export type AnnaCatalogEntry = {
  id: string;
  entityType: "AGENCY" | "BROKER";
  names: string[];
};

export type MatchStatus = "AUTO" | "AMBIGUOUS" | "UNMATCHED";

export type NameMatch = {
  partnerKey: string;
  status: MatchStatus;
  candidates: Array<{
    id: string;
    entityType: "AGENCY" | "BROKER";
    name: string;
  }>;
};

const STOP = new Set([
  "ооо",
  "ао",
  "зао",
  "ип",
  "llc",
  "ltd",
  "агентство",
  "недвижимости",
  "недвижимость",
  "эстейт",
  "estate",
  "group",
  "групп",
  "ан",
]);

/** Short tokens that collide across several Anna cards — never auto-match. */
const AMBIGUOUS_TOKENS = new Set(["prime", "прайм"]);

export function normalizePartnerName(value: string): string {
  return String(value || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[«»"'`().,+/\\-]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 0 && !STOP.has(token))
    .join(" ")
    .trim();
}

function tokens(value: string): string[] {
  return normalizePartnerName(value)
    .split(" ")
    .filter((token) => token.length >= 2 && !STOP.has(token));
}

function indexCatalog(catalog: AnnaCatalogEntry[]) {
  const exact = new Map<string, AnnaCatalogEntry[]>();
  for (const entry of catalog) {
    const keys = new Set(
      entry.names.map(normalizePartnerName).filter((name) => name.length >= 2),
    );
    for (const key of keys) {
      const list = exact.get(key) || [];
      list.push(entry);
      exact.set(key, list);
    }
  }
  return exact;
}

function uniqueEntries(entries: AnnaCatalogEntry[]): AnnaCatalogEntry[] {
  const seen = new Set<string>();
  const out: AnnaCatalogEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push(entry);
  }
  return out;
}

function toCandidates(entries: AnnaCatalogEntry[]) {
  return uniqueEntries(entries).map((entry) => ({
    id: entry.id,
    entityType: entry.entityType,
    name: entry.names[0] || entry.id,
  }));
}

/**
 * Glue a Word partner name onto Anna cards.
 * Unique exact / alias hit → AUTO.
 * Several plausible cards (PRIME / Прайм) → AMBIGUOUS, left for the UI.
 * Agencies are preferred over brokers when both match uniquely.
 */
export function matchPartnerName(
  partnerKey: string,
  partnerName: string,
  catalog: AnnaCatalogEntry[],
): NameMatch {
  const normalized = normalizePartnerName(partnerName);
  if (!normalized) {
    return { partnerKey, status: "UNMATCHED", candidates: [] };
  }

  const exact = indexCatalog(catalog);
  const exactHits = uniqueEntries(exact.get(normalized) || []);
  if (exactHits.length === 1) {
    return {
      partnerKey,
      status: "AUTO",
      candidates: toCandidates(exactHits),
    };
  }
  if (exactHits.length > 1) {
    return {
      partnerKey,
      status: "AMBIGUOUS",
      candidates: toCandidates(exactHits),
    };
  }

  const partnerTokens = tokens(partnerName);
  if (partnerTokens.some((token) => AMBIGUOUS_TOKENS.has(token))) {
    const loose: AnnaCatalogEntry[] = [];
    for (const entry of catalog) {
      const hay = entry.names.map(normalizePartnerName).join(" ");
      if (partnerTokens.some((token) => hay.split(" ").includes(token))) {
        loose.push(entry);
      }
    }
    const uniq = uniqueEntries(loose);
    return {
      partnerKey,
      status: uniq.length === 1 ? "AUTO" : uniq.length > 1 ? "AMBIGUOUS" : "UNMATCHED",
      candidates: toCandidates(uniq),
    };
  }

  const scored: Array<{ entry: AnnaCatalogEntry; score: number }> = [];
  for (const entry of catalog) {
    const entryTokens = new Set(entry.names.flatMap((name) => tokens(name)));
    const overlap = partnerTokens.filter((token) => entryTokens.has(token));
    if (!overlap.length) continue;
    const nameHay = entry.names.map(normalizePartnerName).join(" | ");
    const contains =
      (normalized.length >= 4 && nameHay.includes(normalized)) ||
      entry.names.some((name) => {
        const n = normalizePartnerName(name);
        return n.length >= 4 && normalized.includes(n);
      });
    scored.push({
      entry,
      score: overlap.length * 10 + (contains ? 50 : 0) + (entry.entityType === "AGENCY" ? 1 : 0),
    });
  }

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best) {
    return { partnerKey, status: "UNMATCHED", candidates: [] };
  }
  const top = scored.filter((row) => row.score === best.score).map((row) => row.entry);
  const uniq = uniqueEntries(top);
  if (uniq.length === 1 && (best.score >= 50 || partnerTokens.length <= 2)) {
    return { partnerKey, status: "AUTO", candidates: toCandidates(uniq) };
  }
  if (uniq.length > 1) {
    return {
      partnerKey,
      status: "AMBIGUOUS",
      candidates: toCandidates(uniq.slice(0, 8)),
    };
  }
  if (best.score >= 50) {
    return { partnerKey, status: "AUTO", candidates: toCandidates(uniq) };
  }
  return {
    partnerKey,
    status: "UNMATCHED",
    candidates: toCandidates(scored.slice(0, 5).map((row) => row.entry)),
  };
}

export function matchAllPartners(
  partners: Array<{ key: string; name: string }>,
  catalog: AnnaCatalogEntry[],
): NameMatch[] {
  return partners.map((partner) =>
    matchPartnerName(partner.key, partner.name, catalog),
  );
}
