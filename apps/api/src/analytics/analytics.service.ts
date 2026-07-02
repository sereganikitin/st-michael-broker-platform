import { Injectable, Inject } from '@nestjs/common';
import { PrismaClient } from '@st-michael/database';

@Injectable()
export class AnalyticsService {
  constructor(@Inject('PrismaClient') private prisma: PrismaClient) {}

  async getDashboard(brokerId: string) {
    // 2026-07-02: клиенты считаются по OR — я creator ИЛИ я designated
    // (Ксения: при фиксации А → на Б оба видят клиента как своего).
    // Раньше был только brokerId=свой → Б делегированный клиент не считался,
    // а в списке /clients он был → расхождение цифр.
    const clientOwnership = {
      OR: [{ brokerId }, { responsibleBrokerId: brokerId }],
    } as any;
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
      this.prisma.client.count({ where: clientOwnership }),
      this.prisma.client.count({
        where: {
          ...clientOwnership,
          uniquenessStatus: 'CONDITIONALLY_UNIQUE',
          uniquenessExpiresAt: { gt: new Date() },
        },
      }),
      this.prisma.client.count({
        where: {
          ...clientOwnership,
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
        ...clientOwnership,
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

  // Admin overview — implements ТЗ §15.6
  async getAdminOverview(filters: { startDate?: string; endDate?: string }) {
    const from = filters.startDate ? new Date(filters.startDate) : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const to = filters.endDate ? new Date(filters.endDate) : new Date();

    // ─── Broker registrations ────────────────────────────
    const [totalBrokers, activeBrokers, blockedBrokers, newInPeriod] = await Promise.all([
      this.prisma.broker.count(),
      this.prisma.broker.count({ where: { status: 'ACTIVE' } }),
      this.prisma.broker.count({ where: { status: 'BLOCKED' } }),
      this.prisma.broker.count({ where: { createdAt: { gte: from, lte: to } } }),
    ]);

    // Registration trend — group by day for the period
    const allBrokersInPeriod = await this.prisma.broker.findMany({
      where: { createdAt: { gte: from, lte: to } },
      select: { createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    const regByDay = new Map<string, number>();
    for (const b of allBrokersInPeriod) {
      const day = b.createdAt.toISOString().slice(0, 10);
      regByDay.set(day, (regByDay.get(day) || 0) + 1);
    }
    const registrationTrend = [...regByDay.entries()]
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date));

    // ─── Fixations: unique vs not (внутри периода) ───────
    // A1 fix 2026-05-24: раньше считалось за всё время, теперь по createdAt
    // в выбранном from/to. uniqueRatio тоже становится релевантным к периоду.
    const periodFilter = { createdAt: { gte: from, lte: to } };
    const [conditionallyUnique, rejected, underReview, expired] = await Promise.all([
      this.prisma.client.count({ where: { uniquenessStatus: 'CONDITIONALLY_UNIQUE', ...periodFilter } }),
      this.prisma.client.count({ where: { uniquenessStatus: 'REJECTED', ...periodFilter } }),
      this.prisma.client.count({ where: { uniquenessStatus: 'UNDER_REVIEW', ...periodFilter } }),
      this.prisma.client.count({ where: { uniquenessStatus: 'EXPIRED', ...periodFilter } }),
    ]);
    const totalFixations = conditionallyUnique + rejected + underReview + expired;

    // ─── Deals funnel (в периоде) ────────────────────────
    // A1 fix: используем signedAt если есть, иначе createdAt (для сделок
    // которые были засинканы позже фактической даты подписания)
    const dealPeriodFilter = {
      OR: [
        { signedAt: { gte: from, lte: to } },
        { AND: [{ signedAt: null }, { createdAt: { gte: from, lte: to } }] },
      ],
    };
    const dealStatusCounts = await this.prisma.deal.groupBy({
      by: ['status'],
      where: dealPeriodFilter,
      _count: true,
      _sum: { amount: true, commissionAmount: true },
    });
    const dealsFunnel = dealStatusCounts.map((d) => ({
      status: d.status,
      count: d._count,
      totalAmount: Number(d._sum.amount || 0),
      totalCommission: Number(d._sum.commissionAmount || 0),
    }));

    // ─── Top brokers (by paid commission in period) ──────
    const topBrokerRows = await this.prisma.deal.groupBy({
      by: ['brokerId'],
      where: {
        status: { in: ['PAID', 'COMMISSION_PAID'] },
        ...dealPeriodFilter,
      },
      _sum: { amount: true, commissionAmount: true },
      _count: true,
      orderBy: { _sum: { commissionAmount: 'desc' } },
      take: 10,
    });
    const brokerIds = topBrokerRows.map((r) => r.brokerId);
    const brokerMeta = brokerIds.length
      ? await this.prisma.broker.findMany({
          where: { id: { in: brokerIds } },
          select: { id: true, fullName: true, phone: true },
        })
      : [];
    const brokerMap = new Map(brokerMeta.map((b) => [b.id, b]));
    const topBrokers = topBrokerRows.map((r) => ({
      brokerId: r.brokerId,
      fullName: brokerMap.get(r.brokerId)?.fullName || '—',
      phone: brokerMap.get(r.brokerId)?.phone || '',
      dealsCount: r._count,
      totalAmount: Number(r._sum.amount || 0),
      totalCommission: Number(r._sum.commissionAmount || 0),
    }));

    // ─── Per-project stats (в периоде) ──────────────────
    const projectGroups = await this.prisma.deal.groupBy({
      by: ['project', 'status'],
      where: dealPeriodFilter,
      _count: true,
      _sum: { amount: true, commissionAmount: true, sqm: true },
    });
    const projectStats: Record<string, any> = {};
    for (const g of projectGroups) {
      const key = g.project;
      if (!projectStats[key]) {
        projectStats[key] = {
          project: key,
          totalDeals: 0,
          paidDeals: 0,
          totalAmount: 0,
          totalCommission: 0,
          totalSqm: 0,
        };
      }
      projectStats[key].totalDeals += g._count;
      if (g.status === 'PAID' || g.status === 'COMMISSION_PAID') {
        projectStats[key].paidDeals += g._count;
        projectStats[key].totalAmount += Number(g._sum.amount || 0);
        projectStats[key].totalCommission += Number(g._sum.commissionAmount || 0);
        projectStats[key].totalSqm += Number(g._sum.sqm || 0);
      }
    }

    // ─── Funnel stage distribution ───────────────────────
    const funnelGroups = await this.prisma.broker.groupBy({
      by: ['funnelStage'],
      _count: true,
    });
    const funnelByStage = funnelGroups.map((f) => ({ stage: f.funnelStage, count: f._count }));

    return {
      period: { from: from.toISOString(), to: to.toISOString() },
      brokers: {
        total: totalBrokers,
        active: activeBrokers,
        blocked: blockedBrokers,
        newInPeriod,
        registrationTrend,
        funnelByStage,
      },
      fixations: {
        total: totalFixations,
        conditionallyUnique,
        rejected,
        underReview,
        expired,
        uniqueRatio: totalFixations > 0 ? Math.round((conditionallyUnique / totalFixations) * 100) : 0,
      },
      deals: { funnel: dealsFunnel },
      topBrokers,
      projects: Object.values(projectStats),
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
