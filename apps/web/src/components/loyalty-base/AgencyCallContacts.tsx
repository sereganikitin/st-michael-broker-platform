"use client";

import { useEffect, useState } from "react";
import { apiPatch } from "@/lib/api";
import {
  contactDateFromInput,
  contactDateToInput,
} from "@/lib/moscow-contact-date";
import { useAgencyDraft } from "@/lib/use-agency-draft";

export type AgencyCallContact = {
  id: string;
  name: string;
  role: string;
  phone: string;
  alternatePhone: string;
  source: string;
  verifiedAt: string;
  archived: boolean;
};

const empty = (): AgencyCallContact => ({
  id: "",
  name: "",
  role: "",
  phone: "",
  alternatePhone: "",
  source: "",
  verifiedAt: "",
  archived: false,
});
export function AgencyCallContacts({
  draftScope,
  agencyId,
  contacts,
  version,
  canEdit,
  canCall,
  onChanged,
}: {
  draftScope: string;
  agencyId: string;
  contacts: AgencyCallContact[];
  version: number;
  canEdit: boolean;
  canCall: boolean;
  onChanged: () => Promise<void>;
}) {
  const {
    value: editor,
    setValue: setEditor,
    reset: resetEditor,
    dirty,
  } = useAgencyDraft(draftScope, `contacts:${agencyId}`, {
    item: empty(),
    version,
  });
  const draft = editor.item;
  useEffect(() => {
    if (!dirty && !draft.id && editor.version !== version)
      resetEditor({ item: empty(), version });
  }, [dirty, draft.id, editor.version, version, resetEditor]);
  const edit = (item: AgencyCallContact) => {
    if (dirty && !window.confirm("Заменить несохранённый черновик контакта?"))
      return;
    resetEditor({ item, version });
  };
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const patch = (part: Partial<AgencyCallContact>) =>
    setEditor((current) => ({
      ...current,
      item: { ...current.item, ...part },
    }));
  async function save(contact: AgencyCallContact, archive = false) {
    setBusy(true);
    setError("");
    try {
      const item = { ...contact, id: contact.id || crypto.randomUUID() };
      if (!archive && !contact.id) setEditor((old) => ({ ...old, item }));
      await apiPatch(`/loyalty-workflow/agencies-v1-2/${agencyId}/contacts`, {
        expectedVersion: archive ? version : editor.version,
        contacts: [...contacts.filter((c) => c.id !== item.id), item],
      });
      if (!archive) resetEditor({ item: empty(), version: version + 1 });
      await onChanged();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Контакты не сохранены",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="space-y-2">
      <h3 className="font-semibold">Проверенные контактные лица</h3>
      {!contacts.some((c) => !c.archived) && (
        <p className="text-sm text-text-muted">
          Проверенные контакты ещё не внесены.
        </p>
      )}
      {contacts
        .filter((c) => !c.archived)
        .map((c) => (
          <div key={c.id} className="rounded border border-border p-2 text-sm">
            <b>{c.name}</b> {c.role && `· ${c.role}`}
            <p>
              {c.phone || "Основной телефон не указан"}{" "}
              {c.alternatePhone && `· Запасной: ${c.alternatePhone}`}
            </p>
            <p className="text-xs text-text-muted">
              Источник: {c.source} · Проверено{" "}
              {new Intl.DateTimeFormat("ru-RU", {
                dateStyle: "short",
                timeStyle: "short",
                timeZone: "Europe/Moscow",
              }).format(new Date(c.verifiedAt))}{" "}
              МСК
            </p>
            {canCall && c.phone && c.phone.replace(/\D/g, "").length >= 5 && (
              <a
                className="text-accent mr-3"
                href={`tel:${c.phone.replace(/[^+\d]/g, "")}`}
              >
                Позвонить вручную
              </a>
            )}
            {canEdit && (
              <>
                <button
                  className="text-accent mr-3"
                  disabled={busy}
                  onClick={() => edit(c)}
                >
                  Исправить
                </button>
                <button
                  className="text-accent"
                  disabled={busy}
                  onClick={() => {
                    if (dirty) {
                      setError(
                        "Сначала сохраните или отмените черновик контакта",
                      );
                      return;
                    }
                    void save({ ...c, archived: true }, true);
                  }}
                >
                  Архивировать
                </button>
              </>
            )}
          </div>
        ))}
      {canEdit && (
        <details open={!!draft.id || dirty}>
          <summary className="cursor-pointer">
            {draft.id ? "Исправить контакт" : "Добавить проверенный контакт"}
          </summary>
          <form
            className="grid gap-2 pt-2 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              void save(draft);
            }}
          >
            <fieldset disabled={busy} className="contents">
              <input
                aria-label="Имя контакта"
                placeholder="Имя *"
                className="input"
                required
                maxLength={160}
                value={draft.name}
                onChange={(e) => patch({ name: e.target.value })}
              />
              <input
                aria-label="Должность"
                placeholder="Должность"
                className="input"
                maxLength={160}
                value={draft.role}
                onChange={(e) => patch({ role: e.target.value })}
              />
              <input
                aria-label="Основной телефон контакта"
                placeholder="Основной телефон"
                className="input"
                maxLength={30}
                value={draft.phone}
                onChange={(e) => patch({ phone: e.target.value })}
              />
              <input
                aria-label="Запасной телефон"
                placeholder="Запасной телефон"
                className="input"
                maxLength={30}
                value={draft.alternatePhone}
                onChange={(e) => patch({ alternatePhone: e.target.value })}
              />
              <input
                aria-label="Источник контакта"
                placeholder="Источник *"
                className="input"
                required
                maxLength={240}
                value={draft.source}
                onChange={(e) => patch({ source: e.target.value })}
              />
              <label className="text-sm">
                Проверено (МСК) *
                <input
                  aria-label="Дата проверки"
                  className="input"
                  type="datetime-local"
                  required
                  value={contactDateToInput(draft.verifiedAt)}
                  onChange={(e) =>
                    patch({ verifiedAt: contactDateFromInput(e.target.value) })
                  }
                />
              </label>
              <button
                className="btn btn-secondary"
                disabled={busy}
                type="submit"
              >
                Сохранить контакт
              </button>
              <button
                className="btn btn-secondary"
                type="button"
                onClick={() => {
                  if (
                    !dirty ||
                    window.confirm("Удалить несохранённый черновик контакта?")
                  )
                    resetEditor({ item: empty(), version });
                }}
              >
                Отменить изменения контакта
              </button>
            </fieldset>
          </form>
        </details>
      )}
      {error && (
        <p role="alert" className="text-error">
          {error}
        </p>
      )}
    </section>
  );
}
