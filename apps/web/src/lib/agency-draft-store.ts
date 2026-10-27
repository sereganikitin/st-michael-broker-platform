export type DraftRecord<T> = { version: 1; value: T; baseline: T };
type StorageLike = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem" | "key" | "length"
>;
const prefix = (scope: string) =>
  `agency-v1-2:draft:${encodeURIComponent(scope)}:`;
export const draftIsDirty = (record: DraftRecord<unknown>) =>
  JSON.stringify(record.value) !== JSON.stringify(record.baseline);

/** Tab-only drafts; never sends data to the server and never shares users' keys. */
export function createAgencyDraftStore(storage: () => StorageLike | null) {
  const memory = new Map<string, string>();
  const listeners = new Set<() => void>();
  let storageFailed = false;
  const emit = () => listeners.forEach((listener) => listener());
  const keyFor = (scope: string, form: string) =>
    prefix(scope) + encodeURIComponent(form);
  const valid = (raw: string | null) => {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed?.version === 1 && "value" in parsed && "baseline" in parsed
        ? raw
        : null;
    } catch {
      return null;
    }
  };
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    read<T>(scope: string, form: string, initial: T): string {
      const fallback = JSON.stringify({
        version: 1,
        value: initial,
        baseline: initial,
      });
      if (!scope) return fallback;
      const key = keyFor(scope, form);
      if (memory.has(key)) return memory.get(key)!;
      let record: string | null = null;
      try {
        record = valid(storage()?.getItem(key) ?? null);
      } catch {
        storageFailed = true;
      }
      memory.set(key, record || fallback);
      return record || fallback;
    },
    write<T>(scope: string, form: string, record: DraftRecord<T>) {
      if (!scope) return;
      const key = keyFor(scope, form),
        raw = JSON.stringify(record);
      memory.set(key, raw);
      try {
        const target = storage();
        if (!target) storageFailed = true;
        else if (draftIsDirty(record)) target.setItem(key, raw);
        else target.removeItem(key);
      } catch {
        storageFailed = true;
      }
      emit();
    },
    summary(scope: string): string {
      if (!scope) return "0:0";
      const entries = new Map(memory);
      try {
        const target = storage();
        if (target)
          for (let i = 0; i < target.length; i++) {
            const key = target.key(i);
            if (key?.startsWith(prefix(scope)) && !entries.has(key)) {
              const raw = valid(target.getItem(key));
              if (raw) entries.set(key, raw);
            }
          }
      } catch {
        storageFailed = true;
      }
      const count = [...entries].filter(
        ([key, raw]) =>
          key.startsWith(prefix(scope)) && draftIsDirty(JSON.parse(raw)),
      ).length;
      return `${count}:${storageFailed ? 1 : 0}`;
    },
    clear(scope: string) {
      if (!scope) return;
      for (const [key, raw] of memory)
        if (key.startsWith(prefix(scope))) {
          const record = JSON.parse(raw) as DraftRecord<unknown>;
          memory.set(
            key,
            JSON.stringify({ ...record, value: record.baseline }),
          );
        }
      try {
        const target = storage();
        if (target) {
          const keys = Array.from({ length: target.length }, (_, i) =>
            target.key(i),
          );
          for (const key of keys)
            if (key?.startsWith(prefix(scope))) target.removeItem(key);
        }
      } catch {
        storageFailed = true;
      }
      emit();
    },
  };
}
