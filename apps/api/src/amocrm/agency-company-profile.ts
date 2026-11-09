export interface AgencyCompanyFieldSource {
  source: "AMOCRM_COMPANY";
  companyIds: string[];
  fieldId: number;
  sourceUpdatedAt: string | null;
  checkedAt: string;
}

export interface AgencyCompanyFieldConflict {
  reason: "DIFFERENT_VALUES";
  candidates: Array<AgencyCompanyFieldSource & { value: unknown }>;
}

export interface AgencyCompanyContract {
  companyId: string;
  date: string | null;
  number: string | null;
  dateCandidates: string[];
  numberCandidates: string[];
  invalidDate: boolean;
  ambiguousDate: boolean;
  isFuture: boolean;
  sourceUpdatedAt: string | null;
  checkedAt: string;
}

export interface AgencyCompanyProfileResolution {
  companyIds: string[];
  status: "LINKED" | "NOT_FOUND" | "CONFLICT";
  profile: Record<string, unknown>;
  fieldSources: Record<string, AgencyCompanyFieldSource>;
  conflicts: Record<string, AgencyCompanyFieldConflict>;
  contracts: AgencyCompanyContract[];
  sourceUpdatedAt: string | null;
}

const INN_FIELD = 663911;
const CONTRACT_DATE_FIELD = 842477;
const CONTRACT_NUMBER_FIELD = 842479;
const unique = (values: string[]) => [...new Set(values)].sort();
const newest = (values: Array<string | null>) =>
  values
    .filter((value): value is string => value !== null)
    .sort()
    .at(-1) || null;
const text = (value: unknown) =>
  typeof value === "string" ||
  (typeof value === "number" && Number.isFinite(value))
    ? String(value).trim().replace(/\s+/g, " ") || null
    : null;
const normalizeInn = (value: unknown) => (text(value) || "").replace(/\D/g, "");

function fieldValues(company: any, fieldId: number): unknown[] {
  if (!Array.isArray(company?.custom_fields_values)) return [];
  return company.custom_fields_values
    .filter((field: any) => Number(field?.field_id) === fieldId)
    .flatMap((field: any) =>
      Array.isArray(field?.values)
        ? field.values.map((entry: any) => entry?.value)
        : [],
    );
}

function validDay(year: number, month: number, day: number): boolean {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    year >= 1 &&
    year <= 9999 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= days[month - 1]
  );
}

function parseInstant(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? new Date(value) : null;
  }
  const raw = text(value);
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const timestamp = Number(raw);
    const date = new Date(
      timestamp >= 100_000_000_000 ? timestamp : timestamp * 1000,
    );
    return Number.isFinite(date.getTime()) ? date : null;
  }
  const iso =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-](\d{2}):(\d{2}))$/.exec(
      raw,
    );
  if (
    !iso ||
    !validDay(+iso[1], +iso[2], +iso[3]) ||
    +iso[4] > 23 ||
    +iso[5] > 59 ||
    +(iso[6] || 0) > 59 ||
    +(iso[8] || 0) > 23 ||
    +(iso[9] || 0) > 59
  )
    return null;
  const date = new Date(raw);
  return Number.isFinite(date.getTime()) ? date : null;
}

