"use client";
import { useEffect, useState } from "react";
import { apiPatch } from "@/lib/api";
import {
  AGENCY_PROFILE_FIELDS,
  agencyProfilePatch,
  agencyProfileValues,
  type AgencyManualProfile,
  type AgencyProfileKey,
} from "@/lib/agency-profile";
import { formatLoyaltyDate, safeLoyaltyHttpUrl } from "@/lib/loyalty-base-api";
import { useAgencyDraft } from "@/lib/use-agency-draft";
import { AgencyCardModal } from "./AgencyCardModal";

export function AgencyManualProfileEditor({
  agencyId,
  scope,
  attributes,
  manualProfile,
  canEdit,
  onChanged,
  showProfile = true,
}: {
  agencyId: string;
  scope: string;
  attributes: Record<string, unknown>;
  manualProfile: AgencyManualProfile;
  canEdit: boolean;
  onChanged: () => Promise<void>;
  showProfile?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const values = agencyProfileValues(attributes);
  const initial = {
    version: manualProfile.version,
    baseline: values,
    values,
    resets: [] as AgencyProfileKey[],
  };
  const {
    value: editor,
    setValue: setEditor,
    reset,
    dirty,
  } = useAgencyDraft(scope, `profile:${agencyId}`, initial);
  const fingerprint = JSON.stringify(initial);
  useEffect(() => {
    if (!dirty) reset(JSON.parse(fingerprint));
  }, [fingerprint, dirty, reset]);
  async function save() {
    setBusy(true);
    setError("");
    try {
      const patch = agencyProfilePatch(
        editor.values,
        editor.baseline,
        editor.resets,
      );
      if (!Object.keys(patch).length) {
        setOpen(false);
        return;
      }
      await apiPatch(`/loyalty-workflow/agencies-v1-2/${agencyId}/profile`, {
        expectedVersion: editor.version,
        attributes: patch,
      });
      reset({
        ...editor,
        version: editor.version + 1,
        baseline: editor.values,
        resets: [],
      });
      setOpen(false);
      await onChanged();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Профиль не сохранён",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="space-y-3 rounded-xl border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">Профиль агентства</h3>
        {canEdit && (
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              setError("");
              setOpen(true);
            }}
          >
            Редактировать карточку
          </button>
        )}
      </div>
      <p className="text-xs text-text-muted">
        Ручные сведения хранятся в кабинете. Последнее изменение{" "}
        {manualProfile.updatedAt
          ? formatLoyaltyDate(manualProfile.updatedAt)
          : "ещё не внесено"}
        .
      </p>
      {showProfile && (
        <dl className="grid gap-3 sm:grid-cols-2">
          {AGENCY_PROFILE_FIELDS.map((field) => {
            const value = attributes[field.key];
            const text = typeof value === "string" ? value : "";
            const url = field.key === "website" ? safeLoyaltyHttpUrl(text) : "";
            const display =
              text && (field.kind === "date" || field.kind === "datetime-local")
                ? formatLoyaltyDate(text)
                : text;
            return (
              <div key={field.key}>
                <dt className="text-xs text-text-muted">{field.label}</dt>
                <dd className="whitespace-pre-wrap break-words text-sm">
                  {url ? (
                    <a
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-accent underline"
                    >
                      {display}
                    </a>
                  ) : (
                    display || "Нет данных"
                  )}
                  {Object.prototype.hasOwnProperty.call(
                    manualProfile.attributes,
                    field.key,
                  ) && (
                    <small className="block text-text-muted">
                      Внесено вручную в кабинете
                    </small>
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
      )}
      {open && (
        <AgencyCardModal
          title="Редактировать карточку агентства"
          busy={busy}
          onClose={() => setOpen(false)}
        >
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <p className="text-sm text-text-muted">
              Заполните подтверждённые сведения. Очистка поля снимает ручное
              значение и возвращает сведения источника после сохранения.
            </p>
            {editor.version !== manualProfile.version && (
              <p role="alert" className="text-error">
                Карточка изменена другим сотрудником. Сохранение проверит
                версию. Обновите черновик перед повторной записью.
              </p>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              {AGENCY_PROFILE_FIELDS.map((field) => (
                <label key={field.key} className="block text-sm">
                  {field.label}
                  {field.kind === "size" ? (
                    <select
                      aria-label={field.label}
                      className="input mt-1"
                      value={editor.values[field.key]}
                      disabled={busy}
                      onChange={(event) =>
                        setEditor((old) => ({
                          ...old,
                          values: {
                            ...old.values,
                            [field.key]: event.target.value,
                          },
                          resets: old.resets.filter((key) => key !== field.key),
                        }))
                      }
                    >
                      <option value="">Не указан</option>
                      <option>Крупное</option>
                      <option>Среднее</option>
                      <option>Небольшое</option>
                    </select>
                  ) : (
                    <input
                      aria-label={field.label}
                      className="input mt-1"
                      type={field.kind === "text" ? "text" : field.kind}
                      maxLength={field.max}
                      value={editor.values[field.key]}
                      disabled={busy}
                      onChange={(event) =>
                        setEditor((old) => ({
                          ...old,
                          values: {
                            ...old.values,
                            [field.key]: event.target.value,
                          },
                          resets: old.resets.filter((key) => key !== field.key),
                        }))
                      }
                    />
                  )}
                  {Object.prototype.hasOwnProperty.call(
                    manualProfile.attributes,
                    field.key,
                  ) && (
                    <button
                      type="button"
                      disabled={busy}
                      className="mt-1 text-xs text-accent"
                      onClick={() =>
                        setEditor((old) => ({
                          ...old,
                          values: { ...old.values, [field.key]: "" },
                          resets: [
                            ...old.resets.filter((key) => key !== field.key),
                            field.key,
                          ],
                        }))
                      }
                    >
                      {editor.resets.includes(field.key)
                        ? "Ручное значение будет снято"
                        : "Вернуть сведения источника"}
                    </button>
                  )}
                </label>
              ))}
            </div>
            {error && (
              <p role="alert" className="text-error">
                {error}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <button className="btn btn-primary" disabled={busy || !dirty}>
                Сохранить карточку
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy}
                onClick={() => {
                  if (
                    !dirty ||
                    window.confirm("Удалить несохранённые изменения профиля?")
                  ) {
                    reset(initial);
                    setOpen(false);
                  }
                }}
              >
                Отменить изменения
              </button>
            </div>
          </form>
        </AgencyCardModal>
      )}
    </section>
  );
}
