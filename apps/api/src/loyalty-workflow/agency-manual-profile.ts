import { isISO8601 } from "class-validator";
import { BadRequestException } from "@nestjs/common";

export const AGENCY_MANUAL_FIELDS: Record<string, number> = {
  agencySize: 32,
  website: 500,
  projectsOnSite: 1000,
  sitePlacementRequirements: 2000,
  lastAgencyMeetingDate: 10,
  agencyBtFormat: 160,
  agencyBtDate: 10,
  nextAgreement: 2000,
  nextAgreementDueAt: 40,
  specialTerms: 2000,
  specialTermsStatus: 160,
  specialTermsValidUntil: 10,
  partnershipLevel: 160,
  relationshipForm: 160,
};
const DATE_FIELDS = [
  "lastAgencyMeetingDate",
  "agencyBtDate",
  "specialTermsValidUntil",
];
export function normalizeAgencyManualPatch(
  input: unknown,
): Record<string, string | null> {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    !Object.keys(input).length
  )
    throw new BadRequestException("Укажите изменённые поля карточки");
  const result: Record<string, string | null> = {};
  for (const [key, raw] of Object.entries(input)) {
    if (
      !Object.prototype.hasOwnProperty.call(AGENCY_MANUAL_FIELDS, key) ||
      (raw !== null && typeof raw !== "string")
    )
      throw new BadRequestException("Недопустимое поле карточки");
    const value = typeof raw === "string" ? raw.trim() : null;
    if (value && value.length > AGENCY_MANUAL_FIELDS[key])
      throw new BadRequestException("Поле карточки слишком длинное");
    if (
      value &&
      key === "agencySize" &&
      !["Крупное", "Среднее", "Небольшое"].includes(value)
    )
      throw new BadRequestException("Выберите размер агентства");
    if (
      value &&
      DATE_FIELDS.includes(key) &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        !Number.isFinite(Date.parse(value)) ||
        new Date(value).toISOString().slice(0, 10) !== value)
    )
      throw new BadRequestException("Укажите корректную дату");
    if (
      value &&
      key === "nextAgreementDueAt" &&
      (!/(Z|[+-]\d{2}:\d{2})$/.test(value) ||
        !isISO8601(value, { strict: true }))
    )
      throw new BadRequestException(
        "Укажите время договорённости с часовым поясом",
      );
    if (value && key === "website") {
      try {
        const url = new URL(value);
        if (
          !["http:", "https:"].includes(url.protocol) ||
          !url.hostname ||
          url.username ||
          url.password
        )
          throw Error();
      } catch {
        throw new BadRequestException("Укажите адрес сайта http(s)");
      }
    }
    result[key] = value || null;
  }
  return result;
}

/** Manual facts retain their own provenance and never change the CRM snapshot. */
export function applyAgencyManualProjection(record: any, item: any): void {
  const raw = record?.manualProfile;
  const attributes =
    raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const selected: Record<string, string> = {};
  const updatedAt = record?.manualProfileUpdatedAt
    ? new Date(record.manualProfileUpdatedAt).toISOString()
    : null;
  const fieldSources = record?.manualProfileFieldSources || {};
  item.sourceProvenance = [...(item.provenance || [])];
  for (const field of Object.keys(AGENCY_MANUAL_FIELDS)) {
    const source = fieldSources[field];
    const fieldUpdatedAt = source?.updatedAt || null;
    if (typeof attributes[field] !== "string" || !attributes[field]) continue;
    selected[field] = attributes[field];
    item.attributes = { ...item.attributes, [field]: attributes[field] };
    item.fieldAvailability = {
      ...item.fieldAvailability,
      [field]: {
        status: "AVAILABLE",
        source: "MANUAL_CABINET",
        checkedAt: fieldUpdatedAt,
      },
    };
    item.provenance = [
      ...(item.provenance || []).filter((entry: any) => entry.field !== field),
      {
        field,
        source: "Кабинет · введено сотрудником",
        sourceType: "MANUAL_CABINET",
        updatedAt: fieldUpdatedAt,
        actorId: source?.actorId ?? null,
      },
    ];
  }
  item.manualProfile = {
    version: record?.manualProfileVersion ?? 1,
    attributes: selected,
    fieldSources,
    updatedAt,
    updatedById: record?.manualProfileUpdatedById ?? null,
  };
}
