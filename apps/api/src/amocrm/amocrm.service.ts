import { Injectable, Inject, BadRequestException } from '@nestjs/common';
import { PrismaClient } from '@st-michael/database';
import { AmoCrmAdapter } from '@st-michael/integrations';

@Injectable()
export class AmocrmService {
  private amo: AmoCrmAdapter;

  constructor(@Inject('PrismaClient') private prisma: PrismaClient) {
    this.amo = new AmoCrmAdapter();
  }

  async getAccount() {
    return this.amo.getAccount();
  }

  async getPipelines() {
    const pipelines = await this.amo.getPipelines();
    return pipelines.map((p: any) => ({
      id: p.id,
      name: p.name,
      is_main: p.is_main,
      statuses: (p._embedded?.statuses || []).map((s: any) => ({
        id: s.id,
        name: s.name,
        sort: s.sort,
        is_editable: s.is_editable,
      })),
    }));
  }

  async getContactFields() {
    return this.amo.getContactCustomFields();
  }

  async getCompanyFields() {
    return this.amo.getCompanyCustomFields();
  }

  async getUsers() {
    const users = await this.amo.getUsers();
    return users.map((u: any) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      phone: u.phone,
      role_id: u.role_id,
    }));
  }

  /**
   * Find broker contact in amoCRM by phone and sync linked leads/clients to local DB
   */
  async syncBrokerByPhone(phone: string, brokerId?: string, inn?: string) {
    if (!phone) throw new BadRequestException('phone required');

    const contact = await this.amo.findContactByPhone(phone);
    if (!contact) {
      return { found: false, message: 'Contact not found in amoCRM' };
    }

    // Get full contact with leads
    const fullContact = await this.amo.getContact(contact.id);
    const leads = fullContact?._embedded?.leads || [];

    // If INN provided, attach company with INN
    if (inn && brokerId) {
      let company = await this.amo.findCompanyByInn(inn);
      if (!company) {
        company = await this.amo.createCompany({
          name: `Агентство ${inn}`,
          custom_fields_values: [
            { field_code: 'INN' as any, values: [{ value: inn }] },
          ],
        });
      }
      try {
        await this.amo.linkContactToCompany(contact.id, company.id);
      } catch {}

      // Save agency in DB
      let agency = await this.prisma.agency.findUnique({ where: { inn } });
      if (!agency) {
        agency = await this.prisma.agency.create({
          data: { name: company.name, inn },
        });
      }

      // Link broker to agency
      const existingLink = await this.prisma.brokerAgency.findFirst({
        where: { brokerId, agencyId: agency.id },
      });
      if (!existingLink) {
        await this.prisma.brokerAgency.create({
          data: { brokerId, agencyId: agency.id, isPrimary: true },
        });
      }

      // Save amo_contact_id to broker
      await this.prisma.broker.update({
        where: { id: brokerId },
        data: { amoContactId: BigInt(contact.id) },
      });
    }

    return {
      found: true,
      contact: { id: contact.id, name: contact.name },
      leadsCount: leads.length,
      leads: leads.map((l: any) => ({ id: l.id })),
    };
  }
}
