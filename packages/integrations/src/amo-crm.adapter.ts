import { Project } from '@st-michael/shared';
import {
  AMO_LEAD_FIELDS, AMO_LEAD_ENUMS,
  readinessLevelToEnumId, purchaseTimingToEnumId,
} from './amo-crm.fields';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface AmoContact {
  id: number;
  name: string;
  first_name?: string;
  last_name?: string;
  custom_fields_values?: any[];
  created_at?: number;
  updated_at?: number;
  _embedded?: any;
}

export interface AmoCompany {
  id: number;
  name: string;
  custom_fields_values?: any[];
  created_at?: number;
  updated_at?: number;
}

export interface AmoLead {
  id: number;
  name: string;
  price?: number;
  status_id?: number;
  pipeline_id?: number;
  created_at?: number;
  updated_at?: number;
  responsible_user_id?: number;
  custom_fields_values?: any[];
  contacts?: { id: number }[];
  companies?: { id: number }[];
  _embedded?: any;
}

export interface CreateContactDto {
  name: string;
  first_name?: string;
  last_name?: string;
  custom_fields_values?: any[];
}

export interface CreateCompanyDto {
  name: string;
  custom_fields_values?: any[];
}

export interface CreateLeadDto {
  name: string;
  price?: number;
  status_id?: number;
  pipeline_id?: number;
  contacts?: { id: number }[];
  companies?: { id: number }[];
  custom_fields_values?: any[];
}

export interface UpdateLeadDto {
  name?: string;
  price?: number;
  status_id?: number;
  custom_fields_values?: any[];
}

export class AmoCrmAdapter {
  private baseUrl: string;
  private token: string;

  constructor() {
    const subdomain = process.env.AMO_SUBDOMAIN || 'stmichael';
    const domain = process.env.AMO_BASE_DOMAIN || 'amocrm.ru';
    this.baseUrl = `https://${subdomain}.${domain}/api/v4`;
    this.token = process.env.AMO_ACCESS_TOKEN || '';
  }

