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

// 2026-06-03: ID стадий воронок для алгоритма уникальности.
// Дампнуты через inspect-amo-fields --entity pipelines.
//
// ВАЖНО: в КЦ статус 142 = «Встреча проведена» (конец КЦ), а в ОП 142 = «Успешно реализовано».
//        Статус 143 везде = «Закрыто и не реализовано».
export const AMO_KC_STATUS = {
  UNSORTED: 62907114,
  NEW_REQUEST: 62907118,       // Новое обращение
  NO_ANSWER: 62907122,
  DEFERRED: 62907126,          // Отложенный спрос
  QUALIFIED: 62907282,         // Классифицировали, выводим на встречу
  MEETING_SCHEDULED: 62907286, // Встреча назначена
  MEETING_HELD: 142,           // Встреча проведена (final КЦ)
  CLOSED_LOST: 143,            // Закрыто и не реализовано
} as const;

export const AMO_BERZARINA_STATUS = {
  UNSORTED: 62907130,
  NEW_LEAD: 62907134,          // Новый Лид (= «Новое обращение» в логике)
  DEFERRED: 64421962,
  QUALIFIED: 62907138,         // Квалификация, выводим на встречу
  MEETING_SCHEDULED: 62907142,
  MEETING_DONE_THINKING: 62907358,
  ORAL_BOOKING: 62907362,
  BOOKING_REMOVED: 62907366,
  PAID_BOOKING: 62907370,
  DEAL_PREP: 62907374,
  DEAL: 62907378,
  DEAL_REGISTERED: 62907382,
  PAYMENT_CONTROL: 62907386,
  SUCCESS: 142,
  CLOSED_LOST: 143,
} as const;

export const AMO_ZORGE_STATUS = {
  UNSORTED: 62907146,
  NEW_LEAD: 62907150,          // Новый Лид
  DEFERRED: 64421046,
  QUALIFIED: 62907154,         // Квалификация, выводим на встречу
  MEETING_SCHEDULED: 62907158,
  MEETING_DONE_THINKING: 62907430,
  ORAL_BOOKING: 62907434,
  BOOKING_REMOVED: 62907438,
  PAID_BOOKING: 62907442,
  DEAL_PREP: 62907446,
  DEAL: 62907450,
  DEAL_REGISTERED: 62907454,
  PAYMENT_CONTROL: 62907458,
  SUCCESS: 142,
  CLOSED_LOST: 143,
} as const;

export const AMO_TOLBUKHINA_STATUS = {
  UNSORTED: 62907162,
  NEW_LEAD: 62907166,
  DEFERRED: 64421050,
  QUALIFIED: 62907170,
  MEETING_SCHEDULED: 62907174,
  MEETING_DONE_THINKING: 62907570,
  ORAL_BOOKING: 62907574,
  BOOKING_REMOVED: 62907578,
  PAID_BOOKING: 62907582,
  DEAL_PREP: 62907586,
  DEAL: 62907590,
  DEAL_REGISTERED: 62907594,
  PAYMENT_CONTROL: 62907598,
  SUCCESS: 142,
  CLOSED_LOST: 143,
} as const;

// ─── Хелперы для алгоритма уникальности ───────────────────────────────

/** Лид в статусе «Новое обращение» / «Новый Лид» (первая активная стадия). */
export function isNewRequestStatus(pipelineId: number, statusId: number): boolean {
  return (
    (pipelineId === AMO_PIPELINES.KC && statusId === AMO_KC_STATUS.NEW_REQUEST) ||
    (pipelineId === AMO_PIPELINES.BERZARINA && statusId === AMO_BERZARINA_STATUS.NEW_LEAD) ||
    (pipelineId === AMO_PIPELINES.ZORGE9 && statusId === AMO_ZORGE_STATUS.NEW_LEAD) ||
    (pipelineId === AMO_PIPELINES.TOLBUKHINA && statusId === AMO_TOLBUKHINA_STATUS.NEW_LEAD)
  );
}

/** Лид в статусе «Квалифицировали выводим на встречу» (в любой из ОП/КЦ воронок). */
export function isQualifiedToMeetingStatus(pipelineId: number, statusId: number): boolean {
  return (
    (pipelineId === AMO_PIPELINES.KC && statusId === AMO_KC_STATUS.QUALIFIED) ||
    (pipelineId === AMO_PIPELINES.BERZARINA && statusId === AMO_BERZARINA_STATUS.QUALIFIED) ||
    (pipelineId === AMO_PIPELINES.ZORGE9 && statusId === AMO_ZORGE_STATUS.QUALIFIED) ||
    (pipelineId === AMO_PIPELINES.TOLBUKHINA && statusId === AMO_TOLBUKHINA_STATUS.QUALIFIED)
  );
}

/** Финальный статус «Закрыто и не реализовано» (143 — во всех воронках). */
export function isClosedLostStatus(statusId: number): boolean {
  return statusId === 143;
}

/** Финал КЦ: «Встреча проведена» (142 для пайплайна КЦ). Считаем как «КЦ завершён». */
export function isKcMeetingHeldStatus(pipelineId: number, statusId: number): boolean {
  return pipelineId === AMO_PIPELINES.KC && statusId === 142;
}