function moscowDay(date: Date): string {
  return new Date(date.getTime() + 3 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

function dateValue(value: unknown): string | null {
  const raw = text(value);
  const isoDay = raw && /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  const ruDay = raw && /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(raw);
  if (isoDay) return validDay(+isoDay[1], +isoDay[2], +isoDay[3]) ? raw : null;
  if (ruDay)
    return validDay(+ruDay[3], +ruDay[2], +ruDay[1])
      ? `${ruDay[3]}-${ruDay[2]}-${ruDay[1]}`
      : null;
  const instant = parseInstant(value);
  return instant ? moscowDay(instant) : null;
}

function websiteValue(value: unknown): string | null {
  const raw = text(value);
  if (!raw || /\s/.test(raw) || /^[/.?#]/.test(raw)) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  if (hasScheme && !/^https?:\/\//i.test(raw)) return null;
  if (!hasScheme && !raw.split(/[/?#]/)[0].includes(".")) return null;
  try {
    const url = new URL(hasScheme ? raw : `https://${raw}`);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

interface FieldCandidate {
  value: unknown;
  companyId: string;
  sourceUpdatedAt: string | null;
}

const contractIdentity = (contract: AgencyCompanyContract) =>
  JSON.stringify({ ...contract, sourceUpdatedAt: null });

/** Resolve only exact-INN company evidence. Empty duplicates never erase values. */
export function resolveAgencyCompanyProfile(
  inn: string,
  companies: any[],
  checkedAt: Date,
): AgencyCompanyProfileResolution {
  if (!Number.isFinite(checkedAt.getTime()))
    throw new RangeError("Invalid checkedAt");
  const checkedAtIso = checkedAt.toISOString();
  const today = moscowDay(checkedAt);
  const normalizedInn = normalizeInn(inn);
  const matched = (Array.isArray(companies) ? companies : [])
    .filter(
      (company) =>
        text(company?.id) &&
        /^\d{10}$|^\d{12}$/.test(normalizedInn) &&
        fieldValues(company, INN_FIELD).some(
          (value) => normalizeInn(value) === normalizedInn,
        ),
    )
    .map((company) => ({
      company,
      companyId: text(company.id)!,
      sourceUpdatedAt: parseInstant(company.updated_at)?.toISOString() || null,
    }));
  const result: AgencyCompanyProfileResolution = {
    companyIds: unique(matched.map((entry) => entry.companyId)),
    status: matched.length ? "LINKED" : "NOT_FOUND",
    profile: {
      _sourceInn: normalizedInn,
      website: null,
      companyType: null,
      industry: null,
      relationshipForm: null,
      legalStatus: null,
      legalDataAsOf: null,
      lastContractDate: null,
      lastContractNumber: null,
    },
    fieldSources: {},
    conflicts: {},
    contracts: [],
    sourceUpdatedAt: newest(matched.map((entry) => entry.sourceUpdatedAt)),
  };
  const resolveField = (
    key: string,
    fieldId: number,
    candidates: FieldCandidate[],
  ) => {
    const groups = new Map<string, FieldCandidate[]>();
    for (const candidate of candidates) {
      const identity = JSON.stringify(candidate.value);
      const group = groups.get(identity) || [];
      group.push(candidate);
      groups.set(identity, group);
    }
    const values = [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, group]) => ({
        value: group[0].value,
        source: "AMOCRM_COMPANY" as const,
        companyIds: unique(group.map((candidate) => candidate.companyId)),
        fieldId,
        sourceUpdatedAt: newest(
          group.map((candidate) => candidate.sourceUpdatedAt),
        ),
        checkedAt: checkedAtIso,
      }));
    if (values.length > 1) {
      result.conflicts[key] = {
        reason: "DIFFERENT_VALUES",
        candidates: values,
      };
      result.status = "CONFLICT";
    } else if (values.length === 1) {
      const { value, ...source } = values[0];
      result.profile[key] = value;
      result.fieldSources[key] = source;
    }
  };

  const scalarFields: Array<[string, number, (value: unknown) => unknown]> = [
    ["website", 557907, websiteValue],
    ["companyType", 558641, text],
    ["relationshipForm", 558649, text],
    ["legalStatus", 663927, text],
    ["legalDataAsOf", 663925, dateValue],
  ];
  for (const [key, fieldId, normalize] of scalarFields) {
    resolveField(
      key,
      fieldId,
      matched.flatMap((entry) =>
        fieldValues(entry.company, fieldId)
          .map(normalize)
          .filter((value) => value !== null)
          .map((value) => ({
            value,
            companyId: entry.companyId,
            sourceUpdatedAt: entry.sourceUpdatedAt,
          })),
      ),
    );
  }
  resolveField(
    "industry",
    558645,
    matched.flatMap((entry) => {
      const value = unique(
        fieldValues(entry.company, 558645)
          .map(text)
          .filter((v): v is string => v !== null),
      );
      return value.length
        ? [
            {
              value,
              companyId: entry.companyId,
              sourceUpdatedAt: entry.sourceUpdatedAt,
            },
          ]
        : [];
    }),
  );

  const history = new Map<string, AgencyCompanyContract>();
  for (const entry of matched) {
    const dates = fieldValues(entry.company, CONTRACT_DATE_FIELD).filter(
      (value) => value instanceof Date || text(value) !== null,
    );
    const numbers = unique(
      fieldValues(entry.company, CONTRACT_NUMBER_FIELD)
        .map(text)
        .filter((value): value is string => value !== null),
    );
    if (!dates.length && !numbers.length) continue;
    const dateCandidates = unique(
      dates.map(dateValue).filter((value): value is string => value !== null),
    );
    const invalidDate = dates.some((value) => dateValue(value) === null);
    const contract: AgencyCompanyContract = {
      companyId: entry.companyId,
      date:
        dateCandidates.length === 1 && !invalidDate ? dateCandidates[0] : null,
      number: numbers.length === 1 ? numbers[0] : null,
      dateCandidates,
      numberCandidates: numbers,
      invalidDate,
      ambiguousDate: dateCandidates.length > 1,
      isFuture: dateCandidates.some((value) => value > today),
      sourceUpdatedAt: entry.sourceUpdatedAt,
      checkedAt: checkedAtIso,
    };
    const identity = contractIdentity(contract);
    const previous = history.get(identity);
    contract.sourceUpdatedAt = newest([
      previous?.sourceUpdatedAt || null,
      contract.sourceUpdatedAt,
    ]);
    history.set(identity, contract);
  }
  result.contracts = [...history.values()].sort(
    (a, b) =>
      (b.date || "").localeCompare(a.date || "") ||
      a.companyId.localeCompare(b.companyId) ||
      contractIdentity(a).localeCompare(contractIdentity(b)),
  );
  const eligible = result.contracts.filter(
    (contract) => contract.date && !contract.isFuture,
  );
  const lastDate = newest(eligible.map((contract) => contract.date));
  const latest = eligible.filter((contract) => contract.date === lastDate);
  resolveField(
    "lastContractDate",
    CONTRACT_DATE_FIELD,
    latest.map((contract) => ({
      value: contract.date,
      companyId: contract.companyId,
      sourceUpdatedAt: contract.sourceUpdatedAt,
    })),
  );
  resolveField(
    "lastContractNumber",
    CONTRACT_NUMBER_FIELD,
    latest.flatMap((contract) =>
      contract.numberCandidates.map((value) => ({
        value,
        companyId: contract.companyId,
        sourceUpdatedAt: contract.sourceUpdatedAt,
      })),
    ),
  );
  return result;
}
