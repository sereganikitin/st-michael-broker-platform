"use client";

import { useEffect, useState } from "react";
import {
  getLoyaltyFunnelDrill,
  formatLoyaltyDate,
  type LoyaltyBaseKey,
  type LoyaltyFunnelResponse,
  type LoyaltyFunnelStep,
  type LoyaltyFunnelDrillResponse,
} from "@/lib/loyalty-base-api";

type FunnelDrillStep = LoyaltyFunnelStep["key"];
const fmt = (value: number) => value.toLocaleString("ru-RU");

export function FunnelDrill({
  base,
  step,
  snapshot,
  onClose,
}: {
  base: LoyaltyBaseKey;
  step: FunnelDrillStep;
  snapshot: LoyaltyFunnelResponse;
  onClose: () => void;
}) {
  const [page, setPage] = useState(1);
  const [data, setData] = useState<LoyaltyFunnelDrillResponse | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    setData(null);
    setError("");
    getLoyaltyFunnelDrill(base, {
      step,
      mode: snapshot.mode,
      from: snapshot.period.from || undefined,
      to: snapshot.period.to || undefined,
      cabinetSource: snapshot.cabinetSource as "old" | "new" | "all",
      page,
      pageSize: 30,
    })
      .then((result) => {
        if (current) setData(result);
      })
      .catch((reason) => {
        if (current)
          setError(
            reason instanceof Error
              ? reason.message
              : "Не удалось загрузить основания",
          );
      });
    return () => {
      current = false;
    };
  }, [base, step, snapshot, page, attempt]);
  const sources: Record<string, string> = {
    CLIENT: "Фиксация кабинета",
    MEETING: "Встреча кабинета",
    DEAL: "Сделка кабинета",
    REGISTRY_DDU: "Оплаченный ДДУ реестра",
    REGISTRY_DVOU: "Оплаченный ДВОУ реестра",
    AMO_BROKER_TOUR: "Дата тура из amoCRM",
  };
  return (
    <section
      className="rounded-xl border border-accent p-3"
      aria-label="Основания показателя воронки"
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="font-semibold">
          {snapshot.funnel.steps.find((item) => item.key === step)?.label} ·
          основания
        </h3>
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          Закрыть основания
        </button>
      </div>
      <p className="mt-2 text-xs text-text-muted">
        {snapshot.mode === "strict" ? "После тура" : "За всё время"}. Период по
        дате тура —{" "}
        {snapshot.period.from
          ? formatLoyaltyDate(snapshot.period.from)
          : "без начала"}{" "}
        —{" "}
        {snapshot.period.to
          ? formatLoyaltyDate(snapshot.period.to)
          : "без окончания"}
        . Источник фиксаций —{" "}
        {snapshot.cabinetSource === "new"
          ? "новый кабинет"
          : snapshot.cabinetSource === "old"
            ? "старый кабинет"
            : "оба кабинета"}
        . Показана первая подходящая запись каждого брокера. Остальные события
        доступны в его карточке.
      </p>
      {error ? (
        <p role="alert" className="mt-2 text-error">
          {error}{" "}
          <button
            type="button"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Повторить
          </button>
        </p>
      ) : !data ? (
        <p role="status" className="mt-2">
          Загружаем основания…
        </p>
      ) : (
        <>
          <p className="mt-2 text-sm">
            Брокеров по текущим данным — {fmt(data.total)} из {fmt(data.cohort)}{" "}
            в когорте.
          </p>
          {data.total !==
            snapshot.funnel.steps.find((item) => item.key === step)?.count && (
            <p className="text-xs text-text-muted">
              С момента расчёта показателя данные изменились. Обновите воронку
              для сверки итогов.
            </p>
          )}
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th className="text-left">Брокер</th>
                  <th className="text-left">Дата тура</th>
                  <th className="text-left">Дата события</th>
                  <th className="text-left">Запись-основание</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((item) => (
                  <tr key={item.brokerId} className="border-t border-border">
                    <td className="py-2 pr-3">
                      <a
                        className="text-accent underline"
                        href={`/admin/loyalty-base/ours/brokers/${encodeURIComponent(item.brokerId)}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {item.displayName}
                      </a>
                    </td>
                    <td className="pr-3">
                      {formatLoyaltyDate(item.tourAt || "")}
                    </td>
                    <td className="pr-3">
                      {formatLoyaltyDate(
                        item.eventSource?.startsWith("REGISTRY_")
                          ? item.eventAt?.slice(0, 10) || ""
                          : item.eventAt || "",
                      )}
                    </td>
                    <td>
                      {sources[item.eventSource || ""] ||
                        item.eventSource ||
                        "Нет данных"}
                      {item.eventId && (
                        <small className="block text-text-muted">
                          ID {item.eventId}
                        </small>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!data.items.length && (
              <p className="mt-2">В этой выборке нет брокеров.</p>
            )}
          </div>
          <div className="mt-2 flex items-center gap-3">
            <button
              type="button"
              className="btn btn-secondary"
              disabled={page === 1}
              onClick={() => setPage((value) => value - 1)}
            >
              Назад
            </button>
            <span>Страница {page}</span>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={page * data.pageSize >= data.total}
              onClick={() => setPage((value) => value + 1)}
            >
              Далее
            </button>
          </div>
        </>
      )}
    </section>
  );
}