  // КБ6 fix #44 (2026-05-25): retry с экспоненциальным backoff для 429/5xx.
  // amoCRM v4 ограничивает 7 req/sec — без retry массовый импорт ловит сотни
  // 429 (наблюдали 776 amoErrors на coverage-анализ).
  private async request<T = any>(path: string, init: RequestInit = {}, attempt = 1): Promise<T> {
    if (!this.token) throw new Error('AMO_ACCESS_TOKEN not configured');

    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          ...(init.headers || {}),
        },
      });
    } catch (e: any) {
      // Network-level (timeout, ECONNRESET) — ретраим до 3 раз.
      if (attempt < 3) {
        await sleep(500 * attempt);
        return this.request<T>(path, init, attempt + 1);
      }
      throw e;
    }

    if (res.status === 204) return null as T;

    // 429 (rate-limit) и 5xx — retry. Уважаем Retry-After если пришёл.
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      const retryAfter = Number(res.headers.get('Retry-After')) || 0;
      const wait = retryAfter > 0 ? retryAfter * 1000 : 300 * Math.pow(2, attempt); // 300 / 600 / 1200ms
      await sleep(wait);
      return this.request<T>(path, init, attempt + 1);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`amoCRM ${res.status} ${path}: ${text.slice(0, 200)}`);
    }
    return res.json() as Promise<T>;
  }

  // === Account info ===
  async getAccount(): Promise<any> {
    return this.request('/account');
  }

  // === Contacts ===
  async findContactByPhone(phone: string): Promise<AmoContact | null> {
    const query = encodeURIComponent(phone);
    try {
      const data = await this.request<any>(`/contacts?query=${query}&limit=50`);
      const contacts = data?._embedded?.contacts || [];
      return contacts[0] || null;
    } catch {
      return null;
    }
  }

  async findBrokerContactByPhone(phone: string): Promise<AmoContact | null> {
    const query = encodeURIComponent(phone);
    try {
      const data = await this.request<any>(`/contacts?query=${query}&limit=50`);
      const contacts: any[] = data?._embedded?.contacts || [];
      // Filter contacts with "Брокер" checkbox = true
      const brokerCandidates = contacts.filter((c: any) => {
        const fields = c.custom_fields_values || [];
        const brokerField = fields.find((f: any) => f.field_id === 835415);
        return brokerField?.values?.[0]?.value === true;
      });
      if (brokerCandidates.length === 0) return null;
      if (brokerCandidates.length === 1) return brokerCandidates[0];

      // Multiple broker candidates — pick the one with the most linked leads
      let best: any = null;
      let bestLeads = -1;
      for (const cand of brokerCandidates) {
        const full = await this.getContact(cand.id);
        const leadsCount = full?._embedded?.leads?.length || 0;
        if (leadsCount > bestLeads) {
          bestLeads = leadsCount;
          best = full || cand;
        }
      }
      return best;
    } catch {
      return null;
    }
  }

  async getContact(id: number): Promise<AmoContact | null> {
    try { return await this.request<AmoContact>(`/contacts/${id}?with=leads`); }
    catch { return null; }
  }

  // КБ6 fix #44 (2026-05-25): bulk-получение контактов пачками до 250.
  // amoCRM API позволяет filter[id][]=…&filter[id][]=… (до 250 ID в одном запросе).
  // Это ~250x меньше HTTP-запросов чем перебор по одному.
  // Возвращает Map<id, AmoContact> с найденными контактами. Те, что не вернулись,
  // в map просто отсутствуют — вызывающий код решает, ошибка это или нет.
  async getContactsByIds(ids: number[]): Promise<Map<number, AmoContact>> {
    const result = new Map<number, AmoContact>();
    const BATCH = 250;
    for (let i = 0; i < ids.length; i += BATCH) {
      const chunk = ids.slice(i, i + BATCH);
      const q = chunk.map((id) => `filter[id][]=${id}`).join('&');
      try {
        const data = await this.request<any>(`/contacts?${q}&with=leads&limit=${BATCH}`);
        const list: AmoContact[] = data?._embedded?.contacts || [];
        for (const c of list) result.set(Number(c.id), c);
      } catch (e: any) {
        // Pacht прошёл с ошибкой — оставляем missing, не валим всю операцию.
        console.error('[getContactsByIds] batch failed:', e?.message || e);
      }
      // Лёгкая задержка между пачками чтобы не словить 429 на больших объёмах.
      if (i + BATCH < ids.length) await sleep(150);
    }
    return result;
  }

  async createContact(data: CreateContactDto): Promise<AmoContact> {
    const result = await this.request<any>('/contacts', {
      method: 'POST',
      body: JSON.stringify([data]),
    });
    return result?._embedded?.contacts?.[0];
  }

  async updateContact(id: number, data: Partial<CreateContactDto>): Promise<void> {
    await this.request(`/contacts/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  }

  // Добавить примечание к лиду в amoCRM. Используется для уведомления
  // менеджеров о действиях брокера (создал встречу, оператор зафиксировал
  // звонок и т.д.) — пока не настроены полноценные custom_fields.
  async addNoteToLead(leadId: number, text: string): Promise<void> {
    await this.request(`/leads/${leadId}/notes`, {
      method: 'POST',
      body: JSON.stringify([{ note_type: 'common', params: { text } }]),
    });
  }

  // 2026-05-26: задача в amoCRM с дедлайном и текстом.
  // Появляется в задачах сотрудника КЦ → отработает.
  // entityType: 'leads' | 'contacts' | 'companies'
  // taskTypeId: 1 = звонок, 2 = встреча, 3+ = кастомные (зависит от настроек amoCRM)
  // completeTill: unix timestamp в секундах (когда задача должна быть выполнена)
  async createTask(data: {
    text: string;
    entityType: 'leads' | 'contacts' | 'companies';
    entityId: number;
    completeTillSec?: number; // default: +24h
    taskTypeId?: number; // default: 1 (звонок)
    responsibleUserId?: number; // если знаем кому именно
  }): Promise<void> {
    const completeTill = data.completeTillSec || Math.floor(Date.now() / 1000) + 24 * 60 * 60;
    const body: any = {
      text: data.text,
      complete_till: completeTill,
      entity_type: data.entityType,
      entity_id: data.entityId,
      task_type_id: data.taskTypeId || 1,
    };
    if (data.responsibleUserId) body.responsible_user_id = data.responsibleUserId;
    await this.request('/tasks', {
      method: 'POST',
      body: JSON.stringify([body]),
    });
  }

  async addNoteToContact(contactId: number, text: string): Promise<void> {
    await this.request(`/contacts/${contactId}/notes`, {
      method: 'POST',
      body: JSON.stringify([{ note_type: 'common', params: { text } }]),
    });
  }

  // === Companies ===
  async findCompanyByInn(inn: string): Promise<AmoCompany | null> {
    try {
      const data = await this.request<any>(`/companies?query=${encodeURIComponent(inn)}`);
      const companies = data?._embedded?.companies || [];
      return companies[0] || null;
    } catch {
      return null;
    }
  }

  async createCompany(data: CreateCompanyDto): Promise<AmoCompany> {
    const result = await this.request<any>('/companies', {
      method: 'POST',
      body: JSON.stringify([data]),
    });
    return result?._embedded?.companies?.[0];
  }

  async linkContactToCompany(contactId: number, companyId: number): Promise<void> {
    await this.request(`/contacts/${contactId}/link`, {
      method: 'POST',
      body: JSON.stringify([{ to_entity_id: companyId, to_entity_type: 'companies' }]),
    });
  }

  // === Leads (deals) ===
  async getLead(id: number): Promise<AmoLead | null> {
    try { return await this.request<AmoLead>(`/leads/${id}?with=contacts,companies`); }
    catch { return null; }
  }

  async createLead(data: CreateLeadDto): Promise<AmoLead> {
    // amoCRM API v4 ждёт contacts/companies в _embedded, не на верхнем уровне.
    // До правки 2026-05-15 контакты передавались на верхнем уровне → терялись,
    // лид создавался "сиротой" без привязки к контакту.
    const { contacts, companies, ...rest } = data as any;
    const payload: any = { ...rest };
    if (contacts || companies) {
      payload._embedded = {};
      if (contacts) payload._embedded.contacts = contacts;
      if (companies) payload._embedded.companies = companies;
    }
    const result = await this.request<any>('/leads', {
      method: 'POST',
      body: JSON.stringify([payload]),
    });
    return result?._embedded?.leads?.[0];
  }

  async updateLead(id: number, data: UpdateLeadDto): Promise<void> {
    await this.request(`/leads/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  }

  async getLeadsByContact(contactId: number): Promise<AmoLead[]> {
    try {
      const contact = await this.request<any>(`/contacts/${contactId}?with=leads`);
      const leadIds = (contact?._embedded?.leads || []).map((l: any) => l.id);
      if (leadIds.length === 0) return [];
      const leads: AmoLead[] = [];
      // Fetch leads in batches
      const ids = leadIds.join(',');
      const data = await this.request<any>(`/leads?filter[id][]=${leadIds.join('&filter[id][]=')}`);
      return data?._embedded?.leads || [];
    } catch {
      return [];
    }
  }

  async getLeadsByPipeline(pipelineId: number, limit = 250): Promise<AmoLead[]> {
    const allLeads: AmoLead[] = [];
    let page = 1;
    try {
      while (true) {
        const data = await this.request<any>(
          `/leads?filter[pipeline_id][]=${pipelineId}&limit=${limit}&page=${page}&with=contacts`,
        );
        const leads = data?._embedded?.leads || [];
        if (leads.length === 0) break;
        allLeads.push(...leads);
        if (leads.length < limit) break;
        page++;
        if (page > 20) break; // safety
      }
    } catch {}
    return allLeads;
  }

  async getLeadsByResponsibleUser(userId: number, limit = 250): Promise<AmoLead[]> {
    const allLeads: AmoLead[] = [];
    let page = 1;
    try {
      while (true) {
        const data = await this.request<any>(
          `/leads?filter[responsible_user_id][]=${userId}&limit=${limit}&page=${page}&with=contacts`,
        );
        const leads = data?._embedded?.leads || [];
        if (leads.length === 0) break;
        allLeads.push(...leads);
        if (leads.length < limit) break;
        page++;
      }
    } catch {}
    return allLeads;
  }

  async reopenLead(id: number, newBrokerAmoId: number): Promise<AmoLead> {
    await this.updateLead(id, { status_id: 142 } as any);
    return (await this.getLead(id))!;
  }

  async getLeadStage(leadId: number): Promise<string> {
    const lead = await this.getLead(leadId);
    return lead?.status_id ? String(lead.status_id) : '';
  }

  // === Pipelines ===
  async getPipelines(): Promise<any[]> {
    const data = await this.request<any>('/leads/pipelines');
    return data?._embedded?.pipelines || [];
  }

  // === Custom fields ===
  async getContactCustomFields(): Promise<any[]> {
    const data = await this.request<any>('/contacts/custom_fields');
    return data?._embedded?.custom_fields || [];
  }

  async getCompanyCustomFields(): Promise<any[]> {
    const data = await this.request<any>('/companies/custom_fields');
    return data?._embedded?.custom_fields || [];
  }

  // === Users ===
  async getUsers(): Promise<any[]> {
    const data = await this.request<any>('/users');
    return data?._embedded?.users || [];
  }

  async findUserByPhone(phone: string): Promise<any | null> {
    const users = await this.getUsers();
    const cleanPhone = phone.replace(/\D/g, '');
    return users.find((u: any) => {
      const userPhone = String(u.phone || '').replace(/\D/g, '');
      return userPhone && userPhone.endsWith(cleanPhone.slice(-10));
    }) || null;
  }

  // === Fixation request (create lead with broker info) ===
  async createFixationRequest(data: {
    clientPhone: string;
    clientEmail?: string;        // правка 2026-05-15: записывается на контакт
    clientName: string;
    clientRegion?: string;       // правка 2026-05-22: регион клиента (REGION=589265)
    presentationSent?: boolean;  // правка 2026-05-22: «Отправлена презентация» на контакт клиента
    brokerPhone: string;
    brokerAmoContactId?: number; // правка 2026-05-22: привязка брокера-агента как 2-го контакта лида
    agencyName: string;
    agencyInn: string;
    comment: string;
    project: Project;
    // Новые поля 2026-05-14 — мапятся в amoCRM custom_fields_values.
    propertyType?: string;
    roomsCount?: string;
    amount?: number;
    sqm?: number;
    // Новые поля 2026-05-22 — заполняются опционально из формы фиксации.
    purchaseTiming?: string;     // «Планирует покупку»: от 1 до 3 месяцев, 3-6, и т.д.
    readinessLevel?: string;     // «Готовность к сделке»: Холодный/Тёплый/Горячий
    fromBroker?: boolean;        // «От брокера» radio (по умолчанию true для fixation request)
  }): Promise<AmoLead> {
    // Контакт КЛИЕНТА — формируем custom_fields_values, отдельно от создания
    const clientCustomFields: any[] = [
      { field_code: 'PHONE', values: [{ value: data.clientPhone, enum_code: 'WORK' }] },
    ];
    if (data.clientEmail) {
      clientCustomFields.push({ field_code: 'EMAIL', values: [{ value: data.clientEmail, enum_code: 'WORK' }] });
    }
    if (data.clientRegion) {
      clientCustomFields.push({ field_id: 589265, values: [{ value: data.clientRegion }] });
    }
    if (data.presentationSent) {
      clientCustomFields.push({ field_id: 835955, values: [{ value: true }] });
    }

    let contact = await this.findContactByPhone(data.clientPhone);
    if (!contact) {
      contact = await this.createContact({
        name: data.clientName,
        custom_fields_values: clientCustomFields,
      });
    } else {
      // Контакт существует — обновим переданные поля (email/region/presentation).
      // Без try/catch: если amo вернёт ошибку, мы не валим всю операцию.
      try {
        await this.updateContact(contact.id, { custom_fields_values: clientCustomFields } as any);
      } catch {}
    }

    // Заполняем custom_fields на лиде (правка 2026-05-14):
    //   587387 — "Тип объекта"
    //   583447 — "Сколько комнат рассматривает"
    //   833045 — "Стоимость без скидок, руб" (= бюджет покупки)
    //   604555 — "Метраж, м2"
    const customFields: any[] = [];
    if (data.propertyType) customFields.push({ field_id: 587387, values: [{ value: data.propertyType }] });
    if (data.roomsCount) customFields.push({ field_id: 583447, values: [{ value: data.roomsCount }] });
    if (data.amount && data.amount > 0) customFields.push({ field_id: 833045, values: [{ value: String(data.amount) }] });
    if (data.sqm && data.sqm > 0) customFields.push({ field_id: 604555, values: [{ value: String(data.sqm) }] });
    // Правка 2026-05-15: добавляем поля левого сайдбара лида автоматом.
    // 583155 «Цель покупки» — по умолчанию «Себе» (большинство случаев).
    // 839179 «Объект интереса» — из выбранного проекта.
    customFields.push({ field_id: 583155, values: [{ value: 'Себе' }] });
    const objectByProject: Record<string, string> = {
      ZORGE9: 'Зорге 9',
      SILVER_BOR: 'Берзарина 37',
    };
    const projectObj = objectByProject[String(data.project)] || 'Зорге 9';
    customFields.push({ field_id: 839179, values: [{ value: projectObj }] });

    // Поля воронки КЦ (2026-05-22, ID получены через debug-endpoint):
    // — От брокера (radio): для fixation request ВСЕГДА Да
    if (data.fromBroker !== false) {
      customFields.push({
        field_id: AMO_LEAD_FIELDS.FROM_BROKER,
        values: [{ enum_id: AMO_LEAD_ENUMS.FROM_BROKER_YES }],
      });
    }
    // — Дата создания заявки от брокера (date, unix sec) — текущий момент
    customFields.push({
      field_id: AMO_LEAD_FIELDS.BROKER_REQUEST_DATE,
      values: [{ value: Math.floor(Date.now() / 1000) }],
    });
    // — Опросник заполнен (select) = Нет (по умолчанию для свежей фиксации)
    customFields.push({
      field_id: AMO_LEAD_FIELDS.QUESTIONNAIRE_FILLED,
      values: [{ enum_id: AMO_LEAD_ENUMS.QUESTIONNAIRE_NO }],
    });
    // — Готовность к сделке (select) — если оператор выбрал в форме
    if (data.readinessLevel) {
      const eid = readinessLevelToEnumId(data.readinessLevel);
      if (eid) customFields.push({ field_id: AMO_LEAD_FIELDS.READINESS_LEVEL, values: [{ enum_id: eid }] });
    }
    // — Планирует покупку в срок (select)
    if (data.purchaseTiming) {
      const eid = purchaseTimingToEnumId(data.purchaseTiming);
      if (eid) customFields.push({ field_id: AMO_LEAD_FIELDS.PURCHASE_TIMING, values: [{ enum_id: eid }] });
    }

    // Шаг 1: создаём лид с минимумом — name, contacts, pipeline, price.
    // Salesbot/Morekit отрабатывает и пишет свои поля (Этапы продаж, Ответственный КЦ).
    // Правка 2026-05-15: разделено на 2 шага потому что Salesbot затирал наши
    // custom_fields_values при создании в одном вызове.
    //
    // Правка 2026-05-22: к лиду привязываются ДВА контакта — клиент И брокер.
    // Без брокера в `contacts` непонятно «от кого пришла заявка» (на скриншоте
    // КБ3 в лиде виден второй контакт «Малыгина Елена Александровна» — агент).
    const leadContacts: Array<{ id: number }> = [];
    if (contact?.id) leadContacts.push({ id: contact.id });
    if (data.brokerAmoContactId) leadContacts.push({ id: data.brokerAmoContactId });

    const leadData: any = {
      name: `Фиксация: ${data.clientName} (${data.project})`,
      contacts: leadContacts.length > 0 ? leadContacts : undefined,
      pipeline_id: 7600542,
    };
    if (data.amount && data.amount > 0) leadData.price = data.amount; // встроенное поле «Бюджет» лида

    const created = await this.createLead(leadData);

    // Шаг 2: PATCH с custom_fields_values — после Salesbot, чтобы наши значения встали.
    if (created?.id && customFields.length > 0) {
      try {
        await this.updateLead(created.id, { custom_fields_values: customFields } as any);
      } catch (e) {
        // Не валим всю операцию если PATCH упал — лид создан, контакт связан.
      }
    }

    // 2026-05-26: добавляем читаемое примечание в чат лида —
    // вся ключевая информация в одном месте, видно в ленте amoCRM.
    if (created?.id) {
      const lines: string[] = [];
      lines.push(`📝 Фиксация клиента от брокера`);
      lines.push(`Клиент: ${data.clientName}`);
      lines.push(`Телефон: ${data.clientPhone}`);
      if (data.clientEmail) lines.push(`Email: ${data.clientEmail}`);
      if (data.clientRegion) lines.push(`Регион: ${data.clientRegion}`);
      lines.push(``);
      lines.push(`Проект: ${data.project}`);
      if (data.propertyType) lines.push(`Тип: ${data.propertyType}`);
      if (data.roomsCount) lines.push(`Комнат: ${data.roomsCount}`);
      if (data.sqm) lines.push(`Метраж: ${data.sqm} м²`);
      if (data.amount) lines.push(`Бюджет: ${data.amount.toLocaleString('ru-RU')} ₽`);
      if (data.purchaseTiming) lines.push(`Планирует покупку: ${data.purchaseTiming}`);
      if (data.readinessLevel) lines.push(`Готовность к сделке: ${data.readinessLevel}`);
      lines.push(``);
      lines.push(`Брокер-агент: ${data.brokerPhone}`);
      lines.push(`Агентство: ${data.agencyName} (ИНН ${data.agencyInn})`);
      if (data.comment) {
        lines.push(``);
        lines.push(`Комментарий брокера: ${data.comment}`);
      }
      try {
        await this.addNoteToLead(created.id, lines.join('\n'));
      } catch (e) {
        // Не валим — note вторичен, главное лид с полями.
      }
      // 2026-05-26: задача КЦ — связаться с клиентом, провести фиксацию.
      // С дедлайном через сутки. Появится в задачах сотрудников amoCRM.
      try {
        await this.createTask({
          text: `Связаться с клиентом ${data.clientName} (${data.clientPhone}) — фиксация от брокера ${data.brokerPhone}. Проект: ${data.project}.`,
          entityType: 'leads',
          entityId: created.id,
          taskTypeId: 1, // звонок
        });
      } catch (e) {
        // не валим
      }
    }

    return created;
  }

  // 2026-05-26: создаёт лид нового брокера в pipeline 10787390 (БРОКЕРЫ).
  // Используется когда брокер оставил заявку на брокер-тур / форму с лендинга.
  // Создаёт контакт с IS_BROKER=true и лид с задачей КЦ.
  async createBrokerLeadFromLanding(data: {
    brokerName: string;
    brokerPhone: string;
    brokerEmail?: string | null;
    source: string; // 'LANDING_BROKER_TOUR' | 'LANDING_FORM'
    note?: string | null;
  }): Promise<{ contactId?: number; leadId?: number } | null> {
    try {
      // 1) Контакт с IS_BROKER=true
      const contact = await this.createContact({
        name: data.brokerName,
        custom_fields_values: [
          { field_code: 'PHONE', values: [{ value: data.brokerPhone, enum_code: 'WORK' }] },
          ...(data.brokerEmail
            ? [{ field_code: 'EMAIL' as const, values: [{ value: data.brokerEmail, enum_code: 'WORK' }] }]
            : []),
          { field_id: 835415, values: [{ value: true }] }, // IS_BROKER
        ],
      });

      // 2) Лид в пайплайне брокеров
      const lead = await this.createLead({
        name: `Заявка с лендинга — ${data.brokerName}`,
        pipeline_id: 10787390, // BROKERS
        contacts: contact?.id ? [{ id: contact.id }] : undefined,
      } as any);

      // 3) Примечание и задача
      if (lead?.id) {
        const noteText = [
          `📥 Заявка с лендинга`,
          `Источник: ${data.source === 'LANDING_BROKER_TOUR' ? 'Запись на брокер-тур' : 'Форма «Связаться с нами»'}`,
          `Имя: ${data.brokerName}`,
          `Телефон: ${data.brokerPhone}`,
          ...(data.brokerEmail ? [`Email: ${data.brokerEmail}`] : []),
          ...(data.note ? [``, `Сообщение: ${data.note}`] : []),
        ].join('\n');
        try { await this.addNoteToLead(lead.id, noteText); } catch {}
        try {
          await this.createTask({
            text: `Связаться с новым брокером ${data.brokerName} (${data.brokerPhone}) — заявка с лендинга`,
            entityType: 'leads',
            entityId: lead.id,
            taskTypeId: 1, // звонок
            completeTillSec: Math.floor(Date.now() / 1000) + 4 * 60 * 60, // 4 часа — новый лид срочно
          });
        } catch {}
      }

      return { contactId: contact?.id, leadId: lead?.id };
    } catch (e: any) {
      console.error('[createBrokerLeadFromLanding] failed:', e?.message || e);
      return null;
    }
  }

  // 2026-05-26: добавляет примечание о попытке повторной фиксации в
  // существующий amoCRM-лид. Используется когда другой брокер пробует
  // зафиксировать клиента который уже на уникальности.
  async addRefixationAttemptNote(leadId: number, data: {
    requestingBrokerName: string;
    requestingBrokerPhone: string;
    clientPhone: string;
  }): Promise<void> {
    const text = [
      `⚠ Попытка повторной фиксации`,
      ``,
      `Клиент ${data.clientPhone} уже на уникальности.`,
      `Брокер ${data.requestingBrokerName} (${data.requestingBrokerPhone}) пытался зафиксировать этого клиента сейчас.`,
      ``,
      `Менеджер уведомлён, заявка переведена в статус UNDER_REVIEW в нашей системе.`,
    ].join('\n');
    // Note для истории + задача чтобы сотрудник КЦ её разобрал
    await this.addNoteToLead(leadId, text);
    try {
      await this.createTask({
        text: `⚠ Разрешить конфликт: ${data.requestingBrokerName} (${data.requestingBrokerPhone}) пытался повторно зафиксировать клиента ${data.clientPhone}. Уточнить кому отдать.`,
        entityType: 'leads',
        entityId: leadId,
        taskTypeId: 1,
        completeTillSec: Math.floor(Date.now() / 1000) + 4 * 60 * 60, // 4 часа — конфликты разруливаем быстро
      });
    } catch (e) {
      // note уже создан — главное чтобы менеджер увидел
    }
  }
}
