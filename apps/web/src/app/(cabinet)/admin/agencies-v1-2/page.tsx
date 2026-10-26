"use client";

import { Fragment, useEffect, useRef, useState, type MouseEvent } from "react";
import Link from "next/link";
import { apiGet, apiDownload } from "@/lib/api";
import {
  agencyTableRows,
  agencyVisibleColumns,
  AGENCY_COLUMN_KEYS,
  AGENCY_DEFAULT_KEYS,
  AGENCY_COLUMNS,
  agencyCellValue,
  type AgencyFieldFilter,
  type AgencySortKey,
} from "@/lib/agency-table";

type Field = { column?: string; label: string; value: string };
type Period = {
  tab: string;
  row: number;
  baselineRub: string;
  addedRub: string;
  totalRub: string;
  baselineScope: string;
  fields: Field[];
};
type Item = {
  key: string;
  name: string;
  type: string;
  status: "MATCHED" | "REVIEW" | "NEW";
  periods: Period[];
  matchedAgency: {
    id: string;
    name: string;
    updatedAt: string | null;
    fields: Field[];
  } | null;
};
type Data = {
  syncWarning?: string;
  loadedAt: string;
  items: Item[];
  sourceRowCount: number;
  matched: number;
  review: number;
  new: number;
  warning: string;
  audit: { sourceFields: number; sourceFilled: number; cabinetMissing: number };
};
const status = {
  MATCHED: "Сопоставлено",
  REVIEW: "На проверке",
  NEW: "Нет в текущей базе",
};
const columns = AGENCY_COLUMNS;
const money = (value: string) =>
  Number(value).toLocaleString("ru-RU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

function Fields({ fields, empty }: { fields: Field[]; empty: string }) {
  return (
    <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
      {fields.map((field) => (
        <div key={field.label} className="min-w-0">
          <dt className="text-xs text-text-muted">{field.label}</dt>
          <dd
            className={`mt-1 whitespace-pre-wrap break-words ${field.value.trim() ? "" : "text-text-muted italic"}`}
          >
            {field.value.trim() || empty}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export default function AgenciesV12Page() {
  const [data, setData] = useState<Data | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [search, setSearch] = useState(""),
    [typeFilter, setTypeFilter] = useState(""),
    [statusFilter, setStatusFilter] = useState(""),
    [sourceFilter, setSourceFilter] = useState(""),
    [sort, setSort] = useState<AgencySortKey | null>(null),
    [direction, setDirection] = useState<"asc" | "desc">("asc"),
    [visibleKeys, setVisibleKeys] = useState<AgencySortKey[]>([
      ...AGENCY_DEFAULT_KEYS,
    ]),
    [fieldFilters, setFieldFilters] = useState<AgencyFieldFilter[]>([]),
    [expanded, setExpanded] = useState<string | null>(null);
  const tableScroll = useRef<HTMLDivElement>(null);
  const visibleColumns = columns.filter((column) =>
    visibleKeys.includes(column.key),
  );
  async function load() {
    setBusy(true);
    setError("");
    try {
      setData(await apiGet<Data>("/loyalty-base/partner-sheet-v1-2"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось загрузить данные");
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    try {
      const saved = localStorage.getItem("agency-v1-2-visible-columns");
      if (saved) setVisibleKeys(agencyVisibleColumns(JSON.parse(saved)));
    } catch {
      /* Private mode or invalid preferences must not block the table. */
    }
    void load();
  }, []);
  function changeColumns(next: AgencySortKey[]) {
    const checked = agencyVisibleColumns(next);
    setVisibleKeys(checked);
    if (sort && !checked.includes(sort)) setSort(null);
    try {
      localStorage.setItem(
        "agency-v1-2-visible-columns",
        JSON.stringify(checked),
      );
    } catch {
      /* Optional preference only. */
    }
  }
  async function download() {
    try {
      setError("");
      const result = await apiDownload(
        "/loyalty-base/partner-sheet-v1-2/export",
        {},
      );
      const url = URL.createObjectURL(result.blob),
        link = document.createElement("a");
      link.href = url;
      link.download = result.filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось выгрузить CSV");
    }
  }
  const filtered = agencyTableRows(data?.items || [], {
    search,
    type: typeFilter,
    status: statusFilter,
    source: sourceFilter,
    sort,
    direction,
    filters: fieldFilters,
  });
  function sortBy(key: AgencySortKey) {
    setDirection(sort === key && direction === "asc" ? "desc" : "asc");
    setSort(key);
  }
  function resetFilters() {
    setSearch("");
    setTypeFilter("");
    setStatusFilter("");
    setSourceFilter("");
    setSort(null);
    setDirection("asc");
    setFieldFilters([]);
  }
  return (
    <div className="space-y-5 min-w-0 max-w-full">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/admin/loyalty-base" className="text-accent">
            ← Наша база
          </Link>
          <h1 className="text-2xl font-semibold mt-2">Агентства v1/2</h1>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => void load()}
            disabled={busy}
            className="btn btn-secondary"
          >
            {busy ? "Загрузка…" : "Обновить"}
          </button>
          <button
            onClick={() => void download()}
            disabled={!data || busy}
            className="btn btn-primary"
          >
            Выгрузить всё CSV
          </button>
        </div>
      </header>
      {error && (
        <div
          role="alert"
          className="rounded-xl border border-error p-4 text-error"
        >
          {error}
        </div>
      )}
      {data?.syncWarning && (
        <p role="alert" className="rounded-lg border border-amber-300 p-3">
          {data.syncWarning} Последнее успешное обновление:{" "}
          {new Date(data.loadedAt).toLocaleString("ru-RU", {
            timeZone: "Europe/Moscow",
          })}{" "}
          МСК.
        </p>
      )}
      {data && (
        <>
          <label className="block">
            Поиск агентства
            <input
              className="mt-1 w-full rounded-lg border border-border bg-surface p-3"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Название или название карточки"
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label>
              Тип
              <select
                className="mt-1 w-full rounded-lg border border-border bg-surface p-3"
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value)}
              >
                <option value="">Все типы</option>
                {["АН", "Ключевой", "Агрегатор"].map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Сопоставление
              <select
                className="mt-1 w-full rounded-lg border border-border bg-surface p-3"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
              >
                <option value="">Все статусы</option>
                {Object.entries(status).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Источник
              <select
                className="mt-1 w-full rounded-lg border border-border bg-surface p-3"
                value={sourceFilter}
                onChange={(e) => setSourceFilter(e.target.value)}
              >
                <option value="">Все листы</option>
                {["Партнеры 2026", "Спящие", "Агрегаторы"].map((tab) => (
                  <option key={tab} value={tab}>
                    {tab}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex items-end">
              <button className="btn btn-secondary" onClick={resetFilters}>
                Сбросить
              </button>
            </div>
          </div>
          <section aria-label="Фильтры по всем полям" className="space-y-3">
            {fieldFilters.map((filter, index) => {
              const update = (patch: Partial<AgencyFieldFilter>) =>
                setFieldFilters((current) =>
                  current.map((f, i) => (i === index ? { ...f, ...patch } : f)),
                );
              const kind = columns.find((c) => c.key === filter.field)?.kind;
              return (
                <div key={index} className="flex flex-wrap gap-2 items-center">
                  <select
                    aria-label={`Поле фильтра ${index + 1}`}
                    className="rounded-lg border border-border bg-surface p-3 max-w-full"
                    value={filter.field}
                    onChange={(e) =>
                      update({
                        field: e.target.value as AgencySortKey,
                        operator:
                          columns.find((c) => c.key === e.target.value)
                            ?.kind === "date"
                            ? "equals"
                            : "contains",
                        value: "",
                      })
                    }
                  >
                    {columns.map((c) => (
                      <option key={c.key} value={c.key}>
                        {c.title}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label={`Условие фильтра ${index + 1}`}
                    className="rounded-lg border border-border bg-surface p-3"
                    value={filter.operator}
                    onChange={(e) =>
                      update({
                        operator: e.target
                          .value as AgencyFieldFilter["operator"],
                      })
                    }
                  >
                    <option value="contains">Содержит</option>
                    <option value="equals">Равно</option>
                    <option value="empty">Не заполнено</option>
                    <option value="notEmpty">Заполнено</option>
                    {kind !== "text" && (
                      <>
                        <option value="gte">Не меньше / не раньше</option>
                        <option value="lte">Не больше / не позже</option>
                      </>
                    )}
                  </select>
                  {!["empty", "notEmpty"].includes(filter.operator) && (
                    <input
                      aria-label={`Значение фильтра ${index + 1}`}
                      className="rounded-lg border border-border bg-surface p-3 max-w-full"
                      type={
                        kind === "date" && filter.operator !== "contains"
                          ? "date"
                          : "text"
                      }
                      value={filter.value}
                      onChange={(e) => update({ value: e.target.value })}
                      placeholder={
                        kind === "number" ? "Например, 0,8" : "Значение"
                      }
                    />
                  )}
                  <button
                    className="btn btn-secondary"
                    aria-label={`Удалить фильтр ${index + 1}`}
                    onClick={() =>
                      setFieldFilters((current) =>
                        current.filter((_, i) => i !== index),
                      )
                    }
                  >
                    Удалить
                  </button>
                </div>
              );
            })}
            <button
              className="btn btn-secondary"
              onClick={() =>
                setFieldFilters((current) => [
                  ...current,
                  { field: "field:B", operator: "contains", value: "" },
                ])
              }
            >
              Добавить фильтр по полю
            </button>
            {fieldFilters.length > 1 && (
              <p className="text-sm text-text-muted">
                Применяются все условия одновременно.
              </p>
            )}
          </section>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <details className="rounded-lg border border-border bg-surface p-3">
              <summary className="cursor-pointer">
                Столбцы ({visibleColumns.length}/{columns.length})
              </summary>
              <fieldset className="mt-3 grid gap-3 sm:grid-cols-2">
                <legend className="sr-only">Видимые столбцы</legend>
                {columns.map((column) => (
                  <label key={column.key} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={visibleKeys.includes(column.key)}
                      disabled={column.key === "name"}
                      onChange={(event) =>
                        changeColumns(
                          event.target.checked
                            ? [...visibleKeys, column.key]
                            : visibleKeys.filter((key) => key !== column.key),
                        )
                      }
                    />
                    {column.title}
                    {column.key === "name" ? " (обязательно)" : ""}
                  </label>
                ))}
              </fieldset>
              <button
                className="mt-3 text-accent"
                onClick={() => changeColumns([...AGENCY_COLUMN_KEYS])}
              >
                Показать все столбцы
              </button>
            </details>
            <div className="flex gap-2">
              <button
                className="btn btn-secondary"
                aria-label="Прокрутить таблицу влево"
                onClick={() =>
                  tableScroll.current?.scrollBy({
                    left: -400,
                    behavior: "smooth",
                  })
                }
              >
                ←
              </button>
              <button
                className="btn btn-secondary"
                aria-label="Прокрутить таблицу вправо"
                onClick={() =>
                  tableScroll.current?.scrollBy({
                    left: 400,
                    behavior: "smooth",
                  })
                }
              >
                →
              </button>
            </div>
          </div>
          <p className="text-sm text-text-muted" aria-live="polite">
            Показано строк: {filtered.length}
          </p>
          <div
            ref={tableScroll}
            role="region"
            aria-label="Таблица агентств, горизонтальная прокрутка"
            tabIndex={0}
            className="max-w-full overflow-x-auto overscroll-x-contain rounded-xl border border-border"
          >
            <table
              className="w-full text-sm text-left"
              style={{ minWidth: 224 + (visibleColumns.length - 1) * 180 }}
            >
              <thead className="bg-surface-secondary">
                <tr>
                  {visibleColumns.map(({ key, title }) => (
                    <th
                      className="p-3 whitespace-nowrap"
                      key={key}
                      aria-sort={
                        sort === key
                          ? direction === "asc"
                            ? "ascending"
                            : "descending"
                          : "none"
                      }
                    >
                      <button
                        className="flex items-center gap-2 text-left"
                        onClick={() => sortBy(key)}
                        aria-label={`${title}: сортировать`}
                      >
                        {title}
                        <span aria-hidden="true">
                          {sort === key
                            ? direction === "asc"
                              ? "▲"
                              : "▼"
                            : "↕"}
                        </span>
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(({ item, period, rowKey }) => {
                  const isOpen = expanded === rowKey;
                  const toggle = () => setExpanded(isOpen ? null : rowKey);
                  return (
                    <Fragment key={rowKey}>
                      <tr
                        className={`border-t border-border cursor-pointer hover:bg-surface-secondary ${isOpen ? "bg-surface-secondary" : ""}`}
                        onClick={(event) => {
                          if (
                            !(event.target as HTMLElement).closest(
                              "a,button,input",
                            )
                          )
                            toggle();
                        }}
                      >
                        <td className="p-3 min-w-56">
                          <button
                            type="button"
                            className="text-left font-semibold flex items-start gap-2 rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                            aria-expanded={isOpen}
                            aria-controls={`details-${rowKey}`}
                            onClick={toggle}
                          >
                            <span aria-hidden="true">{isOpen ? "▾" : "▸"}</span>
                            <span>{item.name}</span>
                          </button>
                          <p className="text-text-muted">
                            {item.type}
                            {item.periods.length > 1
                              ? " · несколько периодов, не суммировать"
                              : ""}
                          </p>
                        </td>
                        {visibleKeys.includes("status") && (
                          <td className="p-3">
                            <span>{status[item.status]}</span>
                            {item.matchedAgency && (
                              <Link
                                className="block text-accent"
                                onClick={(
                                  event: MouseEvent<HTMLAnchorElement>,
                                ) => event.stopPropagation()}
                                href={`/admin/loyalty-base/ours/agencies/${item.matchedAgency.id}`}
                              >
                                {item.matchedAgency.name}
                              </Link>
                            )}
                          </td>
                        )}
                        {visibleKeys.includes("source") && (
                          <td className="p-3 whitespace-nowrap">
                            {period.tab}, строка {period.row}
                          </td>
                        )}
                        {visibleKeys.includes("baseline") && (
                          <td className="p-3 whitespace-nowrap">
                            {money(period.baselineRub)}
                            <small className="block text-text-muted">
                              {period.baselineScope === "BEFORE_2026"
                                ? "До 2026, справочно"
                                : "База 2026 из таблицы"}
                            </small>
                          </td>
                        )}
                        {visibleKeys.includes("added") && (
                          <td className="p-3 whitespace-nowrap">
                            {money(period.addedRub)}
                          </td>
                        )}
                        {visibleKeys.includes("total") && (
                          <td className="p-3 whitespace-nowrap font-semibold">
                            {money(period.totalRub)}
                          </td>
                        )}
                        {visibleColumns
                          .filter((c) => c.key.startsWith("field:"))
                          .map((column) => (
                            <td
                              key={column.key}
                              className="p-3 align-top min-w-48 max-w-80 whitespace-pre-wrap break-words"
                            >
                              {column.key === "field:T" && (
                                <small className="block text-text-muted">
                                  {
                                    period.fields?.find((f) => f.column === "T")
                                      ?.label
                                  }
                                </small>
                              )}
                              {agencyCellValue(item, period, column.key) || (
                                <span className="text-text-muted">
                                  Не заполнено
                                </span>
                              )}
                            </td>
                          ))}
                      </tr>
                      {isOpen && (
                        <tr id={`details-${rowKey}`}>
                          <td
                            colSpan={visibleColumns.length}
                            className="border-t border-border bg-surface p-5"
                          >
                            <div className="space-y-6 w-full max-w-[calc(100vw-5rem)] lg:max-w-6xl">
                              <section
                                aria-label={`Данные таблицы ${item.name}`}
                              >
                                <h2 className="font-semibold text-base mb-2">
                                  Данные таблицы · {period.tab}, строка{" "}
                                  {period.row}
                                </h2>
                                <p className="text-sm text-text-muted mb-4">
                                  Показаны значения источника на момент
                                  загрузки. Телефон и имя агента — контакт из
                                  таблицы, не подтверждённые реквизиты юрлица.
                                  Указанные в таблице сроки и ставки не заменяют
                                  актуальные условия вознаграждения.
                                </p>
                                {period.fields?.some((field) =>
                                  /30\.09/.test(
                                    field.label + " " + field.value,
                                  ),
                                ) && (
                                  <p className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-900">
                                    В источнике есть условие «до 30.09». Срок
                                    требует проверки: это не подтверждение
                                    действующей акции.
                                  </p>
                                )}
                                <Fields
                                  fields={period.fields || []}
                                  empty="Не заполнено в таблице"
                                />
                              </section>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
            {!filtered.length && <p className="p-5">Совпадений нет.</p>}
          </div>
        </>
      )}
    </div>
  );
}
