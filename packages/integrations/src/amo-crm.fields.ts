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
  if (statusId === AMO_STATUS_FINAL_WON) return 'PAID';
  // Правка 2026-05-13: amoCRM status 142 'Успешно реализовано' = клиент полностью
  // оплатил сделку. Это НЕ значит что компания выплатила комиссию брокеру —
  // выплата комиссии происходит позже, отдельным процессом, и должна
  // выставлять COMMISSION_PAID руками (через админку/финансиста).
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

// Status IDs where meeting was held (Встреча проведена и далее)
export const AMO_MEETING_HELD_STATUSES = new Set([
  // Воронка Зорге9 — от "Встреча проведена, думают" и далее
  62907430, 62907434, 62907438, 62907442, 62907446, 62907450, 62907454, 62907458,
  // Воронка Берзарина
  62907358, 62907362, 62907366, 62907370, 62907374, 62907378, 62907382, 62907386,
  // Воронка Толбухина
  62907570, 62907574, 62907578, 62907582, 62907586, 62907590, 62907594, 62907598,
  // Продажи
  28905214, 28905280, 33935671, 28905283, 28905289, 28905292, 33935695, 42176281,
  // Подогрев
  29126935,
  // Воронка брокеров — Сделка → встреча уже была
  AMO_BROKER_STAGE.DEAL,
  // Финальный "Успешно реализовано" / "Встреча проведена"
  142,
]);

export function mapMeetingStatus(statusId: number): 'PENDING' | 'COMPLETED' | 'CANCELLED' {
  if (statusId === 143) return 'CANCELLED';
  if (AMO_MEETING_HELD_STATUSES.has(statusId)) return 'COMPLETED';
  return 'PENDING';
}

