/** Current published cooperation terms; historical sqm policies are intentionally separate. */
export const RUB_COMMISSION_MARKER = 'SALES_RUB_2026';
// 2026-10-23: owner-approved «Условия сотрудничества» PDF. Zorge 9 now has its
// own base rates (5,5%; installment threshold 30%), Квартал Серебряный Бор is
// unchanged. The accumulative bonus scale is the same for both projects.
export const RUB_TERMS_SOURCE_SHA256 = '18e988f20f531286726952be5dcb3a7ef8f6052e0fc42318a7dee84a6db450a1';
export const RUB_TERMS_SOURCE_URL = '/files/cooperation/cooperation-terms-2026-10-23-18e988f20f531286.pdf';
// Activation is prospective: do not recalculate contracts preceding this release.
export const RUB_DISPLAY_START = new Date('2026-10-10T21:00:00.000Z');
export const RUB_DISPLAY_END = new Date('2027-01-31T20:59:59.999Z');

export type RubleProject = 'ZORGE9' | 'SILVER_BOR';
export const RUBLE_PROJECTS: readonly RubleProject[] = ['ZORGE9', 'SILVER_BOR'];
/** Base rate for 100% payment / standard (non-subsidized) mortgage. */
export const RUB_FULL_RATE: Record<RubleProject, number> = { ZORGE9: 5.5, SILVER_BOR: 5 };
const RUB_SUBSIDIZED_MORTGAGE_RATE = 4;

const RUB_DISPLAY_NOTE_TAIL = 'Дополнительно 0,2–1% по общему объёму подписанных договоров в рублях. Повышенная надбавка применяется уже к сделке, достигающей порога. Достигнутый по итогам 2026 года уровень сохраняется до 31.01.2027. Расчёт предварительный; начисления подтверждаются отдельно.';
const RUB_DISPLAY_NOTES: Record<RubleProject, string> = {
  ZORGE9: `Полная оплата и стандартная несубсидированная ипотека — 5,5%; рассрочка: ПВ от 30% — 4,5%, ПВ менее 30% — 4%; субсидированная ипотека — 4%. ${RUB_DISPLAY_NOTE_TAIL}`,
  SILVER_BOR: `Полная оплата и стандартная ипотека — 5%; рассрочка: ПВ >50% — 4,5%, ПВ ≤50% — 4%; субсидированная ипотека — 4%. ${RUB_DISPLAY_NOTE_TAIL}`,
};

export function isRubleProject(project: unknown): project is RubleProject {
  return project === 'ZORGE9' || project === 'SILVER_BOR';
}
export function currentRubleTerms(date = new Date()): boolean {
  return date >= RUB_DISPLAY_START && date <= RUB_DISPLAY_END;
}
export function currentRubleDisplayPolicies(date = new Date()): any[] | null {
  if (date > RUB_DISPLAY_END) return [];
  if (!currentRubleTerms(date)) return null;
  return RUBLE_PROJECTS.map(project => ({
    id: null, project, mode:'PROGRESSIVE', basis:RUB_COMMISSION_MARKER,
    source:'PUBLISHED_COOPERATION_TERMS', sourceName:'Условия сотрудничества ST MICHAEL.pdf', sourceSha256:RUB_TERMS_SOURCE_SHA256,
    sourceUrl:RUB_TERMS_SOURCE_URL,
    levels:RUB_COMMISSION_LEVELS_BY_PROJECT[project], flatRate:null,
    minRate:RUB_SUBSIDIZED_MORTGAGE_RATE + RUB_BONUS_LEVELS[0][1],
    maxRate:RUB_FULL_RATE[project] + RUB_BONUS_LEVELS[RUB_BONUS_LEVELS.length - 1][1],
    installmentEnabled:true, installmentDiscount:.5, subsidizedMortgageEnabled:true, subsidizedMortgageRate:RUB_SUBSIDIZED_MORTGAGE_RATE,
    displayNote:RUB_DISPLAY_NOTES[project],
    startDate:RUB_DISPLAY_START, endDate:RUB_DISPLAY_END,
  }));
}
const RUB_BONUS_LEVELS: ReadonlyArray<readonly [number, number]> = [
  [0, .2], [150_000_000, .3], [200_000_000, .4], [250_000_000, .5],
  [300_000_000, .6], [350_000_000, .7], [450_000_000, .8],
  [550_000_000, .9], [650_000_000, 1],
];
export function rubleCommissionLevels(project: RubleProject) {
  return RUB_BONUS_LEVELS.map(([minSalesRub, bonusRate], index) => ({
    level: `RUB_${index}`, basis: RUB_COMMISSION_MARKER, minSalesRub, bonusRate,
    rate: Math.round((RUB_FULL_RATE[project] + bonusRate) * 100) / 100,
  }));
}
export const RUB_COMMISSION_LEVELS_BY_PROJECT: Record<RubleProject, ReturnType<typeof rubleCommissionLevels>> = {
  ZORGE9: rubleCommissionLevels('ZORGE9'),
  SILVER_BOR: rubleCommissionLevels('SILVER_BOR'),
};

