import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { PrismaClient, CommissionLevel } from '@st-michael/database';

// Commission rates by project and level (per ТЗ "Условия_вознаграждения_объединённая_шкала")
// Period: with 1 January through 30 June 2026.
export const COMMISSION_RATES: Record<string, Record<string, number>> = {
  ZORGE9: {
    START: 5.0,
    BASIC: 5.5,
    STRONG: 6.0,
    PREMIUM: 6.5,
    ELITE: 7.0,
    CHAMPION: 7.5,
    LEGEND: 8.0,
  },
  SILVER_BOR: {
    START: 5.0,
    BASIC: 5.25,
    STRONG: 5.5,
    PREMIUM: 5.75,
    ELITE: 6.0,
    CHAMPION: 6.25,
    // Серебряный Бор не имеет уровня LEGEND — максимум CHAMPION 6.25%
  },
};

// Thresholds — РАЗНЫЕ для каждого проекта (минимум м² для уровня).
// Уровень считается по общему накопленному метражу агентства, но шкала своя на проект.
export const LEVEL_THRESHOLDS_BY_PROJECT: Record<string, { level: CommissionLevel; minSqm: number }[]> = {
  ZORGE9: [
    { level: CommissionLevel.LEGEND, minSqm: 700 },
    { level: CommissionLevel.CHAMPION, minSqm: 500 },
    { level: CommissionLevel.ELITE, minSqm: 320 },
    { level: CommissionLevel.PREMIUM, minSqm: 200 },
    { level: CommissionLevel.STRONG, minSqm: 120 },
    { level: CommissionLevel.BASIC, minSqm: 60 },
    { level: CommissionLevel.START, minSqm: 0 },
  ],
  SILVER_BOR: [
    { level: CommissionLevel.CHAMPION, minSqm: 400 },
    { level: CommissionLevel.ELITE, minSqm: 280 },
    { level: CommissionLevel.PREMIUM, minSqm: 171 },
    { level: CommissionLevel.STRONG, minSqm: 96 },
    { level: CommissionLevel.BASIC, minSqm: 48 },
    { level: CommissionLevel.START, minSqm: 0 },
  ],
};

// Compute level for given total sqm sold within a specific project's scale.
// Thresholds are sorted descending — pick first match.
export function levelForSqm(project: string, totalSqm: number): CommissionLevel {
  const scale = LEVEL_THRESHOLDS_BY_PROJECT[project] || LEVEL_THRESHOLDS_BY_PROJECT.ZORGE9;
  for (const t of scale) {
    if (totalSqm >= t.minSqm) return t.level;
  }
  return CommissionLevel.START;
}

// Get rate for project + level (with safe fallback if SB doesn't have LEGEND).
export function rateFor(project: string, level: CommissionLevel | string): number {
  const projectRates = COMMISSION_RATES[project] || COMMISSION_RATES.ZORGE9;
  return projectRates[level as string] ?? projectRates.START ?? 5.0;
}

const INSTALLMENT_DISCOUNT = 0.5;

@Injectable()
export class CommissionService {
  constructor(@Inject('PrismaClient') private prisma: PrismaClient) {}

  async getMyCommission(brokerId: string) {
    const broker = await this.prisma.broker.findUnique({
      where: { id: brokerId },
      include: {
        brokerAgencies: {
          include: { agency: true },
          where: { isPrimary: true },
          take: 1,
        },
      },
    });

    if (!broker) throw new NotFoundException('Broker not found');

    const primaryAgency = broker.brokerAgencies[0]?.agency;
    const totalSqmSold = primaryAgency ? Number(primaryAgency.totalSqmSold) : 0;

    // Уровень считается отдельно для каждого проекта по его шкале.
    // Используем шкалу Зорге как «основную» для отображения.
    const level = levelForSqm('ZORGE9', totalSqmSold);

    // Next-level threshold based on Зорге scale (UI shows progress towards it)
    const zorgeScale = LEVEL_THRESHOLDS_BY_PROJECT.ZORGE9;
    const ascending = [...zorgeScale].sort((a, b) => a.minSqm - b.minSqm);
    const currentIdx = ascending.findIndex((t) => t.level === level);
    const nextLevel = ascending[currentIdx + 1];

    const progress = nextLevel
      ? Math.min(100, Math.round((totalSqmSold / nextLevel.minSqm) * 100))
      : 100;

    // Per-project rates (project may have a different level for the same total sqm)
    const rates: Record<string, number> = {};
    for (const project of Object.keys(COMMISSION_RATES)) {
      const lvl = levelForSqm(project, totalSqmSold);
      rates[project] = rateFor(project, lvl);
    }

    // Get commission stats
    const deals = await this.prisma.deal.findMany({
      where: { brokerId, status: { in: ['PAID', 'COMMISSION_PAID'] } },
      select: { commissionAmount: true, commissionRate: true, project: true },
    });

    const totalEarned = deals.reduce((sum, d) => sum + Number(d.commissionAmount), 0);
    const quarterlyBonus = primaryAgency?.quarterlyBonusStreak || 0;

    return {
      level,
      rates,
      totalSqmSold,
      progress,
      nextLevel: nextLevel?.level || null,
      nextLevelSqm: nextLevel?.minSqm || null,
      totalEarned,
      quarterlyBonusStreak: quarterlyBonus,
      agency: primaryAgency
        ? { id: primaryAgency.id, name: primaryAgency.name, inn: primaryAgency.inn }
        : null,
    };
  }

  async calculateCommission(data: {
    amount: number;
    project: string;
    agencyInn: string;
    isInstallment?: boolean;
  }) {
    // Look up the agency's commission level
    const agency = await this.prisma.agency.findUnique({
      where: { inn: data.agencyInn },
    });

    const totalSqm = agency ? Number(agency.totalSqmSold) : 0;
    const level = levelForSqm(data.project, totalSqm);
    let rate = rateFor(data.project, level);

    if (data.isInstallment) {
      rate -= INSTALLMENT_DISCOUNT;
    }

    const commission = (data.amount * rate) / 100;

    return {
      amount: data.amount,
      level,
      rate,
      commission,
      isInstallment: data.isInstallment || false,
      agencyName: agency?.name || null,
    };
  }

  async getBrokerCommission(brokerId: string) {
    const deals = await this.prisma.deal.findMany({
      where: { brokerId, status: { in: ['SIGNED', 'PAID', 'COMMISSION_PAID'] } },
      include: { client: { select: { fullName: true } }, lot: { select: { number: true } } },
      orderBy: { createdAt: 'desc' },
    });

    return deals.map((deal) => ({
      id: deal.id,
      clientName: deal.client.fullName,
      lotNumber: deal.lot?.number || null,
      project: deal.project,
      amount: Number(deal.amount),
      rate: Number(deal.commissionRate),
      commission: Number(deal.commissionAmount),
      status: deal.status,
      isInstallment: deal.isInstallment,
      createdAt: deal.createdAt,
    }));
  }
}
