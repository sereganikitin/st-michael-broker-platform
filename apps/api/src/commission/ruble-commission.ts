/** Current published cooperation terms; historical sqm policies are intentionally separate. */
export const RUB_COMMISSION_MARKER = 'SALES_RUB_2026';
// Activation is prospective: do not recalculate contracts preceding this release.
export const RUB_DISPLAY_START = new Date('2026-10-10T21:00:00.000Z');
export const RUB_DISPLAY_END = new Date('2027-01-31T20:59:59.999Z');
export function currentRubleTerms(date = new Date()): boolean {
  return date >= RUB_DISPLAY_START && date <= RUB_DISPLAY_END;
}
export function currentRubleDisplayPolicies(date = new Date()): any[] | null {
  if (date > RUB_DISPLAY_END) return [];
  if (!currentRubleTerms(date)) return null;
  return ['ZORGE9', 'SILVER_BOR'].map(project => ({
    id: null, project, mode:'PROGRESSIVE', basis:RUB_COMMISSION_MARKER,
    source:'PUBLISHED_COOPERATION_TERMS', sourceUrl:'/files/cooperation/33f2417b-965c-4efb-837d-982cb359d30b.pdf',
    levels:RUB_COMMISSION_LEVELS, flatRate:null, minRate:4.2, maxRate:6,
    installmentEnabled:true, installmentDiscount:.5, subsidizedMortgageEnabled:true, subsidizedMortgageRate:4,
    displayNote:'Полная оплата и стандартная ипотека — 5%; рассрочка: ПВ >50% — 4,5%, ПВ ≤50% — 4%; субсидированная ипотека — 4%. Дополнительно 0,2–1% по общему объёму подписанных договоров в рублях. Достигнутый уровень сохраняется до 31.01.2027. Расчёт предварительный; начисления подтверждаются отдельно.',
    startDate:RUB_DISPLAY_START, endDate:RUB_DISPLAY_END,
  }));
}
export const RUB_COMMISSION_LEVELS = [
  [0, .2], [150_000_000, .3], [200_000_000, .4], [250_000_000, .5],
  [300_000_000, .6], [350_000_000, .7], [450_000_000, .8],
  [550_000_000, .9], [650_000_000, 1],
].map(([minSalesRub, bonusRate], index) => ({
  level: `RUB_${index}`, basis: RUB_COMMISSION_MARKER, minSalesRub, bonusRate,
  rate: 5 + bonusRate,
}));

export function isRublePolicy(policy: any): boolean {
  return Array.isArray(policy?.levels) && policy.levels.length > 0
    && policy.levels.every((item: any) => item.basis === RUB_COMMISSION_MARKER);
}

export function rubleBonus(volume: number): number {
  if (!Number.isFinite(volume) || volume < 0) throw new Error('Unknown sales volume');
  return [...RUB_COMMISSION_LEVELS].reverse().find(item => volume >= item.minSalesRub)!.bonusRate;
}

export function rublePaymentRate(paymentMode: string, downPaymentPercent?: number): number {
  if (paymentMode === 'FULL') return 5;
  if (paymentMode === 'SUBSIDIZED_MORTGAGE') return 4;
  if (paymentMode === 'INSTALLMENT') {
    if (!Number.isFinite(downPaymentPercent) || downPaymentPercent! < 0 || downPaymentPercent! > 100) {
      throw new Error('Specify down payment percentage');
    }
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
