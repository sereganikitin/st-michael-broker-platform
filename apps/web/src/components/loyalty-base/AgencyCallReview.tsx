"use client";

import { useRef, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";

const CRITERIA = [
  ["offerCurrent", "Актуальное предложение"],
  ["needsClarified", "Выявление потребности"],
  ["agreementRecorded", "Фиксация договорённости"],
  ["nextStepCorrect", "Корректный следующий шаг"],
] as const;
type Mark = "PASS" | "FAIL" | "NOT_OBSERVABLE";
type Criteria = Record<(typeof CRITERIA)[number][0], Mark>;
type Review = {
  id: string;
  version: number;
  criteria: Criteria;
  comment: string;
  correctionReason: string | null;
  createdAt: string;
  reviewer: { id: string; fullName: string };
};
const EMPTY: Criteria = {
  offerCurrent: "NOT_OBSERVABLE",
  needsClarified: "NOT_OBSERVABLE",
  agreementRecorded: "NOT_OBSERVABLE",
  nextStepCorrect: "NOT_OBSERVABLE",
};
const markLabel = (mark: Mark) =>
  ({
    PASS: "Подтверждено",
    FAIL: "Есть замечание",
    NOT_OBSERVABLE: "Недостаточно данных",
  })[mark];

export function AgencyCallReview({
  agencyId,
  attemptId,
  canWrite,
  superseded,
}: {
  agencyId: string;
  attemptId: string;
  canWrite: boolean;
  superseded: boolean;
}) {
  const [reviews, setReviews] = useState<Review[] | null>(null);
  const [criteria, setCriteria] = useState<Criteria>(EMPTY);
  const [comment, setComment] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const submission = useRef({ signature: "", id: "" });
  const endpoint = `/loyalty-workflow/agencies-v1-2/${agencyId}/attempts/${attemptId}/reviews`;
  async function load() {
    setBusy(true);
    setError("");
    try {
      const result = await apiGet<{ reviews: Review[] }>(endpoint);
      setReviews(result.reviews);
      setCriteria(result.reviews[0]?.criteria ?? EMPTY);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Не удалось загрузить проверки",
      );
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    setBusy(true);
    setError("");
    setNotice("");
    const body = {
      expectedVersion: reviews?.[0]?.version ?? 0,
      criteria,
      comment: comment.trim(),
      correctionReason: reason.trim() || undefined,
    };
    const signature = JSON.stringify(body);
    if (submission.current.signature !== signature)
      submission.current = { signature, id: crypto.randomUUID() };
    try {
      const saved = await apiPost<Review>(endpoint, {
        ...body,
        submissionId: submission.current.id,
      });
      setReviews((old) => [
        saved,
        ...(old ?? []).filter((r) => r.id !== saved.id),
      ]);
      setComment("");
      setReason("");
      setNotice(`Проверка №${saved.version} сохранена. История сохранена.`);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Не удалось сохранить проверку",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <details
      className="mt-2 rounded border border-border p-2"
      onToggle={(e) => {
        if (e.currentTarget.open && reviews === null && !busy) void load();
      }}
    >
      <summary className="cursor-pointer font-medium">
        Ручная проверка качества
      </summary>
      <p className="my-2 text-xs text-muted-foreground">
        Проверяется конкретная запись результата оператором. Аудиозапись не
        подключена; неподтверждённый критерий — «Недостаточно данных».
        Автоматической оценки сотрудника нет.
      </p>
      {superseded && (
        <p className="text-sm">
          Эта запись исправлена. Проверка относится к исходной версии, а не к
          исправлению.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {reviews === null ? (
        <button
          disabled={busy}
          className="btn btn-secondary"
          onClick={() => void load()}
        >
          {busy ? "Загрузка…" : "Повторить загрузку"}
        </button>
      ) : (
        <>
          {!reviews.length && (
            <p className="text-sm">Ручная проверка ещё не выполнялась.</p>
          )}
          {reviews.map((review) => (
            <div
              key={review.id}
              className="my-2 border-b border-border pb-2 text-sm"
            >
              <b>Проверка №{review.version}</b> · {review.reviewer.fullName} ·{" "}
              {new Intl.DateTimeFormat("ru-RU", {
                timeZone: "Europe/Moscow",
                dateStyle: "short",
                timeStyle: "short",
              }).format(new Date(review.createdAt))}{" "}
              МСК
              <ul>
                {CRITERIA.map(([key, label]) => (
                  <li key={key}>
                    {label}: {markLabel(review.criteria[key])}
                  </li>
                ))}
              </ul>
              <p className="whitespace-pre-wrap">{review.comment}</p>
              {review.correctionReason && (
                <p>Причина исправления: {review.correctionReason}</p>
              )}
            </div>
          ))}
          {canWrite && (
            <form
              className="grid gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <fieldset disabled={busy} className="grid gap-2">
                <legend>
                  {reviews.length
                    ? "Исправить проверку, сохранив историю"
                    : "Новая ручная проверка"}
                </legend>
                {CRITERIA.map(([key, label]) => (
                  <label key={key}>
                    {label}
                    <select
                      aria-label={label}
                      className="input w-full"
                      value={criteria[key]}
                      onChange={(e) =>
                        setCriteria((old) => ({
                          ...old,
                          [key]: e.target.value as Mark,
                        }))
                      }
                    >
                      {(["NOT_OBSERVABLE", "PASS", "FAIL"] as Mark[]).map(
                        (mark) => (
                          <option key={mark} value={mark}>
                            {markLabel(mark)}
                          </option>
                        ),
                      )}
                    </select>
                  </label>
                ))}
                <label>
                  Обоснование проверки
                  <textarea
                    required
                    maxLength={4000}
                    className="input w-full"
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                  />
                </label>
                {!!reviews.length && (
                  <label>
                    Причина исправления
                    <textarea
                      required
                      maxLength={1000}
                      className="input w-full"
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                    />
                  </label>
                )}
                <button
                  className="btn btn-primary"
                  disabled={
                    !comment.trim() || (!!reviews.length && !reason.trim())
                  }
                >
                  Сохранить проверку
                </button>
              </fieldset>
            </form>
          )}
          {error && (
            <button
              disabled={busy}
              className="btn btn-secondary"
              onClick={() => void load()}
            >
              Обновить историю проверок
            </button>
          )}
        </>
      )}
    </details>
  );
}
