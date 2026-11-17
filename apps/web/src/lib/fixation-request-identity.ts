export interface FixationRequestIdentity {
  key: string;
  storageKey: string;
}

/** Persist only a random key and a digest. No names, phones or form data. */
export async function fixationRequestIdentity(
  actorId: string,
  payload: Record<string, unknown>,
  storage: Pick<Storage, "getItem" | "setItem">,
): Promise<FixationRequestIdentity> {
  if (!actorId) throw new Error("Войдите в кабинет перед отправкой заявки.");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const storageKey = `fixation-request:v1:${actorId}:${hash}`;
  let key: string;
  try {
    const saved = storage.getItem(storageKey);
    key =
      saved &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        saved,
      )
        ? saved
        : crypto.randomUUID();
    storage.setItem(storageKey, key);
    if (storage.getItem(storageKey) !== key)
      throw new Error("storage not durable");
  } catch {
    // Do not send with a disposable key after a storage failure.
    throw new Error(
      "Не удалось сохранить номер отправки. Проверьте доступность хранилища браузера.",
    );
  }
  return { key, storageKey };
}
