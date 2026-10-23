import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ActiveCommissionPolicy, buildPaymentTermsText, getCommissionRateLabel, getOverallMaxCommissionRate, publishedInstallmentPayoutText, publishedPaymentRatesText, resolveCommissionText } from './commission-display';

// Shapes returned by the API for the 2026-10-23 terms: Zorge 9 5,5% + 0,2–1, КСБ 5% + 0,2–1.
const published: ActiveCommissionPolicy = {
  project:'ZORGE9', mode:'PROGRESSIVE', basis:'SALES_RUB_2026', flatRate:null,
  levels:[{ level:'RUB_0',minSalesRub:0,bonusRate:.2,rate:5.7 }, { level:'RUB_8',minSalesRub:650000000,bonusRate:1,rate:6.5 }],
  installmentEnabled:true, installmentDiscount:.5, subsidizedMortgageEnabled:true, subsidizedMortgageRate:4,
};
const silverBor: ActiveCommissionPolicy = {
  ...published, project:'SILVER_BOR',
  levels:[{ level:'RUB_0',minSalesRub:0,bonusRate:.2,rate:5.2 }, { level:'RUB_8',minSalesRub:650000000,bonusRate:1,rate:6 }],
};
test('published commission range includes low down payment and does not show historical 8%', () => {
  assert.equal(getCommissionRateLabel(published), '4,2–6,5%');
  assert.equal(getCommissionRateLabel(published, { progressive:'max' }), 'до 6,5%');
  assert.equal(getCommissionRateLabel(silverBor), '4,2–6%');
  assert.equal(resolveCommissionText('Комиссия {{commission.ZORGE9.range}}', [published, silverBor]), 'Комиссия 4,2–6,5%');
  assert.equal(resolveCommissionText('Комиссия {{commission.SILVER_BOR.range}}', [published, silverBor]), 'Комиссия 4,2–6%');
  assert.equal(getOverallMaxCommissionRate([published, silverBor]), 6.5);
});
test('payment terms state each project own installment boundary, not a single blanket 0.5% discount', () => {
  const zorge = buildPaymentTermsText(published);
  assert.match(zorge, /5,5%/);
  assert.match(zorge, /ПВ от 30% — 4,5%/);
  assert.match(zorge, /ПВ менее 30% — 4%/);
  assert.match(zorge, /надбавка 0,2–1%/);
  assert.doesNotMatch(zorge, /50%/);
  const ksb = buildPaymentTermsText(silverBor);
  assert.match(ksb, /ипотека — 5%/);
  assert.match(ksb, /ПВ >50% — 4,5%/);
  assert.match(ksb, /ПВ ≤50% — 4%/);
  assert.match(ksb, /надбавка 0,2–1%/);
});
test('cabinet payment-rate card follows the selected project', () => {
  assert.match(publishedPaymentRatesText('ZORGE9'), /несубсидированная ипотека — 5,5%/);
  assert.match(publishedPaymentRatesText('ZORGE9'), /от 30% включительно — 4,5%; менее 30% — 4%/);
  assert.match(publishedPaymentRatesText('SILVER_BOR'), /стандартная ипотека — 5%/);
  assert.match(publishedPaymentRatesText('SILVER_BOR'), /больше 50% — 4,5%; до 50% включительно — 4%/);
});
test('historical policies stay unchanged', () => {
  assert.equal(getCommissionRateLabel({project:'ZORGE9',mode:'FLAT',flatRate:7,levels:null}), '7%');
});
test('payout at exactly 30% is full, separate from rate threshold and actual receipt', () => {
  assert.match(publishedInstallmentPayoutText('ZORGE9'), /30% и более, включая ровно 30%/);
  assert.match(publishedInstallmentPayoutText('ZORGE9'), /полностью и единовременно/);
  assert.match(publishedInstallmentPayoutText('ZORGE9'), /Первый этап — 50% вознаграждения/);
  assert.match(publishedInstallmentPayoutText('ZORGE9'), /оставшиеся 50% после поступления суммарно не менее 30%/);
  assert.doesNotMatch(publishedInstallmentPayoutText('ZORGE9'), /порог 50%/);
  assert.match(publishedInstallmentPayoutText('SILVER_BOR'), /пропорционально фактической оплате/);
  assert.match(publishedInstallmentPayoutText('SILVER_BOR'), /не меняет порог 50% для расчёта ставки/);
  assert.match(publishedInstallmentPayoutText('SILVER_BOR'), /не рассчитывает график/);
});
