/**
 * 2026-09-09: адрес Telegram Bot API для контейнера api.
 *
 * С сервера api.telegram.org доступен только по IPv6, а compose-сеть без
 * IPv6 — поэтому запросы из контейнера падали с ETIMEDOUT (приём ответов из
 * бота, алерты, уведомления). В docker-compose поднят ретранслятор tg-relay
 * (network_mode: host, ops/tg-relay.js), и api ходит на него через
 * TELEGRAM_API_BASE (например http://172.18.0.1:8081). Без переменной —
 * прямой адрес, как раньше.
 */
export function telegramApiBase(): string {
  const raw = String(process.env.TELEGRAM_API_BASE || "").trim();
  if (!raw) return "https://api.telegram.org";
  return raw.replace(/\/+$/, "");
}
