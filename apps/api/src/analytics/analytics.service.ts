import { Injectable, Inject } from '@nestjs/common';
import { PrismaClient } from '@st-michael/database';

@Injectable()
export class AnalyticsService {
  constructor(@Inject('PrismaClient') private prisma: PrismaClient) {}

  async getDashboard(brokerId: string) {
    // 2026-07-03: на дашборде показываем ТОЛЬКО клиентов-владельцев (creator).
    // Делегированные (когда А фиксирует на Б) в дашборд Б не входят: комиссия,
    // м² в уровень, статистика — всё это идёт создателю (А). У Б они видны
    // только в списке /clients как «Исполнитель по фиксации».
    // Раньше был OR по responsibleBrokerId — из-за этого у Б в дашборде
    // считались клиенты, за которых он не получает ни денег, ни зачёта.
    const clientOwnership = { brokerId } as any;
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

  // 2026-07-07: удалён неиспользуемый метод getFunnel() — эндпоинт
  // GET /analytics/funnel был мёртвым кодом (фронтенд его не дёргал),
  // распределение по стадиям воронки живёт внутри getAdminOverview
  // (funnelByStage).

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
    // 2026-07-07 (багфикс): раньше воронка считалась за всё время, не
    // учитывая выбранный период — пользователь выбирал «Месяц», а видел
    // распределение всех брокеров за всю историю. Теперь фильтруем
    // группировку по createdAt in [from, to] — цифры совпадают с
    // «Новых в периоде» и графиком регистраций.
    const funnelGroups = await this.prisma.broker.groupBy({
      by: ['funnelStage'],
      where: { createdAt: { gte: from, lte: to } },
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
      uniqueFixations,
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
      // 2026-07-07: раньше конверсия считалась как dealsClosed / clientsCreated —
      // это неправильно: в знаменателе учитывались клиенты в UNDER_REVIEW и
      // REJECTED, у которых сделки быть не могло в принципе. Теперь считаем
      // «Фиксация → Сделка»: сколько % уникальных фиксаций дошли до PAID.
      this.prisma.client.count({
        where: {
          brokerId,
          uniquenessStatus: 'CONDITIONALLY_UNIQUE',
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
        uniqueFixations,
        meetingsHeld,
        dealsClosed,
        callsMade,
        // «% фиксаций, которые дошли до сделки» — правильная воронка брокера.
        conversionRate: uniqueFixations > 0
          ? Math.round((dealsClosed / uniqueFixations) * 100)
          : 0,
      },
    };
  }
}
