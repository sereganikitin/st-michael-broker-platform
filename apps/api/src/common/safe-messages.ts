/**
 * 2026-09-09 (владелец): брокер и посетитель сайта — сторонние пользователи.
 * Им показываем только обобщённые формулировки: без чужих ФИО, телефонов,
 * email, статусов карточек, внутренних id и счётчиков. Подробности —
 * администраторам в кабинете и в журнале (logAudit / ops-alert).
 *
 * Здесь собраны безопасные тексты и маскирование контактов, чтобы не
 * дублировать их по сервисам.
 */

export type MessageAudience = "BROKER" | "STAFF";

/** Роль вызывающего → аудитория сообщения. */
export function audienceForRole(role: string | null | undefined): MessageAudience {
  const value = String(role || "").toUpperCase();
  return value === "ADMIN" || value === "MANAGER" ? "STAFF" : "BROKER";
}

export const SAFE_MESSAGES = {
  BROKER_PHONE_UNAVAILABLE:
    "Этот номер сейчас недоступен для фиксации. Проверьте номер или обратитесь в поддержку.",
  CLIENT_UNIQUENESS_CONFLICT:
    "Этот клиент уже проходит проверку уникальности. Заявка передана менеджеру — он свяжется с вами.",
  PHONE_TAKEN:
    "Этот номер уже используется. Если это вы — восстановите доступ по email или напишите в поддержку, указав ваш номер телефона.",
  QUICK_FIX_ACCEPTED:
    "Заявка принята. Если данные верны, брокер получит уведомление.",
} as const;

export type SafeMessageCode = keyof typeof SAFE_MESSAGES;

/** «Кравченко Наталья Владимировна» → «Кравченко Н. В.» */
export function maskPersonName(fullName: string | null | undefined): string {
  const parts = String(fullName || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return "—";
  const [family, ...rest] = parts;
  const initials = rest
    .filter(Boolean)
    .map((word) => `${word[0].toUpperCase()}.`)
    .join(" ");
  return initials ? `${family} ${initials}` : family;
}

/** «+79255724188» → «+7 925 ***-**-88» (последние 2 цифры для узнавания). */
export function maskPhone(phone: string | null | undefined): string | null {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length < 6) return null;
  const tail = digits.slice(-2);
  const head = digits.length >= 11 ? `+${digits[0]} ${digits.slice(1, 4)}` : `${digits.slice(0, 3)}`;
  return `${head} ***-**-${tail}`;
}
