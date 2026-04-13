// amoCRM IDs for stmichael account

export const AMO_PIPELINES = {
  ZORGE9: 7600550,
  BERZARINA: 7600546,         // Серебряный бор
  TOLBUKHINA: 7600554,
  KC: 7600542,                // Колл-центр
  BROKERS: 10787390,          // Воронка брокеров
} as const;

export const AMO_STATUS_FINAL_WON = 142;
export const AMO_STATUS_FINAL_LOST = 143;

// Pipeline → Project (для маппинга в локальную БД)
export function pipelineToProject(pipelineId: number): 'ZORGE9' | 'SILVER_BOR' {
  if (pipelineId === AMO_PIPELINES.BERZARINA) return 'SILVER_BOR';
  return 'ZORGE9';
}

// amoCRM lead status → local DealStatus
export function statusToDealStatus(statusId: number): 'PENDING' | 'SIGNED' | 'PAID' | 'COMMISSION_PAID' | 'CANCELLED' {
  if (statusId === AMO_STATUS_FINAL_LOST) return 'CANCELLED';
  if (statusId === AMO_STATUS_FINAL_WON) return 'COMMISSION_PAID';
  // "Сделка зарегистрирована" в воронках Зорге9/Берзарина/Толбухина
  if ([62907454, 62907382, 62907594, 28905292].includes(statusId)) return 'SIGNED';
  // "Контроль оплаты"
  if ([62907458, 62907386, 62907598, 33935695].includes(statusId)) return 'PAID';
  // "ДВОУ (Платная бронь)"
  if ([62907442, 62907370, 62907582, 33935671].includes(statusId)) return 'SIGNED';
  return 'PENDING';
}

// Status IDs that represent actual deals (Сделка, Сделка зарегистрирована, Контроль оплаты, Успешно реализовано)
export const AMO_DEAL_STATUSES = new Set([
  // Воронка Зорге9
  62907450, 62907454, 62907458,
  // Воронка Берзарина
  62907378, 62907382, 62907386,
  // Воронка Толбухина
  62907590, 62907594, 62907598,
  // Продажи (старая воронка)
  28905289, 28905292, 33935695,
  // Финальный "Успешно реализовано" (общий для всех воронок)
  142,
]);

export function isDealStage(statusId: number): boolean {
  return AMO_DEAL_STATUSES.has(statusId);
}

export const AMO_CONTACT_FIELDS = {
  PHONE: 557903,
  EMAIL: 557905,
  POSITION: 557901,
  INN: 834489,
  IS_BROKER: 835415,         // checkbox "Брокер"
  AGENCY_NAME: 835417,       // text "Агенство"
  TELEGRAM_USERNAME: 835983,
  TELEGRAM_ID: 835985,
  WHATSAPP_USERNAME: 842321,
  BROKER_TOUR_VISITED: 842303,
  BROKER_TOUR_DATE: 842305,
  BLACKLIST: 834665,
  REGION: 589265,
  PRESENTATION_SENT: 835955,
  ADDITIONAL_COMPANIES: 842329,
} as const;
