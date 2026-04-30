import { Injectable, Inject, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaClient } from '@st-michael/database';
import { AmocrmService } from '../amocrm/amocrm.service';
import { AmoCrmAdapter, AMO_CONTACT_FIELDS, BROKER_PIPELINE_ID } from '@st-michael/integrations';

@Injectable()
export class AdminService {
  private amo = new AmoCrmAdapter();

  constructor(
    @Inject('PrismaClient') private prisma: PrismaClient,
    private amocrmService: AmocrmService,
  ) {}

  async listBrokers(query: { page?: number; limit?: number; search?: string; role?: string; status?: string }) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (query.search) {
      where.OR = [
        { fullName: { contains: query.search, mode: 'insensitive' } },
        { phone: { contains: query.search } },
        { email: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    if (query.role) where.role = query.role;
    if (query.status) where.status = query.status;

    const [brokers, total] = await Promise.all([
      this.prisma.broker.findMany({
        where,
        select: {
          id: true,
          fullName: true,
          phone: true,
          email: true,
          role: true,
          status: true,
          funnelStage: true,
          source: true,
          amoContactId: true,
          createdAt: true,
          _count: { select: { clients: true, deals: true, meetings: true } },
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.broker.count({ where }),
    ]);

    return { brokers, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async getBroker(id: string) {
    const broker = await this.prisma.broker.findUnique({
      where: { id },
      include: {
        brokerAgencies: { include: { agency: true } },
        _count: { select: { clients: true, deals: true, meetings: true } },
      },
    });
    if (!broker) throw new NotFoundException('Broker not found');
    return broker;
  }

  async updateBroker(id: string, data: any) {
    const allowed: any = {};
    if (data.fullName !== undefined) allowed.fullName = data.fullName;
    if (data.email !== undefined) allowed.email = data.email || null;
    if (data.phone !== undefined) allowed.phone = data.phone;
    if (data.brokerTourVisited !== undefined) allowed.brokerTourVisited = data.brokerTourVisited;
    if (data.doNotCall !== undefined) allowed.doNotCall = data.doNotCall;
    if (data.bestCallTime !== undefined) allowed.bestCallTime = data.bestCallTime;

    const updated = await this.prisma.broker.update({ where: { id }, data: allowed });
    return updated;
  }

  async changeRole(id: string, role: 'BROKER' | 'MANAGER' | 'ADMIN') {
    return this.prisma.broker.update({ where: { id }, data: { role: role as any } });
  }

  async changeStatus(id: string, status: 'ACTIVE' | 'BLOCKED' | 'PENDING') {
    return this.prisma.broker.update({ where: { id }, data: { status: status as any } });
  }

  async brokerDeals(brokerId: string, query: any) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;
    const skip = (page - 1) * limit;

    const [deals, total] = await Promise.all([
      this.prisma.deal.findMany({
        where: { brokerId },
        include: {
          client: { select: { fullName: true, phone: true } },
          lot: { select: { number: true, building: true } },
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.deal.count({ where: { brokerId } }),
    ]);

    return { deals, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async brokerClients(brokerId: string, query: any) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;
    const skip = (page - 1) * limit;

    const [clients, total] = await Promise.all([
      this.prisma.client.findMany({
        where: { brokerId },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.client.count({ where: { brokerId } }),
    ]);

    return { clients, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async brokerMeetings(brokerId: string, query: any) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;
    const skip = (page - 1) * limit;

    const [meetings, total] = await Promise.all([
      this.prisma.meeting.findMany({
        where: { brokerId },
        include: { client: { select: { fullName: true, phone: true } } },
        skip,
        take: limit,
        orderBy: { date: 'desc' },
      }),
      this.prisma.meeting.count({ where: { brokerId } }),
    ]);

    return { meetings, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async syncBrokerAmo(brokerId: string) {
    return this.amocrmService.syncMyDealsAndClients(brokerId);
  }

  async deleteBroker(id: string) {
    const broker = await this.prisma.broker.findUnique({ where: { id } });
    if (!broker) throw new NotFoundException('Broker not found');

    // Cascade delete related data manually (Prisma does not cascade by default)
    await this.prisma.meeting.deleteMany({ where: { brokerId: id } });
    await this.prisma.deal.deleteMany({ where: { brokerId: id } });
    await this.prisma.client.deleteMany({ where: { brokerId: id } });
    await this.prisma.brokerAgency.deleteMany({ where: { brokerId: id } });
    await this.prisma.notification.deleteMany({ where: { brokerId: id } }).catch(() => {});
    await this.prisma.broker.delete({ where: { id } });

    return { deleted: true, broker: broker.fullName };
  }

  /**
   * Bulk import brokers from amoCRM "Воронка брокеров" (pipeline 10787390).
   * Each lead in this pipeline represents a broker. Their main contact = broker contact.
   */
  async importBrokersFromAmo() {
    if (!process.env.AMO_ACCESS_TOKEN) {
      throw new BadRequestException('AMO_ACCESS_TOKEN не настроен');
    }

    const leads = await this.amo.getLeadsByPipeline(BROKER_PIPELINE_ID, 250);
    if (leads.length === 0) {
      return { found: 0, created: 0, updated: 0, skipped: 0, message: 'Нет лидов в воронке брокеров' };
    }

    let created = 0;
    let updated = 0;
    let skipped = 0;
    const errors: string[] = [];

    // Collect unique broker contact IDs from leads
    const brokerContactIds = new Set<number>();
    for (const lead of leads) {
      const contacts = (lead as any)?._embedded?.contacts || [];
      // Skip closed-not-realized leads
      if (lead.status_id === 143) continue;
      // Take main contact (or first if no main)
      const mainContact = contacts.find((c: any) => c.is_main) || contacts[0];
      if (mainContact?.id) brokerContactIds.add(Number(mainContact.id));
    }

    for (const contactId of brokerContactIds) {
      try {
        const contact: any = await this.amo.getContact(contactId);
        if (!contact) { skipped++; continue; }

        // Check if contact has Брокер flag = true
        const fields = contact.custom_fields_values || [];
        const brokerField = fields.find((f: any) => f.field_id === AMO_CONTACT_FIELDS.IS_BROKER);
        if (brokerField?.values?.[0]?.value !== true) { skipped++; continue; }

        // Extract phone
        const phoneField = fields.find((f: any) => f.field_id === AMO_CONTACT_FIELDS.PHONE);
        let phone = phoneField?.values?.[0]?.value || '';
        phone = String(phone).replace(/[\s\-()'"]/g, '');
        if (phone.startsWith('8') && phone.length === 11) phone = '+7' + phone.slice(1);
        if (phone && !phone.startsWith('+')) phone = '+' + phone;
        if (!phone) {
          errors.push(`Contact ${contactId} (${contact.name}) — нет телефона`);
          skipped++;
          continue;
        }

        // Extract email
        const emailField = fields.find((f: any) => f.field_id === AMO_CONTACT_FIELDS.EMAIL);
        const email = emailField?.values?.[0]?.value || null;

        // Extract INN and agency name
        const innField = fields.find((f: any) => f.field_id === AMO_CONTACT_FIELDS.INN);
        const inn = innField?.values?.[0]?.value || null;
        const agencyField = fields.find((f: any) => f.field_id === AMO_CONTACT_FIELDS.AGENCY_NAME);
        const agencyName = agencyField?.values?.[0]?.value || null;

        // Upsert broker by phone
        const existing = await this.prisma.broker.findUnique({ where: { phone } });
        if (existing) {
          await this.prisma.broker.update({
            where: { id: existing.id },
            data: {
              fullName: contact.name || existing.fullName,
              email: email || existing.email,
              amoContactId: BigInt(contactId),
            },
          });
          updated++;
        } else {
          const newBroker = await this.prisma.broker.create({
            data: {
              phone,
              fullName: contact.name || 'Без имени',
              email,
              amoContactId: BigInt(contactId),
              role: 'BROKER',
              status: 'PENDING', // нет пароля — пусть установит через "Забыли пароль?"
              source: 'CRM_MANUAL' as any,
            },
          });
          created++;

          // Link to agency if INN present
          if (inn) {
            let agency = await this.prisma.agency.findUnique({ where: { inn } });
            if (!agency) {
              agency = await this.prisma.agency.create({
                data: { name: agencyName || `Агентство ${inn}`, inn },
              });
            }
            await this.prisma.brokerAgency.create({
              data: { brokerId: newBroker.id, agencyId: agency.id, isPrimary: true },
            });
          }
        }
      } catch (e: any) {
        errors.push(`Contact ${contactId}: ${e.message || e}`);
        skipped++;
      }
    }

    return {
      foundLeads: leads.length,
      uniqueContacts: brokerContactIds.size,
      created,
      updated,
      skipped,
      errors: errors.slice(0, 10),
    };
  }
}
