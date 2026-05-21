import { Injectable, Inject, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaClient } from '@st-michael/database';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import * as XLSX from 'xlsx';
import { AmocrmService } from '../amocrm/amocrm.service';
import { AmoCrmAdapter, AMO_CONTACT_FIELDS, BROKER_PIPELINE_ID } from '@st-michael/integrations';
import {
  VALID_CATEGORIES,
  VALID_CALL_FLAGS,
  parseAndFilter,
  mapCoordRow,
  normalizePhone,
  type BrokerCategoryCode,
  type Candidate,
} from './brokers-import.helper';
import { BrokerImportJobsService } from './broker-import-jobs.service';

interface MailingFilters {
  project?: string;        // ZORGE9 / SILVER_BOR
  agencyId?: string;
  commissionLevel?: string;
  funnelStage?: string;
  status?: string;
  role?: string;
}

@Injectable()
export class AdminService {
  private amo = new AmoCrmAdapter();

  constructor(
    @Inject('PrismaClient') private prisma: PrismaClient,
    private amocrmService: AmocrmService,
    @InjectQueue('notifications') private notificationQueue: Queue,
    private importJobs: BrokerImportJobsService,
  ) {}

  // ─── Mailings (broadcasts) ─────────────────────────────────

  private async resolveRecipients(filters: MailingFilters) {
    const where: any = {};

    if (filters.status) where.status = filters.status;
    else where.status = { not: 'BLOCKED' };

    if (filters.role) where.role = filters.role;
    if (filters.funnelStage) where.funnelStage = filters.funnelStage;

    // Agency / commissionLevel filters apply via brokerAgencies join
    if (filters.agencyId || filters.commissionLevel) {
      where.brokerAgencies = {
        some: {
          ...(filters.agencyId ? { agencyId: filters.agencyId } : {}),
          ...(filters.commissionLevel
            ? { agency: { commissionLevel: filters.commissionLevel as any } }
            : {}),
        },
      };
    }

    // Project filter — broker has at least one client/deal in that project
    if (filters.project) {
      where.OR = [
        { clients: { some: { project: filters.project as any } } },
        { deals: { some: { project: filters.project as any } } },
      ];
    }

    return this.prisma.broker.findMany({
      where,
      select: { id: true, fullName: true, phone: true, email: true, telegramChatId: true },
    });
  }

  async previewMailing(filters: MailingFilters) {
    const recipients = await this.resolveRecipients(filters);
    return {
      count: recipients.length,
      sample: recipients.slice(0, 10).map((r) => ({ id: r.id, fullName: r.fullName, phone: r.phone })),
    };
  }

  async sendMailing(
    createdById: string,
    data: { subject?: string; body: string; channels: string[]; filters: MailingFilters },
  ) {
    if (!data.body || !data.body.trim()) throw new BadRequestException('body required');
    if (!Array.isArray(data.channels) || data.channels.length === 0) {
      throw new BadRequestException('channels required');
    }

    const validChannels = new Set(['EMAIL', 'PUSH', 'TELEGRAM', 'SMS']);
    const channels = data.channels.filter((c) => validChannels.has(c));
    if (channels.length === 0) throw new BadRequestException('No valid channels');

    const recipients = await this.resolveRecipients(data.filters || {});

    let queued = 0;
    for (const r of recipients) {
      for (const channel of channels) {
        await this.notificationQueue.add('send', {
          brokerId: r.id,
          channel,
          subject: data.subject,
          body: data.body,
          eventType: 'ANNOUNCEMENTS',
          data: channel === 'PUSH' ? { url: '/', tag: `mailing-${Date.now()}` } : undefined,
        });
        queued++;
      }
    }

    const mailing = await this.prisma.mailing.create({
      data: {
        createdById,
        subject: data.subject || null,
        body: data.body,
        channels: channels as any,
        filters: (data.filters || {}) as any,
        recipientsCount: recipients.length,
      },
    });

    return { mailing, queued, recipientsCount: recipients.length };
  }

