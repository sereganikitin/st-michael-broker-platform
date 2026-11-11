/** Public broker contact, independent of configured SMTP/SendGrid identities. */
export const BROKER_CONTACT_EMAIL = "broker@stmichael.ru";
export const CONTACT_EMAIL_TERMS_VERSION = "2026-10-06-contact-email";
export const PREVIOUS_DEFAULT_TERMS_VERSION = "2026-06-15";

// Used only to recognize legacy content and preserve historical editions.
export const LEGACY_BROKER_CONTACT_EMAIL = "info@zorge9.com";

export function normalizeLegacyContactBlock<T>(value: T): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const email = (value as any).email;
  if (
    typeof email !== "string" ||
    email.trim().toLowerCase() !== LEGACY_BROKER_CONTACT_EMAIL
  )
    return value;
  return { ...value, email: BROKER_CONTACT_EMAIL };
}

/** Only called for an explicitly published new legal edition, never on reads. */
export function replaceLegacyTermsContact(body: string): string {
  return body.replace(
    /(?<![A-Za-z0-9._%+-])info@zorge9\.com(?![A-Za-z0-9_-]|\.[A-Za-z0-9])/gi,
    BROKER_CONTACT_EMAIL,
  );
}