// Status IDs that represent actual deals across all client pipelines
export const AMO_DEAL_STATUSES = new Set([
  // Воронка Зорге9
  62907450, 62907454, 62907458,
  // Воронка Берзарина
  62907378, 62907382, 62907386,
  // Воронка Толбухина
  62907590, 62907594, 62907598,
  // Продажи (старая)
  28905289, 28905292, 33935695,
  // Воронка брокеров — Сделка
  AMO_BROKER_STAGE.DEAL,
  // Финальный "Успешно реализовано"
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

/**
 * Маппинг Broker (Prisma модель) в массив custom_fields_values для amoCRM
 * contact update. Источник истины — БД нашего кабинета: всё что заполнено
 * в Broker и связанной primary Agency идёт в amo при ЛЮБОМ изменении
 * профиля (register, PATCH /auth/me, изменение из админки и т.д.).
 *
 * Поля Broker, у которых НЕТ field_id в amo (пока не маппятся):
 * - birthDate (нет AMO_CONTACT_FIELDS.BIRTH_DATE — нужно узнать ID)
 * - specialization (COMM/RESIDENTIAL/BOTH — нужно поле в amo)
 * - bestCallTime (нет в amo)
 * - isCoordinator / coordinatorAgency (нет в amo)
 *
 * Поля amo, для которых нет колонки в Broker (нужны в БД, чтобы заполнять):
 * - POSITION (должность)
 * - TELEGRAM_USERNAME, TELEGRAM_ID, WHATSAPP_USERNAME
 * - PRESENTATION_SENT, ADDITIONAL_COMPANIES
 */
export function brokerToAmoContactFields(
  broker: {
    phone?: string | null;
    email?: string | null;
    region?: string | null;
    position?: string | null;
    telegramUsername?: string | null;
    telegramId?: string | null;
    whatsappUsername?: string | null;
    presentationSent?: boolean | null;
    brokerTourVisited?: boolean | null;
    brokerTourDate?: Date | string | null;
    doNotCall?: boolean | null;
  },
  agency?: { name?: string | null; inn?: string | null } | null,
): any[] {
  const fields: any[] = [];

  // Контакт всегда помечается флагом "Брокер" — это критерий поиска
  // в /admin/brokers/import-from-amo.
  fields.push({ field_id: AMO_CONTACT_FIELDS.IS_BROKER, values: [{ value: true }] });

  if (broker.phone) {
    fields.push({
      field_id: AMO_CONTACT_FIELDS.PHONE,
      values: [{ value: broker.phone, enum_code: 'WORK' }],
    });
  }
  if (broker.email) {
    fields.push({
      field_id: AMO_CONTACT_FIELDS.EMAIL,
      values: [{ value: broker.email, enum_code: 'WORK' }],
    });
  }
  if (broker.position) {
    fields.push({ field_id: AMO_CONTACT_FIELDS.POSITION, values: [{ value: broker.position }] });
  }
  if (agency?.inn) {
    fields.push({ field_id: AMO_CONTACT_FIELDS.INN, values: [{ value: agency.inn }] });
  }
  if (agency?.name) {
    fields.push({ field_id: AMO_CONTACT_FIELDS.AGENCY_NAME, values: [{ value: agency.name }] });
  }
  if (broker.telegramUsername) {
    fields.push({
      field_id: AMO_CONTACT_FIELDS.TELEGRAM_USERNAME,
      values: [{ value: broker.telegramUsername }],
    });
  }
  if (broker.telegramId) {
    fields.push({
      field_id: AMO_CONTACT_FIELDS.TELEGRAM_ID,
      values: [{ value: broker.telegramId }],
    });
  }
  if (broker.whatsappUsername) {
    fields.push({
      field_id: AMO_CONTACT_FIELDS.WHATSAPP_USERNAME,
      values: [{ value: broker.whatsappUsername }],
    });
  }
  if (broker.region) {
    fields.push({ field_id: AMO_CONTACT_FIELDS.REGION, values: [{ value: broker.region }] });
  }
  if (broker.brokerTourVisited) {
    fields.push({
      field_id: AMO_CONTACT_FIELDS.BROKER_TOUR_VISITED,
      values: [{ value: true }],
    });
  }
  if (broker.brokerTourDate) {
    const d = new Date(broker.brokerTourDate);
    if (!isNaN(d.getTime())) {
      fields.push({
        field_id: AMO_CONTACT_FIELDS.BROKER_TOUR_DATE,
        values: [{ value: Math.floor(d.getTime() / 1000) }],
      });
    }
  }
  if (broker.presentationSent) {
    fields.push({
      field_id: AMO_CONTACT_FIELDS.PRESENTATION_SENT,
      values: [{ value: true }],
    });
  }
  if (broker.doNotCall) {
    fields.push({ field_id: AMO_CONTACT_FIELDS.BLACKLIST, values: [{ value: true }] });
  }

  return fields;
}

/**
 * Custom field IDs on Lead entity. Discovered 2026-05-12 via inspect-lead/32112013.
 * Применяются при синхронизации сделок (amocrm.service.ts, scheduler.service.ts).
 */
export const AMO_LEAD_FIELDS = {
  // Метраж сделки в м² — основное поле для расчёта commission level.
  // Раньше всегда было 0, поэтому level=START.
  SQM: 604555,                       // text "Метраж, м2"
  // ID помещения в Profitbase — для привязки к Lot.
  PROFITBASE_LOT_ID: 604559,         // text "ID помещения"
  PRICE_PER_SQM: 604557,             // text "Цена за м2, руб"
  FLOOR: 604551,                     // text "Этаж"
  BUILDING: 604547,                  // text "Дом" (например "Корпус 1. Gold")
  ROOMS_COUNT: 617501,               // text "Кол-во комнат"
  LIVING_AREA: 617505,               // text "Жилая площадь"
  PRICE_NO_DISCOUNT: 833045,         // text "Стоимость без скидок, руб"
  PRICE_WITH_DISCOUNT: 833069,       // text "Стоимость с учетом скидки, руб"
  PRICE_DDU: 833065,                 // text "Стоимость в ДДУ, руб"
  CONTRACT_NUMBER: 558577,           // text "№ договора"
  CONTRACT_TYPE: 617493,             // text "Тип договора" (fz214 и т.д.)
  CONTRACT_DATE: 558353,             // date "Дата договора" (unix sec)
  // Объект интереса (используется как fallback к pipeline_id для маппинга проекта).
  INTEREST_OBJECT: 839179,           // text "Объект интереса"
  // ДЕДУПЛИКАЦИЯ: amoCRM хранит связь между дубликатами карточек.
  // У дочерней карточки cc_id_parent указывает на ID родительской.
  // Используем это для объединения дублей при синке.
  CC_ID_PARENT: 839249,              // text "cc_id_parent" — id парной сделки
  // Ссылка на сделку в "Воронке брокеров" (третья копия одной и той же сделки).
  BROKER_PIPELINE_LINK: 842387,      // text "Сделка в Брокерах"
  // Комиссия — проставляется руками менеджером в amoCRM. Авторитет, не считаем локально.
  COMMISSION_AMOUNT: 673171,         // text "Комиссия в руб."
  COMMISSION_RATE: 673169,           // text "Комиссия брокера в %"
} as const;

/**
 * Helper: достать значение custom field по field_id.
 * Возвращает строку или null.
 */
export function getLeadCustomFieldValue(lead: any, fieldId: number): string | null {
  const cf = (lead?.custom_fields_values || []).find((f: any) => f?.field_id === fieldId);
  const v = cf?.values?.[0]?.value;
  return v != null && v !== '' ? String(v) : null;
}

/**
 * Helper: достать число из custom field. Возвращает 0 если нет/невалид.
 */
export function getLeadCustomFieldNumber(lead: any, fieldId: number): number {
  const v = getLeadCustomFieldValue(lead, fieldId);
  if (!v) return 0;
  // Поля типа "46.85" или "29637780" — стандартный парсинг.
  const n = Number(String(v).replace(/\s/g, '').replace(/,/g, '.'));
  return isNaN(n) ? 0 : n;
}