  async listMailings(query: { page?: number; limit?: number }) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      this.prisma.mailing.findMany({
        orderBy: { sentAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.mailing.count(),
    ]);

    return { items, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  // ─── Meetings (admin-wide management) ───────────────────────

  async listAllMeetings(query: { page?: number; limit?: number; status?: string; from?: string; to?: string; brokerId?: string }) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (query.status) where.status = query.status;
    if (query.brokerId) where.brokerId = query.brokerId;
    if (query.from || query.to) {
      where.date = {};
      if (query.from) where.date.gte = new Date(query.from);
      if (query.to) where.date.lte = new Date(query.to);
    }

    const [meetings, total] = await Promise.all([
      this.prisma.meeting.findMany({
        where,
        include: {
          client: { select: { id: true, fullName: true, phone: true } },
          broker: { select: { id: true, fullName: true, phone: true } },
        },
        orderBy: { date: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.meeting.count({ where }),
    ]);

    return { meetings, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async updateMeetingStatus(id: string, status: 'PENDING' | 'CONFIRMED' | 'COMPLETED' | 'CANCELLED', managerId: string) {
    const meeting = await this.prisma.meeting.findUnique({ where: { id } });
    if (!meeting) throw new NotFoundException('Meeting not found');

    const updated = await this.prisma.meeting.update({
      where: { id },
      data: { status: status as any, managerId },
    });

    // Notify broker about status change
    const subject = status === 'CONFIRMED' ? 'Встреча подтверждена'
      : status === 'CANCELLED' ? 'Встреча отменена'
      : 'Статус встречи обновлён';
    const dateStr = new Date(meeting.date).toLocaleString('ru-RU', {
      day: '2-digit', month: 'long', hour: '2-digit', minute: '2-digit',
    });
    const body = `${subject}: ${dateStr}.`;

    await this.notificationQueue.add('send', {
      brokerId: meeting.brokerId,
      channel: 'PUSH',
      subject,
      body,
      eventType: 'BOOKING_CONFIRMED',
      data: { url: '/meetings', tag: `meeting-${meeting.id}` },
    });
    await this.notificationQueue.add('send', {
      brokerId: meeting.brokerId,
      channel: 'EMAIL',
      subject,
      body,
      eventType: 'BOOKING_CONFIRMED',
    });

    return updated;
  }

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
        _count: { select: { clients: true, deals: true, meetings: true, callLogs: true } },
        callLogs: {
          orderBy: { createdAt: 'desc' },
          take: 50,
          select: {
            id: true, result: true, comment: true, campaign: true,
            duration: true, createdAt: true, nextCallAt: true, operatorId: true,
          },
        },
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

  // ─── Commission Policies CRUD (правка 2026-05-13) ──────────────────

  async listCommissionPolicies(query: any) {
    const where: any = {};
    if (query.project) where.project = query.project;
    if (query.isActive !== undefined) where.isActive = query.isActive === 'true' || query.isActive === true;
    return this.prisma.commissionPolicy.findMany({
      where,
      orderBy: [{ project: 'asc' }, { startDate: 'desc' }],
    });
  }

  async createCommissionPolicy(body: any) {
    const { project, mode, flatRate, levels, startDate, endDate, isActive, notes } = body;
    if (!project || !mode || !startDate || !endDate) {
      throw new BadRequestException('project, mode, startDate, endDate обязательны');
    }
    if (mode === 'FLAT' && (flatRate == null || isNaN(Number(flatRate)))) {
      throw new BadRequestException('Для mode=FLAT нужен flatRate');
    }
    if (mode === 'PROGRESSIVE' && (!Array.isArray(levels) || levels.length === 0)) {
      throw new BadRequestException('Для mode=PROGRESSIVE нужен массив levels');
    }
    const start = new Date(startDate);
    const end = new Date(endDate);
    if (start >= end) throw new BadRequestException('startDate должна быть раньше endDate');
    // Проверка пересечения с другими активными политиками этого же project.
    const overlap = await this.prisma.commissionPolicy.findFirst({
      where: {
        project,
        isActive: true,
        startDate: { lte: end },
        endDate: { gte: start },
      },
    });
    if (overlap) {
      throw new BadRequestException(
        `Период пересекается с активной политикой ${overlap.id} (${overlap.startDate.toISOString().slice(0, 10)} — ${overlap.endDate.toISOString().slice(0, 10)})`,
      );
    }
    return this.prisma.commissionPolicy.create({
      data: {
        project,
        mode,
        flatRate: mode === 'FLAT' ? Number(flatRate) : null,
        levels: mode === 'PROGRESSIVE' ? levels : null,
        startDate: start,
        endDate: end,
        isActive: isActive !== false,
        notes: notes || null,
      },
    });
  }

  async updateCommissionPolicy(id: string, body: any) {
    const existing = await this.prisma.commissionPolicy.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Policy not found');
    const newStart = body.startDate ? new Date(body.startDate) : existing.startDate;
    const newEnd = body.endDate ? new Date(body.endDate) : existing.endDate;
    if (newStart >= newEnd) throw new BadRequestException('startDate должна быть раньше endDate');
    const project = body.project || existing.project;
    const overlap = await this.prisma.commissionPolicy.findFirst({
      where: {
        id: { not: id },
        project,
        isActive: true,
        startDate: { lte: newEnd },
        endDate: { gte: newStart },
      },
    });
    if (overlap && body.isActive !== false) {
      throw new BadRequestException(`Период пересекается с активной политикой ${overlap.id}`);
    }
    const data: any = {};
    if (body.project) data.project = body.project;
    if (body.mode) data.mode = body.mode;
    if (body.flatRate !== undefined) data.flatRate = body.flatRate != null ? Number(body.flatRate) : null;
    if (body.levels !== undefined) data.levels = body.levels;
    if (body.startDate) data.startDate = newStart;
    if (body.endDate) data.endDate = newEnd;
    if (body.isActive !== undefined) data.isActive = body.isActive;
    if (body.notes !== undefined) data.notes = body.notes;
    return this.prisma.commissionPolicy.update({ where: { id }, data });
  }

  async deleteCommissionPolicy(id: string) {
    const existing = await this.prisma.commissionPolicy.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Policy not found');
    await this.prisma.commissionPolicy.delete({ where: { id } });
    return { deleted: true };
  }
  // ─── Reassign client to another broker (manager/admin) ────
  // Правка 2026-05-14: руководитель брокеров (Ксения) может перевыставить уникальность
  // клиента на другого брокера. Связанные Deal/Meeting тоже переезжают. В amoCRM меняется
  // responsible_user_id у лида. Обоим брокерам — уведомление.
  async reassignClient(
    clientId: string,
    newBrokerId: string,
    reason: string,
    executorId: string,
  ) {
    if (!reason || reason.trim().length < 3) {
      throw new BadRequestException('Reason required (min 3 chars)');
    }

    const client = await this.prisma.client.findUnique({
      where: { id: clientId },
      include: { broker: { select: { id: true, fullName: true, phone: true } } },
    });
    if (!client) throw new NotFoundException('Client not found');

    const newBroker = await this.prisma.broker.findUnique({
      where: { id: newBrokerId },
      select: { id: true, fullName: true, phone: true, status: true },
    });
    if (!newBroker) throw new NotFoundException('New broker not found');
    if (newBroker.status === 'BLOCKED') throw new BadRequestException('New broker is BLOCKED');
    if (newBroker.id === client.brokerId) throw new BadRequestException('Client is already with this broker');

    const oldBroker = client.broker;

    // Найти amoUserId нового брокера (по телефону среди amoCRM users).
    let newAmoUserId: number | null = null;
    if (client.amoLeadId) {
      try {
        const users = await this.amo.getUsers();
        const cleanPhone = newBroker.phone.replace(/\D/g, '').slice(-10);
        const matched = users.find((u: any) => {
          const uPhone = String(u.phone || '').replace(/\D/g, '');
          return uPhone && uPhone.endsWith(cleanPhone);
        });
        if (matched) newAmoUserId = matched.id;
      } catch {}
    }

    // Транзакция: меняем владельца Client + связанных Deal + Meeting.
    await this.prisma.$transaction(async (tx) => {
      await tx.client.update({
        where: { id: clientId },
        data: {
          brokerId: newBrokerId,
          uniquenessReason: `Передан от ${oldBroker.fullName} (${oldBroker.phone}). Причина: ${reason}`,
        },
      });
      await tx.deal.updateMany({
        where: { clientId },
        data: { brokerId: newBrokerId },
      });
      await tx.meeting.updateMany({
        where: { clientId },
        data: { brokerId: newBrokerId },
      });
    });

    // Обновление в amoCRM (если есть линк к лиду + нашли amoUserId).
    let amoUpdated = false;
    if (client.amoLeadId && newAmoUserId) {
      try {
        await this.amo.updateLead(Number(client.amoLeadId), { responsible_user_id: newAmoUserId } as any);
        amoUpdated = true;
      } catch (e) {
        // Логируем, но не валим всю операцию (в нашей БД уже передано).
      }
    }

    // Уведомления.
    const newBrokerMsg = `Вам передан клиент ${client.fullName} (${client.phone}). Уникальность подтверждена. Причина передачи: ${reason}`;
    const oldBrokerMsg = `Клиент ${client.fullName} (${client.phone}) передан брокеру ${newBroker.fullName} по решению руководителя. Причина: ${reason}`;

    // Каналы из database NotificationChannel — поддерживаются TELEGRAM/SMS/EMAIL/PUSH/IN_APP.
    // Шлём через очередь — она пишет в notifications table и пытается отправить через канал.
    await this.notificationQueue.add('send', {
      brokerId: newBrokerId,
      channel: 'PUSH',
      subject: 'Передан клиент',
      body: newBrokerMsg,
      eventType: 'CLIENT_REASSIGNED_TO',
    });
    await this.notificationQueue.add('send', {
      brokerId: oldBroker.id,
      channel: 'PUSH',
      subject: 'Передача клиента',
      body: oldBrokerMsg,
      eventType: 'CLIENT_REASSIGNED_FROM',
    });

    // Audit log.
    await this.prisma.auditLog.create({
      data: {
        userId: executorId,
        action: 'CLIENT_REASSIGNED',
        entity: 'Client',
        entityId: clientId,
        payload: {
          oldBrokerId: oldBroker.id,
          oldBrokerName: oldBroker.fullName,
          newBrokerId,
          newBrokerName: newBroker.fullName,
          reason,
          amoUpdated,
          amoLeadId: client.amoLeadId ? String(client.amoLeadId) : null,
        },
      },
    });

    return {
      success: true,
      amoUpdated,
      newBroker: { id: newBroker.id, fullName: newBroker.fullName },
      oldBroker: { id: oldBroker.id, fullName: oldBroker.fullName },
    };
  }

  // ─── Аналитика покрытия: что в amoCRM, чего нет в нашей базе ────────
  // Dry-run: не пишет в БД, только сравнивает телефоны. Идёт в фоне,
  // потому что обход 5000+ контактов в амо по одному GET-запросу долгий.

  startAmoCoverageAnalysis() {
    if (!process.env.AMO_ACCESS_TOKEN) {
      throw new BadRequestException('AMO_ACCESS_TOKEN не настроен на сервере');
    }
    const job = this.importJobs.create();
    void this.runAmoCoverage(job.id);
    return { jobId: job.id, status: 'queued' };
  }

  private async runAmoCoverage(jobId: string) {
    try {
      this.importJobs.update(jobId, { status: 'running', step: 'parsing' });

      const leads = await this.amo.getLeadsByPipeline(BROKER_PIPELINE_ID, 250);

      // 1) Уникальные contactId из активных лидов (исключаем status_id=143 — closed-not-realized)
      const contactIds = new Set<number>();
      for (const lead of leads) {
        if (lead.status_id === 143) continue;
        const contacts = (lead as any)?._embedded?.contacts || [];
        const main = contacts.find((c: any) => c.is_main) || contacts[0];
        if (main?.id) contactIds.add(Number(main.id));
      }

      this.importJobs.setProgress(jobId, 0, contactIds.size, 'writing-brokers');

      // 2) Тянем каждый контакт, проверяем IS_BROKER флаг, нормализуем телефон
      const amoPhones = new Set<string>();
      const amoByPhone = new Map<string, { name: string; amoContactId: number }>();
      let notBrokerFlag = 0;
      let invalidPhone = 0;
      let amoErrors = 0;
      let i = 0;

      for (const contactId of contactIds) {
        i++;
        try {
          const contact: any = await this.amo.getContact(contactId);
          if (!contact) { amoErrors++; continue; }
          const fields = contact.custom_fields_values || [];
          const brokerField = fields.find((f: any) => f.field_id === AMO_CONTACT_FIELDS.IS_BROKER);
          if (brokerField?.values?.[0]?.value !== true) { notBrokerFlag++; continue; }
          const phoneField = fields.find((f: any) => f.field_id === AMO_CONTACT_FIELDS.PHONE);
          const raw = phoneField?.values?.[0]?.value || '';
          const norm = normalizePhone(raw);
          if (!norm.ok || !norm.phone) { invalidPhone++; continue; }
          amoPhones.add(norm.phone);
          if (!amoByPhone.has(norm.phone)) {
            amoByPhone.set(norm.phone, { name: contact.name || '—', amoContactId: contactId });
          }
        } catch (_) {
          amoErrors++;
        }
        if (i % 20 === 0 || i === contactIds.size) {
          this.importJobs.setProgress(jobId, i, contactIds.size, 'writing-brokers');
        }
      }

      // 3) Все телефоны брокеров в БД
      const dbBrokers = await this.prisma.broker.findMany({
        select: { phone: true, fullName: true, isInBase: true, category: true },
      });
      const dbPhones = new Set(dbBrokers.map((b) => b.phone));

      // 4) Расчёт
      let inAmoNotInDb = 0;
      let inBoth = 0;
      const examplesAmoOnly: Array<{ name: string; phone: string; amoContactId: number }> = [];
      for (const phone of amoPhones) {
        if (dbPhones.has(phone)) {
          inBoth++;
        } else {
          inAmoNotInDb++;
          if (examplesAmoOnly.length < 50) {
            const info = amoByPhone.get(phone)!;
            examplesAmoOnly.push({ name: info.name, phone, amoContactId: info.amoContactId });
          }
        }
      }

      const dbBaseOnly = dbBrokers.filter((b) => b.isInBase && !amoPhones.has(b.phone));

      this.importJobs.finish(jobId, {
        totalLeadsInAmo: leads.length,
        uniqueContactsInAmo: contactIds.size,
        notBrokerFlag,
        invalidPhone,
        amoErrors,
        uniquePhonesInAmo: amoPhones.size,
        totalBrokersInDb: dbBrokers.length,
        brokersInDbBase: dbBrokers.filter((b) => b.isInBase).length,
        inAmoNotInDb,
        inBoth,
        inDbBaseNotInAmo: dbBaseOnly.length,
        examplesAmoOnly,
      });
    } catch (e: any) {
      this.importJobs.fail(jobId, e?.message || String(e));
    }
  }

  // ─── Колл-центр (TZ v3 §5) ──────────────────────────────────────────
  // Очередь обзвона: брокеры из базы КЦ (isInBase=true), которым можно звонить
  // (doNotCall=false), отсортированные по приоритету:
  //   1) сначала те у кого nextCallAt задан (от ближайшего к далёкому)
  //   2) потом те у кого nextCallAt=null — по дате добавления (новых наверх)

  async getCallCenterQueue(query: {
    page?: string | number;
    limit?: string | number;
    category?: string;
    search?: string;
    includeAll?: string | boolean;
  }) {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Number(query.limit) || 30);
    const skip = (page - 1) * limit;

    const where: any = { isInBase: true };
    if (query.includeAll !== 'true' && query.includeAll !== true) {
      where.doNotCall = false;
    }
    if (query.category) {
      const cats = String(query.category).split(',').map((s) => s.trim()).filter(Boolean);
      if (cats.length > 0) where.category = { in: cats as any };
    }
    if (query.search) {
      const s = String(query.search).trim();
      where.OR = [
        { fullName: { contains: s, mode: 'insensitive' } },
        { phone: { contains: s } },
        { coordinatorAgency: { contains: s, mode: 'insensitive' } },
      ];
    }

    const [brokers, total] = await Promise.all([
      this.prisma.broker.findMany({
        where,
        select: {
          id: true,
          fullName: true,
          phone: true,
          category: true,
          doNotCall: true,
          isCoordinator: true,
          coordinatorAgency: true,
          lastCallAt: true,
          nextCallAt: true,
          baseSource: true,
          createdAt: true,
          callLogs: {
            select: { id: true, result: true, comment: true, campaign: true, createdAt: true },
            orderBy: { createdAt: 'desc' },
            take: 3,
          },
        },
        orderBy: [{ nextCallAt: 'asc' }, { createdAt: 'asc' }],
        skip,
        take: limit,
      }),
      this.prisma.broker.count({ where }),
    ]);

    return {
      brokers,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  // Правила автообновления брокера по результату звонка.
  // Возвращает что менять; null означает «не трогать поле».
  private callResultEffects(result: string): {
    category: string | null;
    doNotCall: boolean | null;
    nextCallDays: number | null;
  } {
    switch (result) {
      case 'NDZ':                  return { category: 'COLD',          doNotCall: null,  nextCallDays: 3 };
      case 'HUNG_UP':              return { category: 'COLD',          doNotCall: null,  nextCallDays: 1 };
      case 'DOUBLE_NDZ':           return { category: 'ON_BOT_REVIEW', doNotCall: null,  nextCallDays: null };
      case 'IN_PROGRESS':          return { category: 'HOT',           doNotCall: null,  nextCallDays: 7 };
      case 'SCHEDULED_TOUR':       return { category: 'HOT',           doNotCall: null,  nextCallDays: null };
      case 'INFORMED':             return { category: 'WARM',          doNotCall: null,  nextCallDays: null };
      case 'ALREADY_KNOWS':        return { category: 'WARM',          doNotCall: null,  nextCallDays: null };
      case 'ONLY_SEND_INFO':       return { category: 'WARM',          doNotCall: null,  nextCallDays: null };
      case 'REFUSED_TOUR':         return { category: 'WARM',          doNotCall: null,  nextCallDays: null };
      case 'WRONG_NUMBER':         return { category: 'BLACKLIST',     doNotCall: true,  nextCallDays: null };
      case 'NOT_A_BROKER':         return { category: 'BLACKLIST',     doNotCall: true,  nextCallDays: null };
      case 'NOT_BROKER_ANYMORE':   return { category: 'BLACKLIST',     doNotCall: true,  nextCallDays: null };
      case 'REFUSED_COMMUNICATION':return { category: 'ON_BOT_REVIEW', doNotCall: true,  nextCallDays: null };
      case 'ASKED_NOT_TO_CALL':    return { category: 'ON_BOT_REVIEW', doNotCall: true,  nextCallDays: null };
      case 'NEGATIVE':             return { category: 'ON_BOT_REVIEW', doNotCall: true,  nextCallDays: null };
      case 'NOT_RELEVANT':         return { category: 'ON_BOT_REVIEW', doNotCall: null,  nextCallDays: null };
      default:                     return { category: null,            doNotCall: null,  nextCallDays: null };
    }
  }

  async logCall(
    operatorId: string,
    data: {
      brokerId: string;
      result: string;
      comment?: string | null;
      campaign?: string | null;
      duration?: number | null;
      nextCallAtOverride?: string | null;
      doNotCallOverride?: boolean | null;
    },
  ) {
    const broker = await this.prisma.broker.findUnique({ where: { id: data.brokerId } });
    if (!broker) throw new NotFoundException('Брокер не найден');

    const effects = this.callResultEffects(data.result);

    // Расчёт nextCallAt: override > rule > null
    let nextCallAt: Date | null = null;
    if (data.nextCallAtOverride) {
      const d = new Date(data.nextCallAtOverride);
      if (!isNaN(d.getTime())) nextCallAt = d;
    } else if (effects.nextCallDays !== null) {
      nextCallAt = new Date(Date.now() + effects.nextCallDays * 24 * 60 * 60 * 1000);
    }

    // CONVERTED не сбрасываем — это факт встречи/сделки, выше любой категории.
    const categoryUpdate =
      broker.category === 'CONVERTED' || !effects.category
        ? undefined
        : (effects.category as any);

    // doNotCall: явный override > правило > не трогаем
    let doNotCallUpdate: boolean | undefined;
    if (data.doNotCallOverride !== null && data.doNotCallOverride !== undefined) {
      doNotCallUpdate = data.doNotCallOverride;
    } else if (effects.doNotCall === true) {
      doNotCallUpdate = true;
    }

    const callLog = await this.prisma.callLog.create({
      data: {
        brokerId: data.brokerId,
        operatorId,
        result: data.result as any,
        comment: data.comment || null,
        campaign: data.campaign || null,
        duration: data.duration ?? null,
        nextCallAt,
      },
    });

    const updated = await this.prisma.broker.update({
      where: { id: data.brokerId },
      data: {
        lastCallAt: new Date(),
        nextCallAt,
        ...(categoryUpdate ? { category: categoryUpdate } : {}),
        ...(doNotCallUpdate !== undefined ? { doNotCall: doNotCallUpdate } : {}),
      },
      select: { id: true, fullName: true, category: true, doNotCall: true, lastCallAt: true, nextCallAt: true },
    });

    return { callLog, broker: updated };
  }

  async getCallCenterStats(operatorId: string) {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [today, week, month, todayAll, queueWaiting, totalInBase] = await Promise.all([
      this.prisma.callLog.count({ where: { operatorId, createdAt: { gte: startOfDay } } }),
      this.prisma.callLog.count({ where: { operatorId, createdAt: { gte: startOfWeek } } }),
      this.prisma.callLog.count({ where: { operatorId, createdAt: { gte: startOfMonth } } }),
      this.prisma.callLog.count({ where: { createdAt: { gte: startOfDay } } }),
      this.prisma.broker.count({
        where: { isInBase: true, doNotCall: false, OR: [{ nextCallAt: null }, { nextCallAt: { lte: now } }] },
      }),
      this.prisma.broker.count({ where: { isInBase: true } }),
    ]);

    return {
      operator: { today, week, month },
      team: { today: todayAll },
      queueWaiting,
      totalInBase,
    };
  }

  // ─── Импорт брокеров из XLSX (admin) ──────────────────────────────────
  // TZ v3 §3 — Михаил сам загружает свежий снэпшот Google-таблицы через UI.
  // Логика парсинга вынесена в brokers-import.helper.ts.

  async importBrokersFromXlsx(
    file: Express.Multer.File | undefined,
    opts: {
      filter?: string;
      callFlag?: string;
      dryRun?: string | boolean;
      limit?: string | number;
      includeCoords?: string | boolean;
    },
  ) {
    if (!file || !file.buffer) {
      throw new BadRequestException('Файл не загружен');
    }

    // 1) Распарсить параметры
    const filterRaw = (opts.filter || 'ALL').toString().toUpperCase();
    const filter =
      filterRaw === 'ALL'
        ? new Set<BrokerCategoryCode>(VALID_CATEGORIES)
        : new Set<BrokerCategoryCode>(
            filterRaw.split(',').map((s) => s.trim()) as BrokerCategoryCode[],
          );
    for (const c of filter) {
      if (!VALID_CATEGORIES.includes(c)) {
        throw new BadRequestException(`Неизвестная категория в filter: ${c}`);
      }
    }

    let callFlagFilter: Set<string> | null = null;
    if (opts.callFlag && String(opts.callFlag).trim()) {
      callFlagFilter = new Set(
        String(opts.callFlag).split(',').map((s) => s.trim().toLowerCase()),
      );
      for (const f of callFlagFilter) {
        if (!(VALID_CALL_FLAGS as readonly string[]).includes(f)) {
          throw new BadRequestException(`Неизвестное значение call-flag: ${f}`);
        }
      }
    }

    const isDryRun = opts.dryRun === true || opts.dryRun === 'true' || opts.dryRun === '1';
    const includeCoords =
      opts.includeCoords === true || opts.includeCoords === 'true' || opts.includeCoords === '1';
    const limit = opts.limit ? parseInt(String(opts.limit), 10) : null;

    // 2) Прочитать xlsx из буфера
    let workbook: XLSX.WorkBook;
    try {
      workbook = XLSX.read(file.buffer, { type: 'buffer' });
    } catch (e: any) {
      throw new BadRequestException(`Не получилось распарсить xlsx: ${e?.message || e}`);
    }
    if (workbook.SheetNames.length === 0) {
      throw new BadRequestException('Файл не содержит листов');
    }
    const mainSheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(mainSheet, { defval: null });

    const coordRows: Record<string, unknown>[] = includeCoords && workbook.SheetNames.length >= 2
      ? XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[workbook.SheetNames[1]], { defval: null })
      : [];

    // 3) Фильтрация + нормализация
    const { candidates, stats } = parseAndFilter(rows, { filter, callFlagFilter, limit });

    // 4) DRY-RUN — проверить сколько уже есть в БД
    if (isDryRun) {
      const existing = await this.prisma.broker.findMany({
        where: { phone: { in: candidates.map((c) => c.phone) } },
        select: { phone: true },
      });
      const existSet = new Set(existing.map((b) => b.phone));
      const wouldUpdate = candidates.filter((c) => existSet.has(c.phone)).length;
      const wouldCreate = candidates.length - wouldUpdate;
      return {
        dryRun: true,
        stats: {
          ...stats,
          afterFilter: candidates.length,
          wouldCreate,
          wouldUpdate,
          wouldCreateCallLogs: candidates.filter((c) => c.callResult).length +
            candidates.filter((c) => c.zorgeResult).length,
          coordRows: coordRows.length,
        },
        preview: candidates.slice(0, 10).map((c) => ({
          phone: c.phone,
          name: c.name || '(без имени)',
          category: c.category,
          resultStr: c.resultStr,
          zorgeStr: c.zorgeStr,
        })),
      };
    }

    // 5) Реальный импорт — запускаем в фоне (job), возвращаем jobId сразу.
    //    Это нужно потому что 5500 брокеров × ~3-4 SQL/брокер = ~5 минут;
    //    HTTP-таймаут (nginx/браузер) убьёт коннект, пользователь подумает
    //    что не сработало и нажмёт повторно — а это удвоит CallLog.
    const job = this.importJobs.create();
    const baseSource = 'xlsx_upload';

    void this.runRealImport(job.id, candidates, coordRows, includeCoords, baseSource, stats);

    return {
      dryRun: false,
      jobId: job.id,
      status: 'queued',
      message: 'Импорт запущен в фоне. Опрашивай GET /admin/brokers/import-jobs/:id для прогресса.',
    };
  }

  // Фоновая запись импорта в БД с прогрессом и идемпотентностью CallLog.
  // Вызывается через `void` из importBrokersFromXlsx — НЕ ждём её, ошибки
  // НЕ должны утечь как unhandled rejection (всё в try/catch).
  private async runRealImport(
    jobId: string,
    candidates: Candidate[],
    coordRows: Record<string, unknown>[],
    includeCoords: boolean,
    baseSource: string,
    parseStats: any,
  ) {
    const dbStats = {
      created: 0,
      updated: 0,
      callLogsCreated: 0,
      callLogsSkipped: 0,
      errors: 0,
      coordCreated: 0,
      coordUpdated: 0,
    };
    const errors: Array<{ phone: string; error: string }> = [];

    try {
      this.importJobs.update(jobId, { status: 'running', step: 'writing-brokers' });
      this.importJobs.setProgress(jobId, 0, candidates.length, 'writing-brokers');

      let i = 0;
      for (const c of candidates) {
        i++;
        try {
          const existing = await this.prisma.broker.findUnique({ where: { phone: c.phone } });
          let brokerId: string;
          if (existing) {
            await this.prisma.broker.update({
              where: { id: existing.id },
              data: {
                category: c.category as any,
                isInBase: true,
                baseSource,
                doNotCall: existing.doNotCall || c.doNotCall,
                fullName: existing.fullName || c.name || '(без имени)',
              },
            });
            brokerId = existing.id;
            dbStats.updated++;
          } else {
            const created = await this.prisma.broker.create({
              data: {
                fullName: c.name || '(без имени)',
                phone: c.phone,
                role: 'BROKER',
                status: 'PENDING',
                category: c.category as any,
                isInBase: true,
                baseSource,
                doNotCall: c.doNotCall,
              },
            });
            brokerId = created.id;
            dbStats.created++;
          }

          // Идемпотентность CallLog: НЕ создаём дубликат если у брокера уже
          // есть запись с теми же (result, campaign, comment). Это защищает
          // от удвоения истории при повторном запуске импорта того же xlsx.
          if (c.callResult) {
            const exists = await this.prisma.callLog.findFirst({
              where: { brokerId, result: c.callResult as any, campaign: null, comment: c.comment },
              select: { id: true },
            });
            if (!exists) {
              await this.prisma.callLog.create({
                data: { brokerId, result: c.callResult as any, comment: c.comment, campaign: null },
              });
              dbStats.callLogsCreated++;
            } else {
              dbStats.callLogsSkipped++;
            }
          }
          if (c.zorgeResult) {
            const exists = await this.prisma.callLog.findFirst({
              where: { brokerId, result: c.zorgeResult as any, campaign: 'Зорге 9', comment: c.comment },
              select: { id: true },
            });
            if (!exists) {
              await this.prisma.callLog.create({
                data: { brokerId, result: c.zorgeResult as any, comment: c.comment, campaign: 'Зорге 9' },
              });
              dbStats.callLogsCreated++;
            } else {
              dbStats.callLogsSkipped++;
            }
          }
        } catch (e: any) {
          dbStats.errors++;
          if (errors.length < 20) errors.push({ phone: c.phone, error: e?.message || String(e) });
        }

        if (i % 25 === 0 || i === candidates.length) {
          this.importJobs.setProgress(jobId, i, candidates.length, 'writing-brokers');
        }
      }

      if (includeCoords && coordRows.length > 0) {
        this.importJobs.setProgress(jobId, 0, coordRows.length, 'writing-coords');
        let ci = 0;
        for (const row of coordRows) {
          ci++;
          const m = mapCoordRow(row);
          const norm = normalizePhone(m.phoneRaw);
          if (!norm.ok) continue;
          try {
            const existing = await this.prisma.broker.findUnique({ where: { phone: norm.phone! } });
            if (existing) {
              await this.prisma.broker.update({
                where: { id: existing.id },
                data: { isCoordinator: true, coordinatorAgency: m.agency, isInBase: true, baseSource },
              });
              dbStats.coordUpdated++;
            } else {
              await this.prisma.broker.create({
                data: {
                  fullName: m.name,
                  phone: norm.phone!,
                  role: 'BROKER',
                  status: 'PENDING',
                  category: 'COLD' as any,
                  isCoordinator: true,
                  coordinatorAgency: m.agency,
                  isInBase: true,
                  baseSource,
                },
              });
              dbStats.coordCreated++;
            }
          } catch (_) {
            // координаторы — не критично, не валим общий импорт
          }
          if (ci % 25 === 0 || ci === coordRows.length) {
            this.importJobs.setProgress(jobId, ci, coordRows.length, 'writing-coords');
          }
        }
      }

      this.importJobs.finish(jobId, {
        stats: { ...parseStats, afterFilter: candidates.length, coordRows: coordRows.length },
        dbStats,
        errors,
      });
    } catch (e: any) {
      this.importJobs.fail(jobId, e?.message || String(e));
    }
  }

  getImportJob(id: string) {
    return this.importJobs.get(id);
  }

}