export function isRublePolicy(policy: any): boolean {
  return Array.isArray(policy?.levels) && policy.levels.length > 0
    && policy.levels.every((item: any) => item.basis === RUB_COMMISSION_MARKER);
}

export function rubleBonus(volume: number): number {
  if (!Number.isFinite(volume) || volume < 0) throw new Error('Unknown sales volume');
  return [...RUB_BONUS_LEVELS].reverse().find(([minSalesRub]) => volume >= minSalesRub)![1];
}

/** A calculator quote is for a NEW, not-yet-included contract. January freezes 2026 volume. */
export function prospectiveRubleBonus(confirmedSalesRub: number, proposedAmount: number, date = new Date()) {
  if (!Number.isFinite(proposedAmount) || proposedAmount <= 0) throw new Error('Invalid proposed amount');
  rubleBonus(confirmedSalesRub); // validates known nonnegative volume
  const includesProposedDeal = date <= new Date('2026-12-31T20:59:59.999Z');
  const bonusBasisRub = confirmedSalesRub + (includesProposedDeal ? proposedAmount : 0);
  return { bonusRate:rubleBonus(bonusBasisRub), bonusBasisRub, includesProposedDeal };
}

export function rublePaymentRate(project: string, paymentMode: string, downPaymentPercent?: number): number {
  if (!isRubleProject(project)) throw new Error('Unsupported project');
  if (paymentMode === 'FULL') return RUB_FULL_RATE[project];
  if (paymentMode === 'SUBSIDIZED_MORTGAGE') return RUB_SUBSIDIZED_MORTGAGE_RATE;
  if (paymentMode === 'INSTALLMENT') {
    if (!Number.isFinite(downPaymentPercent) || downPaymentPercent! < 0 || downPaymentPercent! > 100) {
      throw new Error('Specify down payment percentage');
    }
    // Zorge 9: ПВ от 30% включительно — 4,5%. КСБ: ПВ более 50% — 4,5%.
    if (project === 'ZORGE9') return downPaymentPercent! >= 30 ? 4.5 : 4;
    return downPaymentPercent! > 50 ? 4.5 : 4;
  }
  throw new Error('Unsupported payment mode');
}

/** Read only: include both projects, signed contracts in 2026, and deduplicate amo parent cards. */
export async function confirmedAgencySalesRub(prisma: any, agencyId: string | undefined, date = new Date()): Promise<number | null> {
  if (!agencyId) return null;
  const cap = new Date(Math.min(date.getTime(), new Date('2026-12-31T20:59:59.999Z').getTime()));
  const rows = await prisma.deal.findMany({
    where: {
      agencyId, project: { in: ['ZORGE9', 'SILVER_BOR'] },
      status: { in: ['SIGNED', 'PAID', 'COMMISSION_PAID'] },
      signedAt: { gte: new Date('2025-12-31T21:00:00.000Z'), lte: cap },
    },
    select: { id: true, amount: true, contractType: true, amoDealId: true, amoParentDealId: true },
  });
  // An empty local import is not proof that the agency made zero sales in amoCRM.
  if (rows.length === 0) return null;
  const unique = new Map<string, number>();
  for (const row of rows) {
    const amount = Number(row.amount);
    if (!['DDU', 'PDKP', 'DKP'].includes(row.contractType) || !Number.isFinite(amount) || amount <= 0) return null;
    const key = String(row.amoParentDealId || row.amoDealId || row.id);
    if (unique.has(key) && unique.get(key) !== amount) return null;
    unique.set(key, amount);
  }
  return [...unique.values()].reduce((sum, amount) => sum + amount, 0);
}
