/**
 * Pure-функции для импорта брокеров из табличного источника
 * (XLSX через админку, Google Sheets через workflow, и т.д.).
 *
 * Все pure — никаких Prisma/HTTP/FS зависимостей.
 * TZ v3 §2.11 (нормализация телефонов), §3 (импорт), §5 (схема Broker/CallLog).
 *
 * Зеркало scripts/_lib/brokers-import.js — пока намеренно дублирую логику
 * (TS-источник истины здесь, JS остаётся для CLI-скриптов). При изменении
 * правил — синхронизировать оба файла.
 */

export type BrokerCategoryCode =
  | 'COLD'
  | 'WARM'
  | 'HOT'
  | 'CONVERTED'
  | 'ON_BOT_REVIEW'
  | 'BLACKLIST';

export type CallResultCode =
  | 'NDZ'
  | 'DOUBLE_NDZ'
  | 'INFORMED'
  | 'ALREADY_KNOWS'
  | 'WRONG_NUMBER'
  | 'REFUSED_COMMUNICATION'
  | 'NOT_A_BROKER'
  | 'SCHEDULED_TOUR'
  | 'ONLY_SEND_INFO'
  | 'IN_PROGRESS'
  | 'REFUSED_TOUR'
  | 'HUNG_UP'
  | 'NOT_RELEVANT'
  | 'NOT_BROKER_ANYMORE'
  | 'ASKED_NOT_TO_CALL'
  | 'NEGATIVE';

export const VALID_CATEGORIES: BrokerCategoryCode[] = [
  'COLD', 'WARM', 'HOT', 'CONVERTED', 'ON_BOT_REVIEW', 'BLACKLIST',
];
export const VALID_CALL_FLAGS = ['да', 'в работе', 'обработан'] as const;
export type CallFlag = (typeof VALID_CALL_FLAGS)[number];

export interface NormalizedPhone {
  ok: boolean;
  phone?: string;
  reason?: 'empty' | 'too_short' | 'truncated_77';
  raw?: string;
  foreign?: boolean;
}

export function normalizePhone(input: unknown): NormalizedPhone {
  if (input === null || input === undefined || input === '') {
    return { ok: false, reason: 'empty' };
  }
  const digits = String(input).replace(/\D/g, '');
  const n = digits.length;
  if (n < 10) return { ok: false, reason: 'too_short', raw: digits };
  if (n === 10) return { ok: true, phone: '+7' + digits };
  if (n === 11) {
    if (digits[0] === '7' && digits[1] === '7') {
      return { ok: false, reason: 'truncated_77', raw: digits };
    }
    if (digits[0] === '7') return { ok: true, phone: '+' + digits };
    if (digits[0] === '8') return { ok: true, phone: '+7' + digits.slice(1) };
    return { ok: true, phone: '+' + digits, foreign: true };
  }
  if (n === 12) {
    if (digits.startsWith('77')) return { ok: true, phone: '+' + digits.slice(1) };
    return { ok: true, phone: '+' + digits, foreign: true };
  }
  return { ok: true, phone: '+' + digits, foreign: true };
}

export const RESULT_MAP: Record<string, { category: BrokerCategoryCode; result: CallResultCode | null }> = {
  'НДЗ': { category: 'COLD', result: 'NDZ' },
  '2 НДЗ': { category: 'ON_BOT_REVIEW', result: 'DOUBLE_NDZ' },
  'Проинформирован о новых условиях': { category: 'WARM', result: 'INFORMED' },
  'Уже был, на ТГ подписан': { category: 'WARM', result: 'ALREADY_KNOWS' },
  'Некорректный номер': { category: 'BLACKLIST', result: 'WRONG_NUMBER' },
  'Отказ от коммуникации': { category: 'ON_BOT_REVIEW', result: 'REFUSED_COMMUNICATION' },
  'НЕ брокер': { category: 'BLACKLIST', result: 'NOT_A_BROKER' },
  'Запись на БТ': { category: 'HOT', result: 'SCHEDULED_TOUR' },
  'Только отправить инфо': { category: 'WARM', result: 'ONLY_SEND_INFO' },
  'В работе': { category: 'HOT', result: 'IN_PROGRESS' },
  'Отказ от БТ': { category: 'WARM', result: 'REFUSED_TOUR' },
};

