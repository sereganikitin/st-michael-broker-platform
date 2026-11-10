import {
  contactDateFromInput,
  contactDateToInput,
} from "./moscow-contact-date";
import { safeLoyaltyHttpUrl } from "./loyalty-base-api";

export const AGENCY_PROFILE_FIELDS = [
  { key: "agencySize", label: "Размер агентства", kind: "size", max: 40 },
  { key: "website", label: "Сайт", kind: "url", max: 500 },
  {
    key: "projectsOnSite",
    label: "Размещение проектов",
    kind: "text",
    max: 1000,
  },
  {
    key: "sitePlacementRequirements",
    label: "Требования для размещения",
    kind: "text",
    max: 2000,
  },
  {
    key: "lastAgencyMeetingDate",
    label: "Последняя встреча",
    kind: "date",
    max: 10,
  },
  {
    key: "agencyBtFormat",
    label: "Индивидуальный / выездной БТ",
    kind: "text",
    max: 160,
  },
  { key: "agencyBtDate", label: "Дата БТ", kind: "date", max: 10 },
  {
    key: "nextAgreement",
    label: "Следующая договорённость",
    kind: "text",
    max: 2000,
  },
  {
    key: "nextAgreementDueAt",
    label: "Срок договорённости, МСК",
    kind: "datetime-local",
    max: 40,
  },
  {
    key: "specialTerms",
    label: "Специальные условия",
    kind: "text",
    max: 2000,
  },
  {
    key: "specialTermsStatus",
    label: "Статус специальных условий",
    kind: "text",
    max: 160,
  },
  {
    key: "specialTermsValidUntil",
    label: "Условия действуют до",
    kind: "date",
    max: 10,
  },
  {
    key: "partnershipLevel",
    label: "Уровень партнёрства",
    kind: "text",
    max: 160,
  },
  { key: "relationshipForm", label: "Форма отношений", kind: "text", max: 160 },
] as const;
export type AgencyProfileKey = (typeof AGENCY_PROFILE_FIELDS)[number]["key"];
export type AgencyProfileValues = Record<AgencyProfileKey, string>;
export type AgencyManualProfile = {
  version: number;
  attributes: Partial<Record<AgencyProfileKey, string | null>>;
  updatedAt: string | null;
  updatedById: string | null;
};

export function agencyProfileValues(
  attributes: Record<string, unknown>,
): AgencyProfileValues {
  return Object.fromEntries(
    AGENCY_PROFILE_FIELDS.map((field) => {
      const value =
        typeof attributes[field.key] === "string"
          ? String(attributes[field.key])
          : "";
      return [
        field.key,
        field.kind === "datetime-local" ? contactDateToInput(value) : value,
      ];
    }),
  ) as AgencyProfileValues;
}

export function agencyProfilePatch(
  values: AgencyProfileValues,
  baseline: AgencyProfileValues,
  resets: AgencyProfileKey[] = [],
): Partial<Record<AgencyProfileKey, string | null>> {
  const result: Partial<Record<AgencyProfileKey, string | null>> = {};
  for (const field of AGENCY_PROFILE_FIELDS) {
    if (resets.includes(field.key)) {
      result[field.key] = null;
      continue;
    }
    const value = values[field.key].trim();
    if (value === baseline[field.key].trim()) continue;
    if (value.length > field.max)
      throw new Error(`Слишком длинное значение поля «${field.label}»`);
    if (value && field.kind === "url" && !safeLoyaltyHttpUrl(value))
      throw new Error("Укажите полный адрес сайта с http:// или https://");
    result[field.key] = value
      ? field.kind === "datetime-local"
        ? contactDateFromInput(value)
        : value
      : null;
    if (value && field.kind === "datetime-local" && !result[field.key])
      throw new Error("Проверьте срок договорённости");
  }
  return result;
}
