export const AMO_UNIQUENESS_QUEUE = "amo-uniqueness";
export const AMO_UNIQUENESS_JOB_OPTIONS = {
  attempts: 8,
  backoff: { type: "exponential", delay: 15_000 },
  removeOnComplete: true,
  removeOnFail: 1000,
};

export const SALES_MEETING_EXCEPTION_PREFIX = "EXCEPTION_AFTER_SALES_MEETING:";
export function salesMeetingConflictLeadId(reason: unknown): number | null {
  if (typeof reason !== "string") return null;
  const match = /^EXCEPTION_AFTER_SALES_MEETING:([1-9]\d*)(?:\s|$)/.exec(
    reason,
  );
  const id = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(id) ? id : null;
}
