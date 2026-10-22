// 22.10.2026 (владелец): квадратный кадр с лицом по центру (вариант C), новое
// имя файла — чтобы браузеры не показывали закэшированную старую обрезку.
export const PARTNER_PHOTO = '/v2/img/manager-anastasia-20261022.webp';

export function partnerPhones(manager: { phone?: unknown; additionalPhones?: unknown }) {
  const extra = Array.isArray(manager.additionalPhones) ? manager.additionalPhones : [];
  const seen = new Set<string>();
  return [manager.phone, ...extra].flatMap(value => {
    if (typeof value !== 'string') return [];
    const digits = value.replace(/\D/g, '');
    const canonical = digits.length === 11 && digits.startsWith('8') ? '7' + digits.slice(1) : digits;
    if (!/^7\d{10}$/.test(canonical) || seen.has(canonical)) return [];
    seen.add(canonical);
    return [{ href: 'tel:+' + canonical, label: `+7 ${canonical.slice(1,4)} ${canonical.slice(4,7)}-${canonical.slice(7,9)}-${canonical.slice(9)}` }];
  }).slice(0, 5);
}
