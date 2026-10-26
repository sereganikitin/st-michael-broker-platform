"use client";

import { useRef, useState } from "react";
import { correctLoyaltyCall } from "@/lib/loyalty-workflow-api";
import {
  getLoyaltyCallResultOptions,
  type LoyaltyCallResult,
} from "@/lib/loyalty-base-api";

export function AgencyCallCorrection({
  attempt,
  onChanged,
}: {
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
  const [kind, setKind] = useState(attempt.nextActionKind || "");
  const [result, setResult] = useState(attempt.result);
  const [comment, setComment] = useState(attempt.comment || "");
  const [nextStep, setNextStep] = useState(attempt.nextStep || "");
  const [when, setWhen] = useState(() =>
    attempt.nextActionAt
      ? new Intl.DateTimeFormat("sv-SE", {
          timeZone: "Europe/Moscow",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        })
          .format(new Date(attempt.nextActionAt))
          .replace(" ", "T")
      : "",
  );
  const [reason, setReason] = useState("");
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
      nextActionAt: when ? `${when}:00+03:00` : undefined,
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
    <details className="mt-2">
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
        <label>
          Исправленный результат
          <select
            className="input"
            value={result}
            onChange={(e) => setResult(e.target.value)}
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
            onChange={(e) => setComment(e.target.value)}
          />
        </label>
        <label>
          Тип следующего действия
          <select
            className="input"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
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
            onChange={(e) => setNextStep(e.target.value)}
          />
        </label>
        <label>
          Срок, МСК
          <input
            className="input"
            type="datetime-local"
            value={when}
            onChange={(e) => setWhen(e.target.value)}
          />
        </label>
        <label>
          Причина исправления *
          <input aria-label="Причина исправления"
            className="input"
            required
            maxLength={1000}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        <button className="btn btn-secondary" disabled={busy}>
          Сохранить исправление
        </button>
        {error && (
          <p role="alert" className="text-error">
            {error}
          </p>
        )}
      </form>
    </details>
  );
}
