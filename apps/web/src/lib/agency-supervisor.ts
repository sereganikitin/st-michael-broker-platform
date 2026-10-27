export type SupervisorFilters = {
  from: string;
  to: string;
  assigneeId: string;
  campaignId: string;
  agencyId: string;
  agencyType: string;
};
export const moscowDay = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
export function supervisorQuery(filters: SupervisorFilters) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(filters.from) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(filters.to) ||
    filters.to < filters.from
  )
    throw new Error("Укажите корректный период: конец не раньше начала");
  const end = new Date(`${filters.to}T00:00:00+03:00`);
  end.setTime(end.getTime() + 86400000);
  const query = new URLSearchParams({
    from: `${filters.from}T00:00:00+03:00`,
    to: end.toISOString(),
  });
  for (const key of [
    "assigneeId",
    "campaignId",
    "agencyId",
    "agencyType",
  ] as const)
    if (filters[key]) query.set(key, filters[key]);
  return query.toString();
}
export const overdueDuration = (minutes: number) =>
  minutes >= 1440
    ? `${Math.floor(minutes / 1440)} д ${Math.floor((minutes % 1440) / 60)} ч`
    : minutes >= 60
      ? `${Math.floor(minutes / 60)} ч ${minutes % 60} мин`
      : `${minutes} мин`;
export const supervisorDate = (value: string) =>
  new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
export type StaffName = { id: string; fullName: string };
export type OverdueTask = {
  id: string;
  version: number;
  agencyId: string;
  agencyName: string;
  title: string;
  kind: string;
  dueAt: string;
  assignedTo: StaffName;
  overdueMinutes: number;
  reasons: Array<{
    id: string;
    reason: string;
    version: number;
    actor: StaffName;
    createdAt: string;
  }>;
};
export type SupervisorReport = {
  currentUserId: string;
  permissions: string[];
  role: string;
  generatedAt: string;
  attemptDates?: Record<string, { callOccurredAt: string; recordedAt: string }>;
  source: {
    loadedAt: string;
    stale: boolean;
    pendingReviewCount: number;
    newCount: number;
    reviewCount: number;
  };
  period: { from: string; to: string };
  cards: Array<{
    id: string;
    name: string;
    type: string;
    attempts: Array<{
      id: string;
      result: string;
      comment: string;
      occurredAt: string;
    }>;
    tasks: Array<{ id: string; title: string; dueAt: string; status: string }>;
  }>;
  filterOptions: {
    agencies: Array<{ id: string; name: string }>;
    campaigns: Array<{ id: string; name: string }>;
  };
  operators: Array<{ id: string; name: string }>;
  metrics: {
    attempts: number;
    assignedAgencies: number;
    attemptedAgencies: number;
    agreements: number;
    tasksDue: number;
    tasksOnTime: number;
    overdue: number;
  };
  evidence: Record<
    string,
    Array<{ agencyId: string; eventId: string; kind: string }>
  >;
  rates: Array<{
    key: string;
    title: string;
    numerator: number;
    denominator: number;
    ratio: number | null;
    numeratorKey: string;
    denominatorKey: string;
    explanation: string;
  }>;
  quality: Record<string, string[]>;
  workload: Array<{
    id: string;
    name: string;
    open: number;
    overdue: number;
    attempts: number;
    types: Record<string, number>;
    withoutPhone: number;
  }>;
  overdue: OverdueTask[];
  exclusions: { tasksWithoutDueDate: number; cancelledTasksInPeriod: number };
  qaSample: Array<{
    agencyId: string;
    agencyName: string;
    attemptId: string;
    result: string;
    comment: string;
    occurredAt: string;
    operator: StaffName;
    review: {
      id: string;
      version: number;
      reviewer: StaffName;
      createdAt: string;
    } | null;
  }>;
};
