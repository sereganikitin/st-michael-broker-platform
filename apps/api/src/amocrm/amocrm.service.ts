import { Injectable, Inject, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaClient, UniquenessStatus } from '@st-michael/database';
import { AmoCrmAdapter, AMO_CONTACT_FIELDS, pipelineToProject, statusToDealStatus } from '@st-michael/integrations';

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

  /**
   * Pull all leads (deals) linked to broker's amoCRM contact and create local Client + Deal records
   */
  async syncMyDealsAndClients(brokerId: string) {
    const broker = await this.prisma.broker.findUnique({ where: { id: brokerId } });
    if (!broker) throw new NotFoundException('Broker not found');
    if (!broker.amoContactId) {
      throw new BadRequestException('Broker not linked to amoCRM contact. Re-register or call /amocrm/sync-broker-by-phone first.');
    }

    const amoContactId = Number(broker.amoContactId);

    // Get full contact with linked leads
    const fullContact = await this.amo.getContact(amoContactId);
    const linkedLeads = fullContact?._embedded?.leads || [];
    if (linkedLeads.length === 0) {
      return { dealsCreated: 0, dealsUpdated: 0, clientsCreated: 0, message: 'No leads linked to this contact in amoCRM' };
    }

    let dealsCreated = 0;
    let dealsUpdated = 0;
    let clientsCreated = 0;

    for (const leadRef of linkedLeads) {
      const lead: any = await this.amo.getLead(leadRef.id);
      if (!lead) continue;

      // Skip closed-not-realized
      if (lead.status_id === 143) continue;

      const project = pipelineToProject(lead.pipeline_id);
      const status = statusToDealStatus(lead.status_id);

      // Find client contact (any contact in lead that is NOT the broker)
      const leadContacts = lead?._embedded?.contacts || [];
      const clientContactRef = leadContacts.find((c: any) => Number(c.id) !== amoContactId) || leadContacts[0];
      if (!clientContactRef) continue;

      // Fetch client contact details
      const clientContact: any = await this.amo.getContact(clientContactRef.id);
      if (!clientContact) continue;

      // Extract phone from client custom fields
      const phoneField = (clientContact.custom_fields_values || []).find(
        (f: any) => f.field_id === AMO_CONTACT_FIELDS.PHONE || f.field_code === 'PHONE',
      );
      const rawPhone = phoneField?.values?.[0]?.value || '';
      let phone = String(rawPhone).replace(/[\s\-()'"]/g, '');
      if (phone.startsWith('8') && phone.length === 11) phone = '+7' + phone.slice(1);
      if (phone && !phone.startsWith('+')) phone = '+' + phone;
      if (!phone) phone = `+70000${clientContact.id}`;

      const fullName = clientContact.name || 'Без имени';

      const emailField = (clientContact.custom_fields_values || []).find(
        (f: any) => f.field_id === AMO_CONTACT_FIELDS.EMAIL || f.field_code === 'EMAIL',
      );
      const email = emailField?.values?.[0]?.value || null;

      // Upsert client by phone+brokerId
      let client = await this.prisma.client.findFirst({ where: { phone, brokerId } });
      if (!client) {
        client = await this.prisma.client.create({
          data: {
            brokerId,
            fullName,
            phone,
            email,
            project: project as any,
            amoLeadId: BigInt(lead.id),
            uniquenessStatus: UniquenessStatus.CONDITIONALLY_UNIQUE,
            uniquenessExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          },
        });
        clientsCreated++;
      }

      // Upsert deal by amoDealId
      const existingDeal = await this.prisma.deal.findFirst({
        where: { amoDealId: BigInt(lead.id) },
      });

      const dealData = {
        clientId: client.id,
        brokerId,
        project: project as any,
        amount: Number(lead.price || 0),
        sqm: 0,
        commissionRate: 0,
        commissionAmount: 0,
        status: status as any,
        amoDealId: BigInt(lead.id),
      };

      if (existingDeal) {
        await this.prisma.deal.update({ where: { id: existingDeal.id }, data: dealData });
        dealsUpdated++;
      } else {
        await this.prisma.deal.create({ data: dealData });
        dealsCreated++;
      }
    }

    return { dealsCreated, dealsUpdated, clientsCreated, totalLeads: linkedLeads.length };
  }
}
