import { Project } from '@st-michael/shared';

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

  private async request<T = any>(path: string, init: RequestInit = {}): Promise<T> {
    if (!this.token) throw new Error('AMO_ACCESS_TOKEN not configured');

    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
    });

    if (res.status === 204) return null as T;
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

    return created;
  }
}
