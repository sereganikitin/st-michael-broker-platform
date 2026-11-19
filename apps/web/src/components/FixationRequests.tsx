"use client";

import { useEffect, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";

type Request = {
  requestId: string;
  requestState: string;
  fullName: string;
  message: string;
  createdAt: string;
  errorCode?: string;
  canRetryCheck?: boolean;
  submittedBy?: { id: string; fullName: string };
  responsibleBroker?: { id: string; fullName: string } | null;
  agency?: { id: string; name: string } | null;
};

export function FixationRequests({
  actorId,
  refreshKey = 0,
  asStaff = false,
  submittedForOthers = false,
}: {
  actorId?: string;
  refreshKey?: number;
  asStaff?: boolean;
  submittedForOthers?: boolean;
}) {
  const [rows, setRows] = useState<Request[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  const [revision, setRevision] = useState(0);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState("");
  useEffect(() => {
    let stopped = false;
    let fetching = false;
    setRows([]);
    if (!actorId) return;
    const refresh = async () => {
      if (fetching || document.visibilityState === "hidden") return;
      fetching = true;
      try {
        const result = await apiGet<Request[]>(
          asStaff
            ? "/clients/fixation-requests/admin/queue"
            : `/clients/fixation-requests${submittedForOthers ? '?submittedForOthers=true' : ''}`,
        );
        if (!stopped) {
          setRows(result);
          setUnavailable(false);
        }
      } catch {
        if (!stopped) setUnavailable(true);
      } finally {
        fetching = false;
      }
    };
    void refresh();
    const interval = setInterval(() => {
      void refresh();
    }, 10_000);
    return () => {
      stopped = true;
      clearInterval(interval);
    };
  }, [actorId, refreshKey, asStaff, revision, submittedForOthers]);
  if (!rows.length && !unavailable && !actionMessage) return null;
  return (
    <section className="card mb-6" aria-label="Заявки на фиксацию">
      <h2 className="font-semibold mb-3">
        {asStaff
          ? "Заявки, требующие проверки передачи"
          : "Заявки на фиксацию"}
      </h2>
      {actionMessage && (
        <p className="text-sm mb-3" role="status">
          {actionMessage}
        </p>
      )}
      {unavailable && (
        <p className="text-sm text-text-muted mb-3" role="status">
          Не удалось обновить статусы. Повторим автоматически; заново отправлять
          заявки не нужно.
        </p>
      )}
      <ul className="space-y-3" aria-live="polite">
        {rows.map((row) => (
          <li
            key={row.requestId}
            className="border-b border-border pb-2 last:border-0"
          >
            <p className="text-sm font-medium">
              {row.fullName} · {new Date(row.createdAt).toLocaleString("ru-RU")}
            </p>
            <p className="text-sm text-text-muted">{row.message}</p>
            {row.submittedBy && row.responsibleBroker && row.submittedBy.id !== row.responsibleBroker.id && (
              <p className="text-sm text-text-muted mt-1">
                Подал: {row.submittedBy.fullName} · Ответственный брокер: {row.responsibleBroker.fullName}
              </p>
            )}
            {row.agency && <p className="text-xs text-text-muted">{row.agency.name}</p>}
            {asStaff && row.errorCode && (
              <p className="text-xs text-text-muted">
                Причина для диагностики: {row.errorCode}
              </p>
            )}
            {asStaff && row.canRetryCheck && (
              <button
                type="button"
                className="btn-secondary mt-2 text-sm"
                disabled={retrying !== null}
                onClick={async () => {
                  setRetrying(row.requestId);
                  try {
                    const result = await apiPost<{ message: string }>(
                      `/clients/fixation-requests/${row.requestId}/retry-check`,
                      {},
                    );
                    setActionMessage(result.message);
                    setRevision((value) => value + 1);
                  } catch {
                    setActionMessage(
                      "Не удалось назначить повторную проверку. Обновите статус заявки.",
                    );
                  } finally {
                    setRetrying(null);
                  }
                }}
              >
                Повторить проверку после устранения причины
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
