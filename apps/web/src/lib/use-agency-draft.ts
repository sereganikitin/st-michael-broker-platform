"use client";
import {
  useCallback,
  useEffect,
  useSyncExternalStore,
  type SetStateAction,
} from "react";
import {
  createAgencyDraftStore,
  draftIsDirty,
  type DraftRecord,
} from "./agency-draft-store";

const store = createAgencyDraftStore(() =>
  typeof window === "undefined" ? null : window.sessionStorage,
);

export function useAgencyDraft<T>(scope: string, form: string, initial: T) {
  const initialJson = JSON.stringify({
    version: 1,
    value: initial,
    baseline: initial,
  });
  const snapshot = useSyncExternalStore(
    store.subscribe,
    () => store.read(scope, form, initial),
    () => initialJson,
  );
  const record = JSON.parse(snapshot) as DraftRecord<T>;
  const setValue = useCallback(
    (next: SetStateAction<T>) => {
      const current = JSON.parse(
        store.read(scope, form, initial),
      ) as DraftRecord<T>;
      const value =
        typeof next === "function"
          ? (next as (old: T) => T)(current.value)
          : next;
      store.write(scope, form, { ...current, value });
    },
    [scope, form, initialJson],
  ); // JSON identity, not a new caller object on every render.
  const reset = useCallback(
    (value: T) =>
      store.write(scope, form, { version: 1, value, baseline: value }),
    [scope, form],
  );
  return { value: record.value, setValue, reset, dirty: draftIsDirty(record) };
}

export function useAgencyDraftGuard(scope: string) {
  const summary = useSyncExternalStore(
    store.subscribe,
    () => store.summary(scope),
    () => "0:0",
  );
  const [count, memoryOnly] = summary.split(":").map(Number);
  useEffect(() => {
    if (!count) return;
    let confirmedUntil = 0;
    const confirm = () => {
      if (Date.now() < confirmedUntil) return true;
      const accepted = window.confirm(
        "Есть несохранённые черновики. Покинуть страницу? Они останутся в этой вкладке; в базу данные не отправлены.",
      );
      if (accepted) confirmedUntil = Date.now() + 1500;
      return accepted;
    };
    const leave = (event: BeforeUnloadEvent) => {
      if (Date.now() < confirmedUntil) return;
      event.preventDefault();
      event.returnValue = "";
    };
    const click = (event: MouseEvent) => {
      if (
        event.button ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const anchor =
        event.target instanceof Element
          ? event.target.closest<HTMLAnchorElement>("a[href]")
          : null;
      if (
        !anchor ||
        anchor.target === "_blank" ||
        anchor.hasAttribute("download")
      )
        return;
      const target = new URL(anchor.href, window.location.href);
      if (
        !["http:", "https:"].includes(target.protocol) ||
        (target.origin === location.origin &&
          target.pathname === location.pathname &&
          target.search === location.search)
      )
        return;
      if (!confirm()) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    // Chromium Navigation API also covers browser Back/Forward. Other browsers
    // still restore tab drafts even when same-document traversal cannot be cancelled.
    const navigation = (window as unknown as { navigation?: EventTarget })
      .navigation;
    const navigate = (event: Event) => {
      if (
        (event as Event & { navigationType?: string }).navigationType ===
          "traverse" &&
        event.cancelable &&
        !confirm()
      )
        event.preventDefault();
    };
    window.addEventListener("beforeunload", leave);
    document.addEventListener("click", click, true);
    navigation?.addEventListener("navigate", navigate);
    return () => {
      window.removeEventListener("beforeunload", leave);
      document.removeEventListener("click", click, true);
      navigation?.removeEventListener("navigate", navigate);
    };
  }, [count]);
  return {
    count,
    memoryOnly: !!memoryOnly,
    discardAll: () => store.clear(scope),
  };
}