export const ZORGE_MAP: Record<string, CallResultCode> = {
  'НДЗ': 'NDZ',
  'Проинформирован': 'INFORMED',
  'Бросил трубку': 'HUNG_UP',
  'неактуально/не интересно': 'NOT_RELEVANT',
  'Только отправить инфо': 'ONLY_SEND_INFO',
  'Запись на БТ': 'SCHEDULED_TOUR',
  'Некорректный номер': 'WRONG_NUMBER',
  'уже не брокер': 'NOT_BROKER_ANYMORE',
  'Просил не звонить': 'ASKED_NOT_TO_CALL',
  'Негатив на звонок': 'NEGATIVE',
};

export interface MappedRow {
  name: string;
  phoneRaw: unknown;
  callFlag: string;
  category: BrokerCategoryCode;
  callResult: CallResultCode | null;
  zorgeResult: CallResultCode | null;
  comment: string | null;
  doNotCall: boolean;
  resultStr: string;
  zorgeStr: string;
}

export function mapRow(row: Record<string, unknown>): MappedRow {
  const name = (row['Имя'] ?? '').toString().trim();
  const phoneRaw = (row as any)['Телефон брокера'] ?? (row as any)['Телефон'];
  const meetings = Number((row as any)['Встречи'] || 0);
  const deals = Number((row as any)['Сделки'] || 0);
  const callFlag = ((row as any)['ЗВОНОК'] || '').toString().trim().toLowerCase();
  const resultStr = ((row as any)['Результат звонка'] || '').toString().trim();
  const zorgeStr = ((row as any)['Обзвон по Зорге '] || (row as any)['Обзвон по Зорге'] || '').toString().trim();
  const comment = ((row as any)['Комментарий'] || '').toString().trim() || null;

  const mapped = RESULT_MAP[resultStr] || { category: 'COLD' as BrokerCategoryCode, result: null };
  const zorgeResult = ZORGE_MAP[zorgeStr] || null;

  let category: BrokerCategoryCode = mapped.category;
  if (deals > 0 || meetings > 0) category = 'CONVERTED';

  const doNotCall =
    (['BLACKLIST', 'ON_BOT_REVIEW'] as BrokerCategoryCode[]).includes(category) ||
    resultStr === 'Отказ от коммуникации' ||
    zorgeStr === 'Просил не звонить';

  return { name, phoneRaw, callFlag, category, callResult: mapped.result, zorgeResult, comment, doNotCall, resultStr, zorgeStr };
}

export interface Candidate extends MappedRow {
  phone: string;
  foreign: boolean;
}

export interface ParseStats {
  total: number;
  invalidPhone: number;
  duplicatesInSheet: number;
  byCategory: Record<string, number>;
  byCallFlag: Record<string, number>;
}

export interface ParseResult {
  candidates: Candidate[];
  stats: ParseStats;
}

export function parseAndFilter(
  rows: Record<string, unknown>[],
  opts: {
    filter: Set<BrokerCategoryCode>;
    callFlagFilter: Set<string> | null;
    limit: number | null;
  },
): ParseResult {
  const stats: ParseStats = {
    total: rows.length,
    invalidPhone: 0,
    duplicatesInSheet: 0,
    byCategory: {},
    byCallFlag: {},
  };
  const seenPhones = new Set<string>();
  const allValid: Candidate[] = [];

  for (const row of rows) {
    const m = mapRow(row);
    const norm = normalizePhone(m.phoneRaw);
    if (!norm.ok) {
      stats.invalidPhone++;
      continue;
    }
    stats.byCategory[m.category] = (stats.byCategory[m.category] || 0) + 1;
    const cfKey = m.callFlag || '(пусто)';
    stats.byCallFlag[cfKey] = (stats.byCallFlag[cfKey] || 0) + 1;
    if (seenPhones.has(norm.phone!)) {
      stats.duplicatesInSheet++;
      continue;
    }
    seenPhones.add(norm.phone!);
    allValid.push({ ...m, phone: norm.phone!, foreign: !!norm.foreign });
  }

  let candidates = allValid.filter((c) => opts.filter.has(c.category));
  if (opts.callFlagFilter) {
    candidates = candidates.filter((c) => opts.callFlagFilter!.has(c.callFlag));
  }
  if (opts.limit) candidates = candidates.slice(0, opts.limit);

  return { candidates, stats };
}

export interface CoordRow {
  phoneRaw: unknown;
  name: string;
  agency: string | null;
}

export function mapCoordRow(row: Record<string, unknown>): CoordRow {
  const phoneRaw = (row as any)['Номер '] ?? (row as any)['Номер'];
  const name = ((row as any)['Имя'] || '').toString().trim() || '(координатор)';
  const agency = ((row as any)['Агенство'] || '').toString().trim() || null;
  return { phoneRaw, name, agency };
}
