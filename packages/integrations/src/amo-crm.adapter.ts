import { Project } from '@st-michael/shared';

// Types for amoCRM
export interface AmoContact {
  id: number;
  name: string;
  first_name?: string;
  last_name?: string;
  custom_fields_values?: any[];
  created_at?: number;
  updated_at?: number;
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
  custom_fields_values?: any[];
  contacts?: { id: number }[];
  companies?: { id: number }[];
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

export interface IAmoCrmAdapter {
  // Контакты
  findContactByPhone(phone: string): Promise<AmoContact | null>;
  createContact(data: CreateContactDto): Promise<AmoContact>;

  // Компании
  findCompanyByInn(inn: string): Promise<AmoCompany | null>;
  createCompany(data: CreateCompanyDto): Promise<AmoCompany>;
  linkContactToCompany(contactId: number, companyId: number): Promise<void>;

  // Сделки (лиды)
  createLead(data: CreateLeadDto): Promise<AmoLead>;
  updateLead(id: number, data: UpdateLeadDto): Promise<void>;
  reopenLead(id: number, newBrokerAmoId: number): Promise<AmoLead>;
  getLeadsByBroker(brokerAmoId: number): Promise<AmoLead[]>;
  getLeadStage(leadId: number): Promise<string>;

  // Создание заявки на фиксацию
  createFixationRequest(data: {
    clientPhone: string;
    clientName: string;
    brokerPhone: string;
    agencyName: string;
    agencyInn: string;
    comment: string;
    project: Project;
  }): Promise<AmoLead>;
}

export class AmoCrmAdapter implements IAmoCrmAdapter {
  // TODO: Implement actual amoCRM API integration
  async findContactByPhone(phone: string): Promise<AmoContact | null> {
    console.log('AmoCrmAdapter: findContactByPhone', phone);
    // Stub implementation
    return null;
  }

  async createContact(data: CreateContactDto): Promise<AmoContact> {
    console.log('AmoCrmAdapter: createContact', data);
    // Stub implementation
    return {
      id: Math.floor(Math.random() * 1000000),
      name: data.name,
      created_at: Date.now(),
      updated_at: Date.now(),
    };
  }

  async findCompanyByInn(inn: string): Promise<AmoCompany | null> {
    console.log('AmoCrmAdapter: findCompanyByInn', inn);
    // Stub implementation
    return null;
  }

  async createCompany(data: CreateCompanyDto): Promise<AmoCompany> {
    console.log('AmoCrmAdapter: createCompany', data);
    // Stub implementation
    return {
      id: Math.floor(Math.random() * 1000000),
      name: data.name,
      created_at: Date.now(),
      updated_at: Date.now(),
    };
  }

  async linkContactToCompany(contactId: number, companyId: number): Promise<void> {
    console.log('AmoCrmAdapter: linkContactToCompany', { contactId, companyId });
    // Stub implementation
  }

  async createLead(data: CreateLeadDto): Promise<AmoLead> {
    console.log('AmoCrmAdapter: createLead', data);
    // Stub implementation
    return {
      id: Math.floor(Math.random() * 1000000),
      name: data.name,
      price: data.price,
      status_id: data.status_id,
      created_at: Date.now(),
      updated_at: Date.now(),
    };
  }

  async updateLead(id: number, data: UpdateLeadDto): Promise<void> {
    console.log('AmoCrmAdapter: updateLead', id, data);
    // Stub implementation
  }

  async reopenLead(id: number, newBrokerAmoId: number): Promise<AmoLead> {
    console.log('AmoCrmAdapter: reopenLead', { id, newBrokerAmoId });
    // Stub implementation
    return {
      id,
      name: 'Reopened Lead',
      updated_at: Date.now(),
    };
  }

  async getLeadsByBroker(brokerAmoId: number): Promise<AmoLead[]> {
    console.log('AmoCrmAdapter: getLeadsByBroker', brokerAmoId);
    // Stub implementation
    return [];
  }

  async getLeadStage(leadId: number): Promise<string> {
    console.log('AmoCrmAdapter: getLeadStage', leadId);
    // Stub implementation
    return 'New Lead';
  }

  async createFixationRequest(data: {
    clientPhone: string;
    clientName: string;
    brokerPhone: string;
    agencyName: string;
    agencyInn: string;
    comment: string;
    project: Project;
  }): Promise<AmoLead> {
    console.log('AmoCrmAdapter: createFixationRequest', data);
    // Stub implementation
    return {
      id: Math.floor(Math.random() * 1000000),
      name: `Fixation: ${data.clientName}`,
      created_at: Date.now(),
      updated_at: Date.now(),
    };
  }
}