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
    const result = await this.request<any>('/leads', {
      method: 'POST',
      body: JSON.stringify([data]),
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
    clientName: string;
    brokerPhone: string;
    agencyName: string;
    agencyInn: string;
    comment: string;
    project: Project;
  }): Promise<AmoLead> {
    let contact = await this.findContactByPhone(data.clientPhone);
    if (!contact) {
      contact = await this.createContact({
        name: data.clientName,
        custom_fields_values: [
          { field_code: 'PHONE', values: [{ value: data.clientPhone, enum_code: 'WORK' }] },
        ],
      });
    }

    return this.createLead({
      name: `Фиксация: ${data.clientName} (${data.project})`,
      contacts: contact ? [{ id: contact.id }] : undefined,
    });
  }
}
