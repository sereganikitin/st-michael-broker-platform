import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { PrismaClient, CommissionLevel } from '@st-michael/database';

// Commission rates by project and level
const COMMISSION_RATES: Record<string, Record<string, number>> = {
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
    START: 4.5,
    BASIC: 5.0,
    STRONG: 5.5,
    PREMIUM: 6.0,
    ELITE: 6.5,
    CHAMPION: 7.0,
    LEGEND: 7.5,
  },
};

// Thresholds in sqm sold for each level
const LEVEL_THRESHOLDS: { level: CommissionLevel; minSqm: number }[] = [
  { level: CommissionLevel.START, minSqm: 0 },
  { level: CommissionLevel.BASIC, minSqm: 50 },
  { level: CommissionLevel.STRONG, minSqm: 150 },
  { level: CommissionLevel.PREMIUM, minSqm: 300 },
  { level: CommissionLevel.ELITE, minSqm: 500 },
  { level: CommissionLevel.CHAMPION, minSqm: 800 },
  { level: CommissionLevel.LEGEND, minSqm: 1200 },
];

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
    const level = primaryAgency?.commissionLevel || CommissionLevel.START;
    const totalSqmSold = primaryAgency ? Number(primaryAgency.totalSqmSold) : 0;

    // Find current level index and next level threshold
    const currentLevelIndex = LEVEL_THRESHOLDS.findIndex((t) => t.level === level);
    const nextLevel = LEVEL_THRESHOLDS[currentLevelIndex + 1];

    const progress = nextLevel
      ? Math.min(100, Math.round((totalSqmSold / nextLevel.minSqm) * 100))
      : 100;

    // Calculate rates for each project
    const rates: Record<string, number> = {};
    for (const project of Object.keys(COMMISSION_RATES)) {
      rates[project] = COMMISSION_RATES[project][level] || 5.0;
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

    const level = agency?.commissionLevel || CommissionLevel.START;
    const projectRates = COMMISSION_RATES[data.project] || COMMISSION_RATES.ZORGE9;
    let rate = projectRates[level] || 5.0;

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
