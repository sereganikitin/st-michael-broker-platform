import { Injectable, Inject, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaClient, UniquenessStatus } from '@st-michael/database';
import { Project } from '@st-michael/shared';
import { AmoCrmAdapter } from '@st-michael/integrations';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import * as XLSX from 'xlsx';

const UNIQUENESS_DAYS = 30;
const msInDays = (days: number) => days * 24 * 60 * 60 * 1000;

@Injectable()
export class ClientFixationService {
  constructor(
    @Inject('PrismaClient') private prisma: PrismaClient,
    private amoCrmAdapter: AmoCrmAdapter,
    @InjectQueue('notifications') private notificationQueue: Queue,
  ) {}

  async fixClient(
    brokerId: string,
    data: {
      phone: string;
      fullName: string;
      comment?: string;
      project: Project;
      agencyInn: string;
    },
  ) {
    const broker = await this.prisma.broker.findUnique({ where: { id: brokerId } });
    if (!broker) throw new BadRequestException('Broker not found');

    // Find or create agency
    let agency = await this.prisma.agency.findUnique({
      where: { inn: data.agencyInn },
    });

    if (!agency) {
      const amoCompany = await this.amoCrmAdapter.findCompanyByInn(data.agencyInn);
      if (amoCompany) {
        agency = await this.prisma.agency.create({
          data: { name: amoCompany.name, inn: data.agencyInn },
        });
      } else {
        const newAmoCompany = await this.amoCrmAdapter.createCompany({
          name: `Агентство ${data.agencyInn}`,
        });
        agency = await this.prisma.agency.create({
          data: { name: newAmoCompany.name, inn: data.agencyInn },
        });
      }
    }

    // Check uniqueness scenarios
    const existingClient = await this.prisma.client.findFirst({
      where: { phone: data.phone },
      include: { deals: true, broker: true },
    });

    if (!existingClient) {
      // Scenario 1: New client
      const client = await this.prisma.client.create({
        data: {
          brokerId,
          phone: data.phone,
          fullName: data.fullName,
          comment: data.comment,
          project: data.project as any,
          fixationAgencyId: agency.id,
          uniquenessStatus: UniquenessStatus.CONDITIONALLY_UNIQUE,
          uniquenessExpiresAt: new Date(Date.now() + msInDays(UNIQUENESS_DAYS)),
        },
      });

      await this.amoCrmAdapter.createFixationRequest({
        clientPhone: data.phone,
        clientName: data.fullName,
        brokerPhone: broker.phone,
        agencyName: agency.name,
        agencyInn: agency.inn,
        comment: data.comment || '',
        project: data.project as Project,
      });

      // Update broker funnel stage if needed
      if (broker.funnelStage === 'NEW_BROKER' || broker.funnelStage === 'BROKER_TOUR') {
        await this.prisma.broker.update({
          where: { id: brokerId },
          data: { funnelStage: 'FIXATION' },
        });
      }

      await this.logAudit(brokerId, 'CLIENT_FIXATION', 'Client', client.id, {
        scenario: 'NEW_CLIENT',
        phone: data.phone,
      });

      return {
        client,
        status: 'CONDITIONALLY_UNIQUE',
        message: 'Client conditionally fixed. Expires in 30 days.',
      };
    }

    // Check deal status
    const hasClosedDeal = existingClient.deals.some(
      (deal) => deal.status === 'CANCELLED' && deal.contractType === null,
    );

    if (hasClosedDeal) {
      // Scenario 2: Reopen closed deal
      const client = await this.prisma.client.update({
        where: { id: existingClient.id },
        data: {
          brokerId,
          uniquenessStatus: UniquenessStatus.CONDITIONALLY_UNIQUE,
          uniquenessReason: 'Переоткрыта закрытая сделка',
          uniquenessExpiresAt: new Date(Date.now() + msInDays(UNIQUENESS_DAYS)),
          fixationAgencyId: agency.id,
        },
      });

      if (existingClient.amoLeadId) {
        await this.amoCrmAdapter.reopenLead(
          Number(existingClient.amoLeadId),
          broker.amoContactId ? Number(broker.amoContactId) : 0,
        );
      }

      await this.logAudit(brokerId, 'CLIENT_FIXATION', 'Client', client.id, {
        scenario: 'REOPEN_CLOSED',
        phone: data.phone,
      });

      return {
        client,
        status: 'CONDITIONALLY_UNIQUE',
        message: 'Closed deal reopened. Client conditionally fixed.',
      };
    }

    // Check if in qualification stage
    const inQualification = existingClient.deals.some((deal) =>
      ['PENDING', 'SIGNED'].includes(deal.status),
    );

    if (inQualification) {
      // Scenario 3: Conflict with another broker
      const client = await this.prisma.client.update({
        where: { id: existingClient.id },
        data: {
          uniquenessStatus: UniquenessStatus.UNDER_REVIEW,
          uniquenessReason: `Конфликт: брокер ${broker.fullName} (${broker.phone}) запросил фиксацию`,
        },
      });

      // Notify managers about the conflict
      const managers = await this.prisma.broker.findMany({
        where: { role: 'MANAGER', status: 'ACTIVE' },
      });

      for (const manager of managers) {
        await this.notificationQueue.add('send', {
          brokerId: manager.id,
          channel: 'TELEGRAM',
          subject: 'Конфликт фиксации',
          body: `Конфликт фиксации клиента ${data.phone}. Брокер ${broker.fullName} запрашивает фиксацию клиента, который уже в работе у ${existingClient.broker.fullName}.`,
        });
      }

      // Notify the requesting broker
      await this.notificationQueue.add('send', {
        brokerId,
        channel: 'SMS',
        body: `Клиент ${data.phone} находится в работе у другого брокера. Менеджер уведомлён для разрешения конфликта.`,
      });

      await this.logAudit(brokerId, 'CLIENT_FIXATION_CONFLICT', 'Client', client.id, {
        scenario: 'BROKER_CONFLICT',
        existingBrokerId: existingClient.brokerId,
      });

      return {
        client,
        status: 'UNDER_REVIEW',
        message: 'Client in qualification with another broker. Manager notified.',
      };
    }

    // Scenario 4: Active deal - reject
    return {
      status: 'REJECTED',
      message: 'Client has active deal. Cannot fix.',
    };
  }

