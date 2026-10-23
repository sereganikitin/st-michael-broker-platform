import { confirmedAgencySalesRub, currentRubleDisplayPolicies, isRublePolicy, prospectiveRubleBonus, RUB_COMMISSION_LEVELS_BY_PROJECT, RUB_TERMS_SOURCE_SHA256, RUB_TERMS_SOURCE_URL, rubleBonus, rublePaymentRate } from './ruble-commission';
import { CommissionService, rateForWithPolicy } from './commission.service';

describe('Published ruble commission rules', () => {
  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(new Date('2026-10-23T14:00:00Z')); });
  afterEach(() => jest.useRealTimers());
  it.each([[0,.2],[149999999,.2],[150000000,.3],[200000000,.4],[250000000,.5],[300000000,.6],[350000000,.7],[450000000,.8],[550000000,.9],[650000000,1]])('volume %s -> bonus %s', (volume, bonus) => expect(rubleBonus(volume)).toBe(bonus));
  it.each([NaN, Infinity, -1])('does not invent unknown volume %s', value => expect(() => rubleBonus(value)).toThrow());
  it('Квартал Серебряный Бор keeps 5% and separates down payment at the strict 50% boundary', () => {
    expect(rublePaymentRate('SILVER_BOR', 'FULL')).toBe(5);
    expect(rublePaymentRate('SILVER_BOR', 'SUBSIDIZED_MORTGAGE')).toBe(4);
    expect(rublePaymentRate('SILVER_BOR', 'INSTALLMENT', 50)).toBe(4);
    expect(rublePaymentRate('SILVER_BOR', 'INSTALLMENT', 50.01)).toBe(4.5);
    expect(() => rublePaymentRate('SILVER_BOR', 'INSTALLMENT')).toThrow();
  });
  it('Zorge 9 uses 5.5% and the inclusive 30% installment boundary', () => {
    expect(rublePaymentRate('ZORGE9', 'FULL')).toBe(5.5);
    expect(rublePaymentRate('ZORGE9', 'SUBSIDIZED_MORTGAGE')).toBe(4);
    expect(rublePaymentRate('ZORGE9', 'INSTALLMENT', 30)).toBe(4.5);
    expect(rublePaymentRate('ZORGE9', 'INSTALLMENT', 29.99)).toBe(4);
    expect(rublePaymentRate('ZORGE9', 'INSTALLMENT', 50)).toBe(4.5);
    expect(() => rublePaymentRate('ZORGE9', 'INSTALLMENT', 101)).toThrow();
    expect(() => rublePaymentRate('OTHER', 'FULL')).toThrow();
  });
  it('publishes per-project scales and limits from the 2026-10-23 PDF', () => {
    expect(RUB_COMMISSION_LEVELS_BY_PROJECT.ZORGE9.map(level => level.rate)).toEqual([5.7, 5.8, 5.9, 6, 6.1, 6.2, 6.3, 6.4, 6.5]);
    expect(RUB_COMMISSION_LEVELS_BY_PROJECT.SILVER_BOR.map(level => level.rate)).toEqual([5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9, 6]);
    const [zorge, silverBor] = currentRubleDisplayPolicies()!;
    expect(zorge).toMatchObject({ project:'ZORGE9', minRate:4.2, maxRate:6.5, sourceSha256:RUB_TERMS_SOURCE_SHA256, sourceUrl:RUB_TERMS_SOURCE_URL });
    expect(silverBor).toMatchObject({ project:'SILVER_BOR', minRate:4.2, maxRate:6 });
    expect(zorge.displayNote).toMatch(/5,5%.*ПВ от 30% — 4,5%, ПВ менее 30% — 4%/);
    expect(silverBor.displayNote).toMatch(/— 5%.*ПВ >50% — 4,5%, ПВ ≤50% — 4%/);
  });
  it('does not identify historical sqm policy as the current rule', () => {
    expect(isRublePolicy({ levels: RUB_COMMISSION_LEVELS_BY_PROJECT.ZORGE9 })).toBe(true);
    expect(isRublePolicy({ levels: [{ minSqm: 0, rate: 5 }] })).toBe(false);
  });
  it('sums both projects, deduplicates parent cards and performs no writes', async () => {
    const findMany = jest.fn().mockResolvedValue([
      { id:'a', amount:100000000, contractType:'DDU', amoDealId:1 },
      { id:'b', amount:100000000, contractType:'DDU', amoParentDealId:1, amoDealId:2 },
      { id:'c', amount:50000000, contractType:'DKP', amoDealId:3 },
    ]);
    expect(await confirmedAgencySalesRub({ deal: { findMany } }, 'agency', new Date('2027-01-31'))).toBe(150000000);
    expect(findMany.mock.calls[0][0].where).toMatchObject({ agencyId: 'agency', project: { in: ['ZORGE9','SILVER_BOR'] }, signedAt: { lte: new Date('2026-12-31T20:59:59.999Z') } });
  });
  it('does not assume agency or incomplete contract values', async () => {
    expect(await confirmedAgencySalesRub({}, undefined)).toBeNull();
    expect(await confirmedAgencySalesRub({ deal: { findMany: async () => [] } }, 'a')).toBeNull();
    expect(await confirmedAgencySalesRub({ deal: { findMany: async () => [{ id:'a', amount:1, contractType:null }] } }, 'a')).toBeNull();
  });
  it('calculates payment base plus bonus without mutating saved deal history', async () => {
    const prisma = {
      broker: { findUnique: jest.fn().mockResolvedValue({ brokerAgencies:[{ agency:{ id:'agency',name:'Agency' } }] }) },
      commissionPolicy: { findFirst: jest.fn().mockResolvedValue({ mode:'PROGRESSIVE', levels:RUB_COMMISSION_LEVELS_BY_PROJECT.ZORGE9 }) },
      deal: { findMany: jest.fn().mockResolvedValue([{ id:'d', amount:150000000, contractType:'DDU' }]), update:jest.fn(), updateMany:jest.fn() },
    };
    const service = new CommissionService(prisma as any);
    const result = await service.calculateCommission({ brokerId:'b', project:'ZORGE9', amount:10000000, paymentMode:'INSTALLMENT', downPaymentPercent:29 });
    expect(result).toMatchObject({ baseRate:4, bonusRate:.3, rate:4.3, commission:430000 });
    expect(await service.calculateCommission({ brokerId:'b', project:'ZORGE9', amount:10000000, paymentMode:'INSTALLMENT', downPaymentPercent:30 }))
      .toMatchObject({ baseRate:4.5, bonusRate:.3, rate:4.8, commission:480000 });
    await expect(service.calculateCommission({ brokerId:'b', project:'OTHER', amount:10000000, paymentMode:'FULL' })).rejects.toThrow('Неизвестный проект');
    expect(prisma.deal.update).not.toHaveBeenCalled();
    expect(prisma.deal.updateMany).not.toHaveBeenCalled();
    await expect(rateForWithPolicy(prisma, 'ZORGE9', 700)).rejects.toThrow('первоначальный взнос');
  });
  it('uses current display terms instead of stale accounting sqm policy and leaves that policy unchanged', async () => {
    const stale = { mode:'PROGRESSIVE', levels:[{ level:'START',minSqm:0,rate:8 }] };
    const prisma = {
      broker: { findUnique:async () => ({ brokerAgencies:[{agency:{id:'a',name:'A'}}] }) },
      commissionPolicy:{ findFirst:async () => stale },
      deal:{findMany:async () => [{ id:'d', amount:150000000, contractType:'DDU' }] },
    };
    const result = await new CommissionService(prisma as any).calculateCommission({ brokerId:'b', project:'SILVER_BOR', amount:10000000, paymentMode:'FULL' });
    expect(result).toMatchObject({ rate:5.3, baseRate:5, bonusRate:.3, isEstimate:true });
    expect(stale.levels[0].rate).toBe(8);
    expect(currentRubleDisplayPolicies()![0]).toMatchObject({ basis:'SALES_RUB_2026', source:'PUBLISHED_COOPERATION_TERMS' });
  });
  it('versioned display rules expire and never pretend an old source was renewed', () => {
    expect(currentRubleDisplayPolicies(new Date('2027-02-01T00:00:00Z'))).toEqual([]);
  });
  it('applies the reached threshold already to the proposed new 2026 contract', async () => {
    const prisma = {
      broker:{findUnique:async () => ({brokerAgencies:[{agency:{id:'a',name:'A'}}]})},
      deal:{findMany:async () => [{id:'d',amount:149000000,contractType:'DDU'}]},
    };
    const result = await new CommissionService(prisma as any).calculateCommission({brokerId:'b',project:'ZORGE9',amount:1000000,paymentMode:'FULL'});
    expect(result).toMatchObject({totalSalesRub:149000000,bonusBasisRub:150000000,includesProposedDeal:true,baseRate:5.5,bonusRate:.3,rate:5.8,commission:58000});
  });
  it('freezes 2026 level in January and does not count the new 2027 contract', async () => {
    jest.setSystemTime(new Date('2027-01-15T12:00:00Z'));
    const prisma = {
      broker:{findUnique:async () => ({brokerAgencies:[{agency:{id:'a',name:'A'}}]})},
      deal:{findMany:async () => [{id:'d',amount:149000000,contractType:'DDU'}]},
    };
    const result = await new CommissionService(prisma as any).calculateCommission({brokerId:'b',project:'SILVER_BOR',amount:1000000,paymentMode:'FULL'});
    expect(result).toMatchObject({totalSalesRub:149000000,bonusBasisRub:149000000,includesProposedDeal:false,bonusRate:.2,rate:5.2,commission:52000});
    expect(result.bonusBasisNote).toMatch(/сохранённый уровень/);
  });
  it('uses Moscow year boundary, not UTC year boundary, for bonus volume', () => {
    expect(prospectiveRubleBonus(149000000,1000000,new Date('2026-12-31T20:59:59.999Z')).bonusRate).toBe(.3);
    expect(prospectiveRubleBonus(149000000,1000000,new Date('2026-12-31T21:00:00Z')).bonusRate).toBe(.2);
  });
});
