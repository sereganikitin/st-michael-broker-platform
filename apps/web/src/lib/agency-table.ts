type CoreKey = "name" | "status" | "source" | "baseline" | "added" | "total";
export type AgencySortKey = CoreKey | `field:${string}`;
export const AGENCY_DEFAULT_KEYS: AgencySortKey[] = [
  "name",
  "status",
  "source",
  "baseline",
  "added",
  "total",
];
export const AGENCY_COLUMNS: Array<{
  key: AgencySortKey;
  title: string;
  kind: "text" | "number" | "date";
}> = [
  ...AGENCY_DEFAULT_KEYS.map((key) => ({
    key,
    title: (
      {
        name: "Агентство / агрегатор",
        status: "Сопоставление",
        source: "Источник",
        baseline: "База, ₽",
        added: "Добавлено, ₽",
        total: "Итог, ₽",
      } as Record<string, string>
    )[key],
    kind: (["baseline", "added", "total"].includes(key) ? "number" : "text") as
      | "text"
      | "number",
  })),
  ...(
    [
      ["B", "Приоритет", "text"],
      ["E", "Скрипт звонка", "text"],
      ["F", "Номер телефона", "text"],
      ["G", "Имя агента", "text"],
      ["H", "Дата звонка", "date"],
      ["I", "Статус контакта", "text"],
      ["J", "Ответственный менеджер", "text"],
      ["K", "Следующий контакт", "date"],
      ["L", "Результат / комментарий", "text"],
      ["M", "Публикация на сайте", "text"],
      ["N", "Что нужно для размещения на сайте", "text"],
      ["O", "Выездной БТ — результат", "text"],
      ["P", "Последний ДДУ", "date"],
      ["T", "Условия комиссии из таблицы", "number"],
      ["U", "Текущая комиссия", "number"],
      ["V", "Следующая комиссия", "number"],
      ["W", "До следующего шага, млн ₽", "number"],
      ["X", "Комиссия сообщена брокеру", "number"],
      ["Y", "Сигнал отдела", "text"],
    ] as const
  ).map(([column, title, kind]) => ({
    key: `field:${column}` as AgencySortKey,
    title,
    kind,
  })),
];
export const AGENCY_COLUMN_KEYS = AGENCY_COLUMNS.map((c) => c.key);
export function agencyVisibleColumns(value: unknown): AgencySortKey[] {
  if (!Array.isArray(value)) return [...AGENCY_DEFAULT_KEYS];
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
  fields?: Array<{ column?: string; label: string; value: string }>;
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
  filters?: AgencyFieldFilter[];
};
export type AgencyFieldFilter = {
  field: AgencySortKey;
  operator: "contains" | "equals" | "empty" | "notEmpty" | "gte" | "lte";
  value: string;
};
export function agencyCellValue(
  item: Agency,
  period: Period,
  key: AgencySortKey,
): string {
  if (key.startsWith("field:"))
    return period.fields?.find((f) => f.column === key.slice(6))?.value || "";
  if (key === "name") return item.name;
  if (key === "status")
    return (
      (
        {
          MATCHED: "Сопоставлено",
          REVIEW: "На проверке",
          NEW: "Нет в текущей базе",
        } as Record<string, string>
      )[item.status] || item.status
    );
  if (key === "source") return `${period.tab}, строка ${period.row}`;
  return period[
    (
      { baseline: "baselineRub", added: "addedRub", total: "totalRub" } as const
    )[key as "baseline" | "added" | "total"]
  ];
}
function comparable(value: string, kind: string): number | null {
  const text = value.trim();
  if (!text) return null;
  if (kind === "date") {
    const m =
      /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(text) ||
      /^(\d{4})-(\d{2})-(\d{2})$/
        .exec(text)
        ?.map((v, i, a) => (i === 1 ? a[3] : i === 3 ? a[1] : v));
    if (!m) return null;
    const d = Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
    const date = new Date(d);
    return date.getUTCFullYear() === Number(m[3]) &&
      date.getUTCMonth() === Number(m[2]) - 1 &&
      date.getUTCDate() === Number(m[1])
      ? d
      : null;
  }
  const numeric = text
    .replace(/[\s\u00a0]/g, "")
    .replace(/%$/, "")
    .replace(",", ".");
  return /^-?\d+(?:\.\d+)?$/.test(numeric) && Number.isFinite(Number(numeric))
    ? Number(numeric)
    : null;
}
function matches(
  item: Agency,
  period: Period,
  filter: AgencyFieldFilter,
): boolean {
  const column = AGENCY_COLUMNS.find((c) => c.key === filter.field);
  if (!column) return false;
  const value = agencyCellValue(item, period, filter.field);
  if (filter.operator === "empty") return !value.trim();
  if (filter.operator === "notEmpty") return !!value.trim();
  if (!filter.value.trim()) return true;
  if (filter.operator === "contains")
    return normalized(value).includes(normalized(filter.value));
  if (column.kind === "text")
    return (
      filter.operator === "equals" &&
      normalized(value) === normalized(filter.value)
    );
  if (["baseline", "added", "total"].includes(filter.field)) {
    const input = filter.value.replace(/\s/g, "").replace(",", ".");
    if (!/^-?\d+(?:\.\d{1,2})?$/.test(input)) return false;
    const a = cents(value),
      b = cents(input);
    return filter.operator === "equals"
      ? a === b
      : filter.operator === "gte"
        ? a >= b
        : a <= b;
  }
  const a = comparable(value, column.kind),
    b = comparable(filter.value, column.kind);
  return (
    a !== null &&
    b !== null &&
    (filter.operator === "equals"
      ? a === b
      : filter.operator === "gte"
        ? a >= b
        : a <= b)
  );
}
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
        (!options.source || period.tab === options.source) &&
        (options.filters || []).every((f) => matches(item, period, f)),
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
    else if (key.startsWith("field:")) {
      const av = agencyCellValue(a.item, a.period, key),
        bv = agencyCellValue(b.item, b.period, key);
      const kind = AGENCY_COLUMNS.find((c) => c.key === key)?.kind || "text";
      const an = comparable(av, kind),
        bn = comparable(bv, kind);
      compared =
        kind !== "text" && an !== null && bn !== null
          ? an - bn
          : kind !== "text" && (an !== null || bn !== null)
            ? an === null
              ? 1
              : -1
            : textCompare(av, bv);
    } else {
      const field = {
        baseline: "baselineRub",
        added: "addedRub",
        total: "totalRub",
      }[key as "baseline" | "added" | "total"] as
        | "baselineRub"
        | "addedRub"
        | "totalRub";
      const av = cents(a.period[field]),
        bv = cents(b.period[field]);
      compared = av < bv ? -1 : av > bv ? 1 : 0;
    }
    return (
      compared * (options.direction === "asc" ? 1 : -1) || a.order - b.order
    );
  });
}