  async getClients(
    brokerId: string,
    query: {
      page?: number;
      limit?: number;
      sortBy?: string;
      sortOrder?: 'asc' | 'desc';
      status?: string;
      project?: string;
      search?: string;
    },
  ) {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;

    const where: any = { brokerId };
    if (query.status) where.uniquenessStatus = query.status;
    if (query.project) where.project = query.project;
    if (query.search) {
      where.OR = [
        { fullName: { contains: query.search, mode: 'insensitive' } },
        { phone: { contains: query.search } },
      ];
    }

    const orderBy: any = {};
    orderBy[query.sortBy || 'createdAt'] = query.sortOrder || 'desc';

    const [clients, total] = await Promise.all([
      this.prisma.client.findMany({
        where,
        include: { deals: { select: { id: true, status: true, amount: true } } },
        skip,
        take: limit,
        orderBy,
      }),
      this.prisma.client.count({ where }),
    ]);

    return {
      clients,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getClient(id: string, brokerId: string) {
    const client = await this.prisma.client.findUnique({
      where: { id },
      include: {
        deals: { include: { lot: true, agency: true } },
        meetings: true,
        broker: { select: { id: true, fullName: true, phone: true } },
      },
    });

    if (!client) {
      throw new NotFoundException('Client not found');
    }

    // Brokers can only see their own clients; managers/admins can see all
    if (client.brokerId !== brokerId) {
      const requester = await this.prisma.broker.findUnique({ where: { id: brokerId } });
      if (requester?.role === 'BROKER') {
        throw new NotFoundException('Client not found');
      }
    }

    return client;
  }

  async extendUniqueness(id: string, brokerId: string, data: { reason: string; comment?: string }) {
    const client = await this.prisma.client.findUnique({ where: { id } });

    if (!client) throw new NotFoundException('Client not found');
    if (client.brokerId !== brokerId) throw new BadRequestException('Not your client');
    if (client.uniquenessStatus !== UniquenessStatus.CONDITIONALLY_UNIQUE) {
      throw new BadRequestException('Client is not in conditionally unique status');
    }

    await this.prisma.client.update({
      where: { id },
      data: {
        uniquenessExpiresAt: new Date(Date.now() + msInDays(UNIQUENESS_DAYS)),
        uniquenessReason: data.reason,
      },
    });

    await this.logAudit(brokerId, 'UNIQUENESS_EXTENDED', 'Client', id, { reason: data.reason });

    return { message: 'Uniqueness extended successfully' };
  }

  async markFixed(id: string, brokerId: string) {
    const client = await this.prisma.client.findUnique({ where: { id } });
    if (!client) throw new NotFoundException('Client not found');
    if (client.brokerId !== brokerId) throw new BadRequestException('Not your client');

    const updated = await this.prisma.client.update({
      where: { id },
      data: {
        fixationStatus: 'FIXED',
        fixationExpiresAt: new Date(Date.now() + msInDays(UNIQUENESS_DAYS)),
        inspectionActSigned: true,
      },
    });

    await this.logAudit(brokerId, 'CLIENT_FIXED', 'Client', id, {});

    return { client: updated, message: 'Client marked as fixed' };
  }

  async resolveUniqueness(id: string, managerId: string, data: { status: UniquenessStatus; reason: string }) {
    const client = await this.prisma.client.findUnique({ where: { id } });
    if (!client) throw new NotFoundException('Client not found');

    const updated = await this.prisma.client.update({
      where: { id },
      data: {
        uniquenessStatus: data.status,
        uniquenessReason: data.reason,
      },
    });

    // Notify the broker about the resolution
    await this.notificationQueue.add('send', {
      brokerId: client.brokerId,
      channel: 'SMS',
      subject: 'Результат проверки уникальности',
      body: `Решение по клиенту ${client.fullName}: ${data.status === 'CONDITIONALLY_UNIQUE' ? 'одобрено' : 'отклонено'}. ${data.reason}`,
    });

    await this.logAudit(managerId, 'UNIQUENESS_RESOLVED', 'Client', id, {
      status: data.status,
      reason: data.reason,
    });

    return { client: updated, message: 'Uniqueness conflict resolved' };
  }

  async importClients(brokerId: string, fileBuffer: Buffer) {
    const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows: any[] = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    if (rows.length === 0) throw new BadRequestException('Файл пустой или не содержит данных');

    // Normalize column names
    const normalize = (key: string) => key.trim().toLowerCase();
    const findCol = (row: any, variants: string[]): string => {
      const keys = Object.keys(row);
      for (const v of variants) {
        const found = keys.find((k) => normalize(k).includes(v));
        if (found) return row[found]?.toString().trim() || '';
      }
      return '';
    };

    let imported = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const fullName = findCol(row, ['фио', 'имя', 'name', 'fullname']);
      const rawPhone = findCol(row, ['телефон', 'phone', 'тел']);
      const email = findCol(row, ['email', 'почта', 'mail']);
      const comment = findCol(row, ['комментарий', 'comment', 'примечание']);
      const projectRaw = findCol(row, ['проект', 'project']).toUpperCase();

      if (!fullName || !rawPhone) {
        errors.push(`Строка ${i + 2}: не заполнены ФИО или телефон`);
        skipped++;
        continue;
      }

      // Normalize phone: ensure +7XXXXXXXXXX format
      let phone = rawPhone.replace(/[\s\-()]/g, '');
      if (phone.startsWith('8') && phone.length === 11) phone = '+7' + phone.slice(1);
      if (!phone.startsWith('+')) phone = '+' + phone;

      const project = Object.values(Project).includes(projectRaw as Project)
        ? (projectRaw as Project)
        : Project.ZORGE9;

      try {
        const existing = await this.prisma.client.findFirst({ where: { phone, brokerId } });
        if (existing) { skipped++; continue; }

        await this.prisma.client.create({
          data: {
            brokerId,
            fullName,
            phone,
            email: email || null,
            comment: comment || null,
            project,
            uniquenessStatus: UniquenessStatus.CONDITIONALLY_UNIQUE,
            uniquenessExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          },
        });
        imported++;
      } catch {
        errors.push(`Строка ${i + 2}: ошибка при сохранении (${fullName})`);
        skipped++;
      }
    }

    return { imported, skipped, errors: errors.slice(0, 20) };
  }

  private async logAudit(userId: string, action: string, entity: string, entityId: string, payload: any) {
    await this.prisma.auditLog.create({
      data: { userId, action, entity, entityId, payload },
    });
  }
}
