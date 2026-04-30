import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@st-michael/database';
import { AmocrmService } from '../amocrm/amocrm.service';

@Injectable()
export class AdminService {
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
}
