"use client";

import { Fragment, useEffect, useState, type MouseEvent } from "react";
import Link from "next/link";
import { apiGet, apiDownload } from "@/lib/api";

type Field = { label: string; value: string };
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
    [expanded, setExpanded] = useState<string | null>(null);
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
    void load();
  }, []);
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
  const filtered =
    data?.items.filter((item) =>
      (item.name + " " + (item.matchedAgency?.name || ""))
        .toLocaleLowerCase("ru-RU")
        .includes(search.toLocaleLowerCase("ru-RU")),
    ) || [];
  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/admin/loyalty-base" className="text-accent">
            ← Наша база
          </Link>
          <h1 className="text-2xl font-semibold mt-2">Агентства v1/2</h1>
          <p className="text-text-muted">
            Отдельное представление таблицы партнёров. Текущая база и amoCRM не
            изменяются.
          </p>
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
      {data && (
        <>
          <div className="rounded-xl border border-border bg-surface p-4">
            <p>
              {data.items.length} агентств и агрегаторов · {data.sourceRowCount}{" "}
              строк источника · {data.matched} сопоставлено · {data.review} на
              проверке · {data.new} нет в текущей базе
            </p>
            <p className="text-sm text-text-muted mt-2">{data.warning}</p>
            <p className="text-sm text-text-muted mt-2">
              Нажмите на строку или название — откроются подробности. Ссылка в
              колонке «Сопоставление» ведёт в действующую карточку базы.
            </p>
            {data.audit && (
              <p className="text-sm text-text-muted">
                Поля источника: заполнено {data.audit.sourceFilled} из{" "}
                {data.audit.sourceFields}. Пустые поля отмечены явно; данные
                не дополняются предположениями.
              </p>
            )}
            <p className="text-sm text-text-muted">
              Загружено:{" "}
              {new Date(data.loadedAt).toLocaleString("ru-RU", {
                timeZone: "Europe/Moscow",
              })}{" "}
              МСК. Обновление из источника — при открытии или по кнопке, кэш до
              1 минуты. При ошибке ниже остаётся предыдущая загрузка.
            </p>
          </div>
          <label className="block">
            Поиск агентства
            <input
              className="mt-1 w-full rounded-lg border border-border bg-surface p-3"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Название или название карточки"
            />
          </label>
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-sm text-left">
              <thead className="bg-surface-secondary">
                <tr>
                  {[
                    "Агентство / агрегатор",
                    "Сопоставление",
                    "Источник",
                    "База, ₽",
                    "Добавлено, ₽",
                    "Итог, ₽",
                  ].map((title) => (
                    <th className="p-3 whitespace-nowrap" key={title}>
                      {title}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.flatMap((item) =>
                  item.periods.map((period) => {
                    const rowKey = `${item.key}:${period.tab}:${period.row}`;
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
                              <span aria-hidden="true">
                                {isOpen ? "▾" : "▸"}
                              </span>
                              <span>{item.name}</span>
                            </button>
                            <p className="text-text-muted">
                              {item.type}
                              {item.periods.length > 1
                                ? " · несколько периодов, не суммировать"
                                : ""}
                            </p>
                          </td>
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
                          <td className="p-3 whitespace-nowrap">
                            {period.tab}, строка {period.row}
                          </td>
                          <td className="p-3 whitespace-nowrap">
                            {money(period.baselineRub)}
                            <small className="block text-text-muted">
                              {period.baselineScope === "BEFORE_2026"
                                ? "До 2026, справочно"
                                : "База 2026 из таблицы"}
                            </small>
                          </td>
                          <td className="p-3 whitespace-nowrap">
                            {money(period.addedRub)}
                          </td>
                          <td className="p-3 whitespace-nowrap font-semibold">
                            {money(period.totalRub)}
                          </td>
                        </tr>
                        {isOpen && (
                          <tr id={`details-${rowKey}`}>
                            <td
                              colSpan={6}
                              className="border-t border-border bg-surface p-5"
                            >
                              <div className="space-y-6 max-w-6xl">
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
                                    Указанные в таблице сроки и ставки не
                                    заменяют актуальные условия вознаграждения.
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
                  }),
                )}
              </tbody>
            </table>
            {!filtered.length && <p className="p-5">Совпадений нет.</p>}
          </div>
        </>
      )}
    </div>
  );
}
