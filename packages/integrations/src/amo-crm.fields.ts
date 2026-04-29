// amoCRM IDs for stmichael account

export const AMO_PIPELINES = {
  ZORGE9: 7600550,
  BERZARINA: 7600546,         // Серебряный бор
  TOLBUKHINA: 7600554,
  KC: 7600542,                // Колл-центр
  BROKERS: 10787390,          // Воронка брокеров — основной источник данных для ЛК
} as const;

export const AMO_STATUS_FINAL_WON = 142;
export const AMO_STATUS_FINAL_LOST = 143;

// Stages of "Воронка брокеров" (10787390)
export const AMO_BROKER_STAGE = {
  NEW: 84932446,           // Новый брокер
  TOUR: 84932450,          // Брокер-тур
  FIXATION: 84932454,      // Фиксации на уникальность
  MEETING: 84932514,       // Встреча
  DEAL: 84932518,          // Сделка
} as const;

export const BROKER_PIPELINE_ID = AMO_PIPELINES.BROKERS;

// Pipeline → Project (для маппинга в локальную БД)
export function pipelineToProject(pipelineId: number): 'ZORGE9' | 'SILVER_BOR' {
  if (pipelineId === AMO_PIPELINES.BERZARINA) return 'SILVER_BOR';
  return 'ZORGE9';
}

// Determine project from lead custom fields (e.g. "Объект интереса")
export function leadToProject(lead: any): 'ZORGE9' | 'SILVER_BOR' {
  const cf = lead?.custom_fields_values || [];
  const interest = cf.find((f: any) =>
    /объект интереса|объект|корпус/i.test(String(f?.field_name || '')),
  );
  const val = String(interest?.values?.[0]?.value || '').toLowerCase();
  if (/берзарин|серебр|silver/i.test(val)) return 'SILVER_BOR';
  if (/зорге|zorge/i.test(val)) return 'ZORGE9';
  return pipelineToProject(lead?.pipeline_id || 0);
}

// amoCRM lead status → local DealStatus
export function statusToDealStatus(statusId: number): 'PENDING' | 'SIGNED' | 'PAID' | 'COMMISSION_PAID' | 'CANCELLED' {
  if (statusId === AMO_STATUS_FINAL_LOST) return 'CANCELLED';
  if (statusId === AMO_STATUS_FINAL_WON) return 'COMMISSION_PAID';
  // Broker pipeline: "Сделка"
  if (statusId === AMO_BROKER_STAGE.DEAL) return 'SIGNED';
  // "Сделка зарегистрирована"
  if ([62907454, 62907382, 62907594, 28905292].includes(statusId)) return 'SIGNED';
  // "Контроль оплаты"
  if ([62907458, 62907386, 62907598, 33935695].includes(statusId)) return 'PAID';
  // "ДВОУ (Платная бронь)"
  if ([62907442, 62907370, 62907582, 33935671].includes(statusId)) return 'SIGNED';
  return 'PENDING';
}

// Status IDs where meeting was held — ONLY broker pipeline stages
export const AMO_MEETING_HELD_STATUSES = new Set([
  // Воронка брокеров — после стадии "Встреча" считается, что встреча проведена
  AMO_BROKER_STAGE.DEAL,   // Сделка → встреча уже была
  // Финальный "Успешно реализовано"
  142,
]);

export function mapMeetingStatus(statusId: number): 'PENDING' | 'COMPLETED' | 'CANCELLED' {
  if (statusId === 143) return 'CANCELLED';
  if (AMO_MEETING_HELD_STATUSES.has(statusId)) return 'COMPLETED';
  return 'PENDING';
}

// Status IDs that represent actual deals — ONLY in broker pipeline
export const AMO_DEAL_STATUSES = new Set([
  AMO_BROKER_STAGE.DEAL,    // Сделка
  142,                       // Успешно реализовано
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
