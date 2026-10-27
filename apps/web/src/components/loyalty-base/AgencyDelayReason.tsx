"use client";
import { useState, useRef, useEffect } from "react";
import { apiPost } from "@/lib/api";
import { useAgencyDraft } from "@/lib/use-agency-draft";
import { type OverdueTask, supervisorDate } from "@/lib/agency-supervisor";

export function AgencyDelayReason({
  task,
  scope,
  canEdit,
  onChanged,
}: {
  task: OverdueTask;
  scope: string;
  canEdit: boolean;
  onChanged: () => Promise<void>;
}) {
  const { value, setValue, reset, dirty } = useAgencyDraft(
    scope,
    `delay-reason:${task.id}`,
    { reason: "", version: task.version },
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const request = useRef({ signature: "", id: "" });
  const detailsRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (dirty && detailsRef.current) detailsRef.current.open = true;
  }, [dirty]);
  async function save() {
    setBusy(true);
    setError("");
    const body = {
      reason: value.reason.trim(),
      expectedVersion: value.version,
    };
    const signature = JSON.stringify(body);
    if (request.current.signature !== signature)
      request.current = { signature, id: crypto.randomUUID() };
    try {
      const saved = await apiPost<{ version: number }>(
        `/loyalty-workflow/agencies-v1-2/supervisor/tasks/${task.id}/delay-reason`,
        { ...body, submissionId: request.current.id },
      );
      reset({ reason: "", version: saved.version });
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Причина не сохранена");
    } finally {
      setBusy(false);
    }
  }
  return (
    <details ref={detailsRef}>
      <summary className="cursor-pointer text-accent">
        Причина задержки и история
      </summary>
      {!task.reasons.length && (
        <p>
          Причина не зафиксирована — не выводится из комментария автоматически.
        </p>
      )}
      {task.reasons.map((r) => (
        <p key={r.id} className="whitespace-pre-wrap">
          {r.reason} · {r.actor.fullName} · {supervisorDate(r.createdAt)} МСК
        </p>
      ))}
      {error && <p role="alert">{error}</p>}
      {canEdit && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <fieldset disabled={busy} className="space-y-2">
            <label>
              Причина задержки
              <textarea
                aria-label={`Причина задержки: ${task.title}`}
                className="input w-full"
                required
                maxLength={1000}
                value={value.reason}
                onChange={(e) =>
                  setValue((v) => ({
                    ...v,
                    reason: e.target.value,
                    ...(!dirty ? { version: task.version } : {}),
                  }))
                }
              />
            </label>
            {dirty && task.version !== value.version && (
              <p>
                Задача изменилась. Проверьте историю и обновите версию перед
                сохранением.{" "}
                <button
                  type="button"
                  onClick={() =>
                    setValue((v) => ({ ...v, version: task.version }))
                  }
                >
                  Принять текущую версию
                </button>
              </p>
            )}
            <button
              className="btn btn-secondary"
              disabled={!value.reason.trim()}
            >
              Зафиксировать причину
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                if (!dirty || confirm("Удалить черновик причины?"))
                  reset({ reason: "", version: task.version });
              }}
            >
              Отменить черновик
            </button>
          </fieldset>
        </form>
      )}
    </details>
  );
}
