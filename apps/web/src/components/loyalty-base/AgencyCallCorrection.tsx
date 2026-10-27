"use client";

import { useRef, useState } from "react";
import { correctLoyaltyCall } from "@/lib/loyalty-workflow-api";
import { useAgencyDraft } from "@/lib/use-agency-draft";
import {
  contactDateFromInput,
  contactDateToInput,
} from "@/lib/moscow-contact-date";
import {
  getLoyaltyCallResultOptions,
  type LoyaltyCallResult,
} from "@/lib/loyalty-base-api";

export function AgencyCallCorrection({
  draftScope,
  attempt,
  onChanged,
}: {
  draftScope: string;
  attempt: {
    id: string;
    assignmentId: string;
    result: string;
    comment: string;
    nextStep: string;
    nextActionAt: string;
    nextActionKind?: string;
  };
  onChanged: () => Promise<void>;
}) {
  const initial = {
    kind: attempt.nextActionKind || "",
    result: attempt.result,
    comment: attempt.comment || "",
    nextStep: attempt.nextStep || "",
    when: contactDateToInput(attempt.nextActionAt),
    reason: "",
  };
  const {
    value: draft,
    setValue: setDraft,
    reset,
    dirty,
  } = useAgencyDraft(draftScope, `correction:${attempt.id}`, initial);
  const { kind, result, comment, nextStep, when, reason } = draft;
  const patch = (part: Partial<typeof draft>) =>
    setDraft((old) => ({ ...old, ...part }));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submission = useRef({ signature: "", id: "" });
  async function save() {
    setBusy(true);
    setError("");
    const body = {
      result: result as LoyaltyCallResult,
      comment,
      nextStep: nextStep || undefined,
      nextActionKind: nextStep ? kind || undefined : undefined,
      nextActionAt: contactDateFromInput(when) || undefined,
      correctionReason: reason.trim(),
    };
    const signature = JSON.stringify(body);
    if (submission.current.signature !== signature)
      submission.current = { signature, id: crypto.randomUUID() };
    try {
      await correctLoyaltyCall(attempt.assignmentId, attempt.id, {
        ...body,
        submissionId: submission.current.id,
      });
      reset(initial);
      await onChanged();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Не удалось сохранить исправление",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="mt-2" open={dirty || undefined}>
      <summary className="cursor-pointer text-accent">
        Исправить с сохранением истории
      </summary>
      <form
        className="grid gap-2 pt-2"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <fieldset disabled={busy} className="contents">
          <label>
            Исправленный результат
            <select
              className="input"
              value={result}
              onChange={(e) => patch({ result: e.target.value })}
            >
              {[
                ...getLoyaltyCallResultOptions("agencies"),
                { code: "INFORMED", label: "Разговор состоялся" },
                { code: "INVALID_PHONE", label: "Неверный номер" },
              ].map((o) => (
                <option key={o.code} value={o.code}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Комментарий
            <textarea
              aria-label="Комментарий исправления"
              className="input"
              required
              maxLength={4000}
              value={comment}
              onChange={(e) => patch({ comment: e.target.value })}
            />
          </label>
          <label>
            Тип следующего действия
            <select
              className="input"
              value={kind}
              onChange={(e) => patch({ kind: e.target.value })}
            >
              <option value="">Выберите тип</option>
              <option value="CALL">Позвонить</option>
              <option value="SEND_MATERIALS">Отправить материалы</option>
              <option value="MEETING">Встреча / тур</option>
              <option value="OTHER">Другое</option>
            </select>
          </label>
          <label>
            Следующий шаг
            <input
              className="input"
              maxLength={240}
              value={nextStep}
              onChange={(e) => patch({ nextStep: e.target.value })}
            />
          </label>
          <label>
            Срок, МСК
            <input
              className="input"
              type="datetime-local"
              value={when}
              onChange={(e) => patch({ when: e.target.value })}
            />
          </label>
          <label>
            Причина исправления *
            <input
              aria-label="Причина исправления"
              className="input"
              required
              maxLength={1000}
              value={reason}
              onChange={(e) => patch({ reason: e.target.value })}
            />
          </label>
          <button className="btn btn-secondary" disabled={busy}>
            Сохранить исправление
          </button>
          <button
            className="btn btn-secondary"
            type="button"
            onClick={() => {
              if (
                !dirty ||
                window.confirm("Удалить несохранённое исправление?")
              )
                reset(initial);
            }}
          >
            Отменить исправление
          </button>
        </fieldset>
        {error && (
          <p role="alert" className="text-error">
            {error}
          </p>
        )}
      </form>
    </details>
  );
}
