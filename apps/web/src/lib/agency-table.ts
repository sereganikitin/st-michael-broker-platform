export type AgencySortKey =
  | "name"
  | "status"
  | "source"
  | "baseline"
  | "added"
  | "total";
export const AGENCY_COLUMN_KEYS: AgencySortKey[] = [
  "name",
  "status",
  "source",
  "baseline",
  "added",
  "total",
];
export function agencyVisibleColumns(value: unknown): AgencySortKey[] {
  if (!Array.isArray(value)) return [...AGENCY_COLUMN_KEYS];
  return AGENCY_COLUMN_KEYS.filter(
    (key) => key === "name" || value.includes(key),
  );
}
type Period = {
  tab: string;
  row: number;
  baselineRub: string;
  addedRub: string;
  totalRub: string;
  baselineScope?: string;
  fields?: Array<{ label: string; value: string }>;
};
type Agency = {
  key: string;
  name: string;
  type: string;
  status: string;
  periods: Period[];
  matchedAgency: { name: string } | null;
};
export type AgencyTableOptions = {
  search: string;
  type: string;
  status: string;
  source: string;
  sort: AgencySortKey | null;
  direction: "asc" | "desc";
};
const normalized = (text: string) =>
  text
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("ru-RU");
const textCompare = (a: string, b: string) =>
  a.localeCompare(b, "ru", { numeric: true, sensitivity: "base" });
function cents(value: string): bigint {
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(value))
    throw new Error("Invalid money value");
  const [whole, fraction = ""] = value.replace(/^-/, "").split(".");
  return (
    (BigInt(whole) * BigInt(100) + BigInt(fraction.padEnd(2, "0"))) *
    (value.startsWith("-") ? BigInt(-1) : BigInt(1))
  );
}
export function agencyTableRows<T extends Agency>(
  items: T[],
  options: AgencyTableOptions,
) {
  const query = normalized(options.search);
  const rows = items
    .flatMap((item) => item.periods.map((period) => ({ item, period })))
    .map((row, order) => ({
      ...row,
      order,
      rowKey: `${row.item.key}:${row.period.tab}:${row.period.row}`,
    }))
    .filter(
      ({ item, period }) =>
        (!query ||
          normalized(
            item.name + " " + (item.matchedAgency?.name || ""),
          ).includes(query)) &&
        (!options.type || item.type === options.type) &&
        (!options.status || item.status === options.status) &&
        (!options.source || period.tab === options.source),
    );
  if (!options.sort) return rows;
  const key = options.sort;
  return rows.sort((a, b) => {
    let compared = 0;
    if (key === "name") compared = textCompare(a.item.name, b.item.name);
    else if (key === "status") {
      const labels: Record<string, string> = {
        MATCHED: "Сопоставлено",
        REVIEW: "На проверке",
        NEW: "Нет в текущей базе",
      };
      compared = textCompare(
        labels[a.item.status] || a.item.status,
        labels[b.item.status] || b.item.status,
      );
    } else if (key === "source")
      compared =
        textCompare(a.period.tab, b.period.tab) || a.period.row - b.period.row;
    else {
      const field = {
        baseline: "baselineRub",
        added: "addedRub",
        total: "totalRub",
      }[key] as "baselineRub" | "addedRub" | "totalRub";
      const av = cents(a.period[field]),
        bv = cents(b.period[field]);
      compared = av < bv ? -1 : av > bv ? 1 : 0;
    }
    return (
      compared * (options.direction === "asc" ? 1 : -1) || a.order - b.order
    );
  });
}
