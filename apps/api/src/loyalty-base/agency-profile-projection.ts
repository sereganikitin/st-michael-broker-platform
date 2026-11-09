const COMPANY_FIELDS: Record<string, number | null> = {
  agencySize: null,
  website: 557907,
  projectsOnSite: null,
  sitePlacementRequirements: null,
  lastAgencyMeetingDate: null,
  agencyBtFormat: null,
  agencyBtDate: null,
  lastContractDate: 842477,
  lastContractNumber: 842479,
  nextAgreement: null,
  specialTerms: null,
  specialTermsStatus: null,
  specialTermsValidUntil: null,
};

const iso = (value: unknown) => {
  if (!value) return null;
  const date = new Date(value as any);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};
const object = (value: unknown): Record<string, any> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
const numericIds = (value: unknown): string[] => Array.isArray(value)
  ? [...new Set(value.map(String).filter((id) => /^\d+$/.test(id)))].sort()
  : [];

/** Attach stored CRM evidence without making any CRM requests during page reads. */
export function applyAgencyCompanyProjection(record: any, item: any, now = new Date()) {
  const snapshot = record?.amoCompanySync;
  const profile = object(snapshot?.profile);
  const conflicts = object(snapshot?.conflicts);
  const sources = object(snapshot?.fieldSources);
  const lastSuccessAt = iso(snapshot?.lastSuccessAt);
  const companyIds = numericIds(snapshot?.companyIds);
  const status = snapshot?.errorCode ? "ERROR"
    : !lastSuccessAt ? "NOT_SYNCED"
      : now.getTime() - Date.parse(lastSuccessAt) > 36 * 60 * 60 * 1000 ? "STALE" : "CURRENT";
  item.sourceFreshness = {
    source: "AMOCRM_COMPANY", status,
    lastAttemptAt: iso(snapshot?.lastAttemptAt), lastSuccessAt,
    sourceUpdatedAt: iso(snapshot?.sourceUpdatedAt), companyIds,
    errorCode: snapshot?.errorCode ? String(snapshot.errorCode) : null,
  };
  item.attributes = { ...item.attributes, ...profile };
  item.attributes.brokerCount = item.metrics?.brokers ?? null;
  item.attributes.brokerCountScope = "CABINET_LINKS";
  item.fieldAvailability = {};
  for (const [field, fieldId] of Object.entries(COMPANY_FIELDS)) {
    const value = item.attributes[field];
    const availability = conflicts[field] ? "CONFLICT"
      : value !== null && value !== undefined && value !== "" ? "AVAILABLE"
        : !lastSuccessAt ? "NOT_SYNCED"
          : fieldId === null ? "FIELD_NOT_IN_SOURCE" : "EMPTY_IN_SOURCE";
    item.fieldAvailability[field] = { status: availability, source: "AMOCRM_COMPANY", checkedAt: lastSuccessAt };
  }
  const subdomain = /^[a-z0-9-]+$/i.test(process.env.AMO_SUBDOMAIN || "")
    ? process.env.AMO_SUBDOMAIN : "stmichael";
  item.provenance = Object.entries(sources).map(([field, raw]) => {
    const source = object(raw);
    const ids = numericIds(source.companyIds);
    return {
      field, source: `amoCRM · компании ${ids.map((id) => `#${id}`).join(", ")} · поле #${source.fieldId}`,
      updatedAt: lastSuccessAt || iso(source.checkedAt),
      sourceUpdatedAt: iso(source.sourceUpdatedAt), checkedAt: lastSuccessAt,
      sourceUrl: ids.length ? `https://${subdomain}.amocrm.ru/companies/detail/${ids[0]}` : null,
    };
  });
  item.provenance.push({ field: "brokerCount", source: "Кабинет · текущие подтверждённые связи брокеров с агентством", updatedAt: now.toISOString(), checkedAt: now.toISOString() });
  item.agreementHistory = Array.isArray(snapshot?.contracts) ? snapshot.contracts : [];
}
