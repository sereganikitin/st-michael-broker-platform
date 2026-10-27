"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";
import { useAgencyDraft } from "@/lib/use-agency-draft";
import {
  contactDateFromInput,
  contactDateToInput,
} from "@/lib/moscow-contact-date";
import { supervisorDate } from "@/lib/agency-supervisor";

export type CampaignOutcome = {
  id: string;
  eventId: string;
  version: number;
  kind: string;
  status: string;
  occurredAt: string;
  basis: string;
  comment: string;
  correctionReason: string | null;
  actor: { id: string; fullName: string };
  createdAt: string;
};
export const outcomeKind: Record<string, string> = {
  MEETING: "Встреча",
  TOUR: "Экскурсия",
  REACTIVATION: "Реактивация",
};
export const outcomeStatus: Record<string, string> = {
  PLANNED: "Запланировано",
  HELD: "Состоялось",
  CANCELLED: "Отменено",
  REACTIVATED: "Возобновлено сотрудничество",
};
const blank = () => ({
  eventId: "",
  expectedVersion: 0,
  kind: "MEETING",
  status: "PLANNED",
  when: "",
  basis: "",
  comment: "",
  correctionReason: "",
});

function AssignmentOutcomes({
  agencyId,
  assignmentId,
  scope,
  canEdit,
}: {
  agencyId: string;
  assignmentId: string;
  scope: string;
  canEdit: boolean;
}) {
  const { value, setValue, reset, dirty } = useAgencyDraft(
    scope,
    `campaign-outcomes:${assignmentId}`,
    blank(),
  );
  const [history, setHistory] = useState<CampaignOutcome[]>([]),
    [loaded, setLoaded] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  const request = useRef({ signature: "", id: "" });
  const endpoint = `/loyalty-workflow/agencies-v1-2/${agencyId}/assignments/${assignmentId}/outcomes`;
  const load = useCallback(async () => {
    setError("");
    try {
      const response = await apiGet<{ history: CampaignOutcome[] }>(endpoint);
      if (!Array.isArray(response.history))
        throw new Error("Сервер не вернул историю результатов");
      setHistory(response.history);
      setLoaded(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "История не загружена");
    }
  }, [endpoint]);
  useEffect(() => {
    void load();
  }, [load]);
  const latest = [
    ...new Map(
      [...history]
        .sort((a, b) => a.version - b.version)
        .map((r) => [r.eventId, r] as const),
    ).values(),
  ];
  const patch = (part: Partial<ReturnType<typeof blank>>) =>
    setValue((v) => ({ ...v, ...part }));
  async function save() {
    setBusy(true);
    setError("");
    setNotice("");
    const eventId = value.eventId || crypto.randomUUID();
    if (!value.eventId) patch({ eventId });
    const payload = {
      ...value,
      eventId,
      occurredAt: contactDateFromInput(value.when),
    };
    const { when, ...body } = payload;
    const signature = JSON.stringify(body);
    if (request.current.signature !== signature)
      request.current = { signature, id: crypto.randomUUID() };
    try {
      const saved = await apiPost<CampaignOutcome>(endpoint, {
        ...body,
        submissionId: request.current.id,
      });
      // Read back before clearing the draft or declaring successful persistence.
      const check = await apiGet<{ history: CampaignOutcome[] }>(endpoint);
      if (
        !Array.isArray(check.history) ||
        !check.history.some((r) => r.id === saved.id)
      )
        throw Error(
          "Не удалось подтвердить сохранение. Обновите историю перед повтором",
        );
      setHistory(check.history);
      reset(blank());
      setNotice("Результат сохранён и проверен. Задачи не изменены.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Результат не сохранён");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-3">
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <button
        className="text-accent"
        disabled={busy}
        onClick={() => void load()}
      >
        Обновить историю результатов
      </button>
      {loaded && !latest.length && (
        <p>
          Результаты ещё не зафиксированы. Это не означает, что встреч не было.
        </p>
      )}
      {latest.map((row) => (
        <article key={row.eventId} className="rounded border border-border p-2">
          <p>
            {outcomeKind[row.kind]} · {outcomeStatus[row.status]} ·{" "}
            {supervisorDate(row.occurredAt)} МСК
          </p>
          <p className="whitespace-pre-wrap">
            Основание: {row.basis}. {row.comment}
          </p>
          <p>
            {row.actor.fullName} · версия {row.version} · записано{" "}
            {supervisorDate(row.createdAt)} МСК
          </p>
          {canEdit && (
            <button
              className="text-accent"
              disabled={busy}
              onClick={() => {
                if (
                  dirty &&
                  !confirm("Заменить текущий черновик результатом из истории?")
                )
                  return;
                reset({
                  eventId: row.eventId,
                  expectedVersion: row.version,
                  kind: row.kind,
                  status: row.status,
                  when: contactDateToInput(row.occurredAt),
                  basis: row.basis,
                  comment: row.comment,
                  correctionReason: "",
                });
              }}
            >
              Изменить статус / исправить
            </button>
          )}
          <details>
            <summary>История версий</summary>
            {history
              .filter((r) => r.eventId === row.eventId)
              .map((r) => (
                <p key={r.id}>
                  v{r.version}: {outcomeStatus[r.status]} ·{" "}
                  {supervisorDate(r.occurredAt)} · {r.actor.fullName} ·{" "}
                  {r.basis} · {r.comment} ·{" "}
                  {r.correctionReason || "Первичная запись"}
                </p>
              ))}
          </details>
        </article>
      ))}
      {canEdit && loaded && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <fieldset disabled={busy} className="grid gap-2">
            <h4 className="font-semibold">
              {value.expectedVersion
                ? "Новая версия результата"
                : "Зафиксировать результат"}
            </h4>
            <label>
              Тип результата
              <select
                className="input"
                aria-label="Тип результата кампании"
                value={value.kind}
                disabled={!!value.expectedVersion}
                onChange={(e) =>
                  patch({
                    kind: e.target.value,
                    status:
                      e.target.value === "REACTIVATION"
                        ? "REACTIVATED"
                        : "PLANNED",
                  })
                }
              >
                {Object.entries(outcomeKind).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Статус
              <select
                className="input"
                aria-label="Статус результата кампании"
                value={value.status}
                onChange={(e) => patch({ status: e.target.value })}
              >
                {(value.kind === "REACTIVATION"
                  ? ["REACTIVATED", "CANCELLED"]
                  : ["PLANNED", "HELD", "CANCELLED"]
                ).map((k) => (
                  <option key={k} value={k}>
                    {outcomeStatus[k]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Дата события, МСК
              <input
                className="input"
                aria-label="Дата результата кампании"
                type="datetime-local"
                required
                value={value.when}
                onChange={(e) => patch({ when: e.target.value })}
              />
            </label>
            <label>
              Основание: где и кем подтверждено
              <textarea
                className="input"
                aria-label="Основание результата кампании"
                required
                maxLength={1000}
                value={value.basis}
                onChange={(e) => patch({ basis: e.target.value })}
              />
            </label>
            <label>
              Комментарий
              <textarea
                className="input"
                maxLength={2000}
                value={value.comment}
                onChange={(e) => patch({ comment: e.target.value })}
              />
            </label>
            {!!value.expectedVersion && (
              <label>
                Причина изменения
                <textarea
                  className="input"
                  aria-label="Причина изменения результата"
                  required
                  maxLength={1000}
                  value={value.correctionReason}
                  onChange={(e) => patch({ correctionReason: e.target.value })}
                />
              </label>
            )}
            <button className="btn btn-secondary">
              Сохранить результат кампании
            </button>
            <button
              type="button"
              className="text-accent"
              onClick={() => {
                if (!dirty || confirm("Удалить черновик результата?"))
                  reset(blank());
              }}
            >
              Новая запись / сбросить черновик
            </button>
          </fieldset>
        </form>
      )}
    </div>
  );
}

export function AgencyCampaignOutcomes({
  agencyId,
  assignments,
  scope,
  userId,
  permissions,
}: {
  agencyId: string;
  assignments: Array<{
    id: string;
    assignedToId: string;
    status: string;
    campaign: { name: string };
  }>;
  scope: string;
  userId: string;
  permissions: string[];
}) {
  const readable = assignments.filter(
    (a) => a.assignedToId === userId || permissions.includes("READ_ALL"),
  );
  const [selected, setSelected] = useState("");
  const assignment = readable.find((a) => a.id === selected) || readable[0];
  return (
    <section className="space-y-3 rounded border border-border p-3">
      <h3 className="font-semibold">
        Результаты кампаний: встречи, экскурсии, реактивации
      </h3>
      <p>
        Ручной журнал с основанием. Завершение задачи не означает, что встреча
        состоялась. Эти записи не подтверждают сделки CRM и не запускают звонки.
      </p>
      {!assignment ? (
        <p>Для фиксации результата нужно существующее назначение кампании.</p>
      ) : (
        <>
          <select
            className="input"
            aria-label="Кампания результата"
            value={assignment.id}
            onChange={(e) => setSelected(e.target.value)}
          >
            {readable.map((a) => (
              <option key={a.id} value={a.id}>
                {a.campaign.name} · {a.id.slice(0, 8)}
              </option>
            ))}
          </select>
          <AssignmentOutcomes
            key={assignment.id}
            agencyId={agencyId}
            assignmentId={assignment.id}
            scope={scope}
            canEdit={
              (assignment.assignedToId === userId &&
                assignment.status !== "CANCELLED" &&
                permissions.includes("CALL_EXECUTE")) ||
              (permissions.includes("READ_ALL") &&
                permissions.includes("CALL_ASSIGN"))
            }
          />
        </>
      )}
    </section>
  );
}
