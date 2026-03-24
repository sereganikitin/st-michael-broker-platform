import { Injectable, Inject } from '@nestjs/common';
import { PrismaClient } from '@st-michael/database';

@Injectable()
export class AnalyticsService {
  constructor(@Inject('PrismaClient') private prisma: PrismaClient) {}

  async getDashboard(brokerId: string) {
    const [
      totalClients,
      activeFixations,
      expiredFixations,
      totalDeals,
      pendingDeals,
      paidDeals,
      commissionStats,
      upcomingMeetings,
    ] = await Promise.all([
      this.prisma.client.count({ where: { brokerId } }),
      this.prisma.client.count({
        where: {
          brokerId,
          uniquenessStatus: 'CONDITIONALLY_UNIQUE',
          uniquenessExpiresAt: { gt: new Date() },
        },
      }),
      this.prisma.client.count({
        where: {
          brokerId,
          uniquenessStatus: 'EXPIRED',
        },
      }),
      this.prisma.deal.count({ where: { brokerId } }),
      this.prisma.deal.count({ where: { brokerId, status: 'PENDING' } }),
      this.prisma.deal.count({ where: { brokerId, status: { in: ['PAID', 'COMMISSION_PAID'] } } }),
      this.prisma.deal.aggregate({
        where: { brokerId, status: { in: ['PAID', 'COMMISSION_PAID'] } },
        _sum: { commissionAmount: true, amount: true },
      }),
      this.prisma.meeting.count({
        where: {
          brokerId,
          date: { gte: new Date() },
          status: { in: ['PENDING', 'CONFIRMED'] },
        },
      }),
    ]);

    // Fixations expiring in next 7 days
    const expiringFixations = await this.prisma.client.count({
      where: {
        brokerId,
        uniquenessStatus: 'CONDITIONALLY_UNIQUE',
        uniquenessExpiresAt: {
          gt: new Date(),
          lt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      },
    });

    return {
      clients: {
        total: totalClients,
        activeFixations,
        expiredFixations,
        expiringFixations,
      },
      deals: {
        total: totalDeals,
        pending: pendingDeals,
        paid: paidDeals,
        totalAmount: Number(commissionStats._sum.amount || 0),
      },
      commission: {
        totalEarned: Number(commissionStats._sum.commissionAmount || 0),
      },
      meetings: {
        upcoming: upcomingMeetings,
      },
    };
  }

  async getFunnel(filters: {
    startDate?: string;
    endDate?: string;
    project?: string;
  }) {
    const where: any = {};
    if (filters.startDate) where.createdAt = { ...(where.createdAt || {}), gte: new Date(filters.startDate) };
    if (filters.endDate) where.createdAt = { ...(where.createdAt || {}), lte: new Date(filters.endDate) };

    const [newBrokers, brokerTour, fixation, meeting, deal] = await Promise.all([
      this.prisma.broker.count({ where: { ...where, funnelStage: 'NEW_BROKER' } }),
      this.prisma.broker.count({ where: { ...where, funnelStage: 'BROKER_TOUR' } }),
      this.prisma.broker.count({ where: { ...where, funnelStage: 'FIXATION' } }),
      this.prisma.broker.count({ where: { ...where, funnelStage: 'MEETING' } }),
      this.prisma.broker.count({ where: { ...where, funnelStage: 'DEAL' } }),
    ]);

    const stages = [
      { name: 'Новый брокер', stage: 'NEW_BROKER', count: newBrokers },
      { name: 'Брокер-тур', stage: 'BROKER_TOUR', count: brokerTour },
      { name: 'Фиксация', stage: 'FIXATION', count: fixation },
      { name: 'Встреча', stage: 'MEETING', count: meeting },
      { name: 'Сделка', stage: 'DEAL', count: deal },
    ];

    const total = stages.reduce((sum, s) => sum + s.count, 0);

    return {
      stages: stages.map((s) => ({
        ...s,
        percentage: total > 0 ? Math.round((s.count / total) * 100) : 0,
      })),
      total,
    };
  }

  async getBrokerAnalytics(brokerId: string, period: { startDate?: string; endDate?: string }) {
    const dateFilter: any = {};
    if (period.startDate) dateFilter.gte = new Date(period.startDate);
    if (period.endDate) dateFilter.lte = new Date(period.endDate);
    const hasDateFilter = Object.keys(dateFilter).length > 0;

    const [
      clientsCreated,
      meetingsHeld,
      dealsClosed,
      callsMade,
    ] = await Promise.all([
      this.prisma.client.count({
        where: {
          brokerId,
          ...(hasDateFilter ? { createdAt: dateFilter } : {}),
        },
      }),
      this.prisma.meeting.count({
        where: {
          brokerId,
          status: 'COMPLETED',
          ...(hasDateFilter ? { date: dateFilter } : {}),
        },
      }),
      this.prisma.deal.count({
        where: {
          brokerId,
          status: { in: ['PAID', 'COMMISSION_PAID'] },
          ...(hasDateFilter ? { createdAt: dateFilter } : {}),
        },
      }),
      this.prisma.call.count({
        where: {
          brokerId,
          ...(hasDateFilter ? { createdAt: dateFilter } : {}),
        },
      }),
    ]);

    return {
      period: {
        startDate: period.startDate || null,
        endDate: period.endDate || null,
      },
      metrics: {
        clientsCreated,
        meetingsHeld,
        dealsClosed,
        callsMade,
        conversionRate: clientsCreated > 0
          ? Math.round((dealsClosed / clientsCreated) * 100)
          : 0,
      },
    };
  }
}
