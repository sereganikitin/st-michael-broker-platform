/** The public HTTPS entry point for this production deployment. */
export const CANONICAL_PUBLIC_WEB_ORIGIN = "https://broker.stmichael.ru";

/**
 * Email links and other public URLs must not inherit a stale server IP or an
 * untrusted host from production configuration. Development/test can explicitly
 * configure an HTTP(S) origin; paths, credentials, queries and fragments are not
 * origins and are rejected instead of silently changing the destination.
 */
export function getPublicWebOrigin(): string {
  if (process.env.NODE_ENV === "production") {
    return CANONICAL_PUBLIC_WEB_ORIGIN;
  }

  const configured = process.env.WEB_URL;
  if (
    (!configured || !configured.trim()) &&
    (process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test")
  ) {
    return "http://localhost:3000";
  }
  if (!configured || /[\u0000-\u001f\u007f\\]/.test(configured)) {
    return CANONICAL_PUBLIC_WEB_ORIGIN;
  }

  const candidate = configured.trim();
  if (!/^https?:\/\/[^/?#]+\/?$/i.test(candidate) || /\s/.test(candidate)) {
    return CANONICAL_PUBLIC_WEB_ORIGIN;
  }

  try {
    const url = new URL(candidate);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return CANONICAL_PUBLIC_WEB_ORIGIN;
    }
    return url.origin;
  } catch {
    return CANONICAL_PUBLIC_WEB_ORIGIN;
  }
}