/**
 * 2026-06-03: алгоритм проверки уникальности по правилам пользователя.
 *
 * Контекст: при фиксации брокером нового клиента нужно понять, конкурирует ли
 * он с уже идущей работой по этому контакту. Только акт осмотра, подписанный
 * на встрече, окончательно закрепляет клиента за брокером — до этого момента
 * несколько брокеров могут одновременно быть «условно уникальными».
 *
 * Правила:
 *   1) Контакт в amo не найден или у него нет лидов → УНИКАЛЬНЫЙ.
 *   2) Все лиды контакта в финальных статусах (143 везде или КЦ 142) → УНИКАЛЬНЫЙ.
 *   3) Активный лид в «Новое обращение» / «Квалифицировали выводим на встречу»
 *      И к нему прикреплён хоть один брокер → УНИКАЛЬНЫЙ для следующего брокера.
 *   4) Любой другой активный статус (Встреча назначена / Сделка / Контроль оплаты
 *      и т.д.) → АЛАРМ, статус «В обработке», ручная проверка КЦ.
 *
 * Возвращает 'UNIQUE' если все лиды прошли, иначе 'ALARM'.
 */
export function evaluateUniqueness(
  leads: Array<{
    id: number;
    pipeline_id: number;
    status_id: number;
    hasBrokerAttached: boolean;
  }>,
): { verdict: 'UNIQUE' | 'ALARM'; reason: string } {
  if (!leads || leads.length === 0) {
    return { verdict: 'UNIQUE', reason: 'Контакт в amoCRM не найден или нет лидов' };
  }

  for (const lead of leads) {
    // Финальные стадии — пропускаем (правило 2).
    if (isClosedLostStatus(lead.status_id)) continue;
    if (isKcMeetingHeldStatus(lead.pipeline_id, lead.status_id)) continue;

    // Активные допустимые стадии (правила 3, 4).
    const isAllowedStage =
      isNewRequestStatus(lead.pipeline_id, lead.status_id) ||
      isQualifiedToMeetingStatus(lead.pipeline_id, lead.status_id);

    if (isAllowedStage) {
      if (lead.hasBrokerAttached) {
        continue; // ОК, продолжаем проверку
      } else {
        return {
          verdict: 'ALARM',
          reason: `Лид ${lead.id} в активной стадии без привязанного брокера (pipeline=${lead.pipeline_id}, status=${lead.status_id}).`,
        };
      }
    }

    // Всё остальное — Встреча назначена / Сделка / Контроль оплаты и т.д.
    return {
      verdict: 'ALARM',
      reason: `Лид ${lead.id} в активной стадии продаж (pipeline=${lead.pipeline_id}, status=${lead.status_id}). Требуется ручная проверка КЦ.`,
    };
  }

  return { verdict: 'UNIQUE', reason: 'Все лиды контакта проверены — конфликта нет' };
}

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
  // Поля воронки КЦ (используются при createFixationRequest) — узнаны
  // через debug-endpoint 2026-05-22.
  FROM_BROKER: 665195,               // radiobutton "От брокера"
  PURCHASE_TIMING: 612517,           // select "Планирует покупку в срок"
  READINESS_LEVEL: 839449,           // select "Готовность к сделке"
  QUESTIONNAIRE_FILLED: 842273,      // select "Опросник заполнен"
  BROKER_REQUEST_DATE: 833189,       // date "Дата создания заявки от брокера" (unix sec)
} as const;

// Enum values для select/radio полей лида КЦ.
export const AMO_LEAD_ENUMS = {
  FROM_BROKER_YES: 985337,
  FROM_BROKER_NO: 985339,
  // Готовность к сделке
  READINESS_HOT: 1025401,            // ☀️ Горячий
  READINESS_WARM: 1025403,           // ⛅️ Тёплый
  READINESS_COLD: 1025405,           // ❄️ Холодный
  // Опросник заполнен
  QUESTIONNAIRE_YES: 1028039,
  QUESTIONNAIRE_NO: 1028041,
  // Планирует покупку
  PURCHASE_1_TO_3_MONTHS: 890509,
  PURCHASE_3_TO_6_MONTHS: 890511,
  PURCHASE_OVER_5_MONTHS: 890513,    // в amo это «от 5 месяцев»
  PURCHASE_NOT_CLARIFIED: 891589,
} as const;

// Маппинг из строки UI в enum_id amoCRM для readinessLevel.
export function readinessLevelToEnumId(value: string | null | undefined): number | null {
  if (!value) return null;
  const v = value.toLowerCase().replace(/[^а-яё]/g, '');
  if (v.includes('горяч')) return AMO_LEAD_ENUMS.READINESS_HOT;
  if (v.includes('тёпл') || v.includes('тепл')) return AMO_LEAD_ENUMS.READINESS_WARM;
  if (v.includes('холод')) return AMO_LEAD_ENUMS.READINESS_COLD;
  return null;
}

// Маппинг purchaseTiming из строки UI в enum_id amoCRM.
export function purchaseTimingToEnumId(value: string | null | undefined): number | null {
  if (!value) return null;
  const v = value.toLowerCase();
  if (v.includes('1') && v.includes('3')) return AMO_LEAD_ENUMS.PURCHASE_1_TO_3_MONTHS;
  if (v.includes('3') && v.includes('6')) return AMO_LEAD_ENUMS.PURCHASE_3_TO_6_MONTHS;
  if (v.includes('6') || v.includes('12') || v.includes('более')) return AMO_LEAD_ENUMS.PURCHASE_OVER_5_MONTHS;
  if (v.includes('выясн') || v.includes('не указ')) return AMO_LEAD_ENUMS.PURCHASE_NOT_CLARIFIED;
  return null;
}

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
