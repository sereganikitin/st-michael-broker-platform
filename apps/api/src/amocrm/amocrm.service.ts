import { Injectable, Inject, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaClient, UniquenessStatus } from '@st-michael/database';
import { AmoCrmAdapter, AMO_CONTACT_FIELDS, pipelineToProject, statusToDealStatus, isDealStage } from '@st-michael/integrations';

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

    const amoContactId = broker.amoContactId ? Number(broker.amoContactId) : null;

    // Strategy 1: Get leads linked to broker's contact
    let allLeadIds: number[] = [];
    if (amoContactId) {
      const fullContact = await this.amo.getContact(amoContactId);
      const contactLeads = fullContact?._embedded?.leads || [];
      allLeadIds.push(...contactLeads.map((l: any) => l.id));
    }

    // Strategy 2: Find broker as amoCRM user (employee) and get leads by responsible_user_id
    let amoUserId: number | null = null;
    try {
      const users = await this.amo.getUsers();
      const cleanPhone = broker.phone.replace(/\D/g, '').slice(-10);
      const userByPhone = users.find((u: any) => {
        const uPhone = String(u.phone || '').replace(/\D/g, '');
        return uPhone && uPhone.endsWith(cleanPhone);
      });
      // Also try matching by name
      const userByName = !userByPhone ? users.find((u: any) =>
        u.name && broker.fullName && u.name.toLowerCase().includes(broker.fullName.split(' ')[0]?.toLowerCase()),
      ) : null;
      const matchedUser = userByPhone || userByName;
      if (matchedUser) {
        amoUserId = matchedUser.id;
        const userLeads = await this.amo.getLeadsByResponsibleUser(matchedUser.id, 500);
        for (const lead of userLeads) {
          if (!allLeadIds.includes(lead.id)) allLeadIds.push(lead.id);
        }
      }
    } catch (e) {
      console.error('User lookup failed:', e);
    }

    if (allLeadIds.length === 0) {
      return {
        dealsCreated: 0, dealsUpdated: 0, clientsCreated: 0,
        message: 'No leads found. Broker not linked to deals in amoCRM.',
        amoContactId, amoUserId,
      };
    }

    let dealsCreated = 0;
    let dealsUpdated = 0;
    let clientsCreated = 0;
    let skipped = 0;

    for (const leadId of allLeadIds) {
      try {
        const lead: any = await this.amo.getLead(leadId);
        if (!lead) continue;

        // Skip closed-not-realized and non-deal stages
        if (lead.status_id === 143) { skipped++; continue; }
        if (!isDealStage(lead.status_id)) { skipped++; continue; }

        const project = pipelineToProject(lead.pipeline_id);
        const status = statusToDealStatus(lead.status_id);

        // Find client contact in lead (any contact that is NOT the broker)
        const leadContacts = lead?._embedded?.contacts || [];
        const clientContactRef = leadContacts.find(
          (c: any) => !amoContactId || Number(c.id) !== amoContactId,
        ) || leadContacts[0];

        let fullName = lead.name || 'Без имени';
        let phone = `+70000${leadId}`;
        let email: string | null = null;

        if (clientContactRef) {
          const clientContact: any = await this.amo.getContact(clientContactRef.id);
          if (clientContact) {
            fullName = clientContact.name || fullName;
            const phoneField = (clientContact.custom_fields_values || []).find(
              (f: any) => f.field_id === AMO_CONTACT_FIELDS.PHONE || f.field_code === 'PHONE',
            );
            const rawPhone = phoneField?.values?.[0]?.value || '';
            let p = String(rawPhone).replace(/[\s\-()'"]/g, '');
            if (p.startsWith('8') && p.length === 11) p = '+7' + p.slice(1);
            if (p && !p.startsWith('+')) p = '+' + p;
            if (p) phone = p;

            const emailField = (clientContact.custom_fields_values || []).find(
              (f: any) => f.field_id === AMO_CONTACT_FIELDS.EMAIL || f.field_code === 'EMAIL',
            );
            email = emailField?.values?.[0]?.value || null;
          }
        }

        // Upsert client
        let client = await this.prisma.client.findFirst({ where: { phone, brokerId } });
        if (!client) {
          client = await this.prisma.client.create({
            data: {
              brokerId, fullName, phone, email,
              project: project as any,
              amoLeadId: BigInt(lead.id),
              uniquenessStatus: UniquenessStatus.CONDITIONALLY_UNIQUE,
              uniquenessExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
            },
          });
          clientsCreated++;
        }

        // Upsert deal
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
      } catch (e) {
        skipped++;
      }
    }

    return { dealsCreated, dealsUpdated, clientsCreated, skipped, totalLeads: allLeadIds.length, amoContactId, amoUserId };
  }
}
