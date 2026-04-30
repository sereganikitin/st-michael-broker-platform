'use client';

import { useEffect, useMemo, useState } from 'react';
import { apiGet, apiPost } from '@/lib/api';
import { TrendingUp, Wallet, Award, CreditCard, Building2 } from 'lucide-react';

const levelNames: Record<string, string> = {
  START: 'Старт',
  BASIC: 'Базовый',
  STRONG: 'Продвинутый',
  PREMIUM: 'Премиум',
  ELITE: 'Элит',
  CHAMPION: 'Чемпион',
  LEGEND: 'Легенда',
};

const projectLabels: Record<string, string> = {
  ZORGE9: 'Зорге 9',
  SILVER_BOR: 'Серебряный бор',
};

const statusLabels: Record<string, { label: string; cls: string }> = {
  PENDING: { label: 'В работе', cls: 'bg-warning/20 text-warning' },
  SIGNED: { label: 'Договор подписан', cls: 'bg-info/20 text-info' },
  PAID: { label: 'Клиент оплатил', cls: 'bg-success/20 text-success' },
  COMMISSION_PAID: { label: 'Комиссия выплачена', cls: 'bg-accent/20 text-accent' },
  CANCELLED: { label: 'Отменена', cls: 'bg-error/20 text-error' },
};

// Commission rate tables by project and level
const RATE_TABLE: Record<string, Record<string, number>> = {
  ZORGE9: { START: 5.0, BASIC: 5.5, STRONG: 6.0, PREMIUM: 6.5, ELITE: 7.0, CHAMPION: 7.5, LEGEND: 8.0 },
  SILVER_BOR: { START: 4.5, BASIC: 5.0, STRONG: 5.5, PREMIUM: 6.0, ELITE: 6.5, CHAMPION: 7.0, LEGEND: 7.5 },
};

const LEVEL_ORDER = ['START', 'BASIC', 'STRONG', 'PREMIUM', 'ELITE', 'CHAMPION', 'LEGEND'];

export default function CommissionPage() {
  const [commission, setCommission] = useState<any>(null);
  const [deals, setDeals] = useState<any[]>([]);
  const [selectedProject, setSelectedProject] = useState<'ZORGE9' | 'SILVER_BOR'>('ZORGE9');
  const [calcResult, setCalcResult] = useState<any>(null);
  const [calcForm, setCalcForm] = useState({ amount: '', project: 'ZORGE9', agencyInn: '', isInstallment: false });

  useEffect(() => {
    apiGet('/commission/my').then(setCommission).catch(() => {});
    apiGet('/commission/deals').then(setDeals).catch(() => {});
  }, []);

  const projectDeals = useMemo(
    () => deals.filter((d) => d.project === selectedProject),
    [deals, selectedProject],
  );

  const projectEarned = useMemo(
    () =>
      projectDeals
        .filter((d) => d.status === 'PAID' || d.status === 'COMMISSION_PAID')
        .reduce((sum, d) => sum + Number(d.commission || 0), 0),
    [projectDeals],
  );

  const currentRate = RATE_TABLE[selectedProject][commission?.level || 'START'];

  const handleCalculate = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const result = await apiPost('/commission/calculate', {
        ...calcForm,
        amount: Number(calcForm.amount),
      });
      setCalcResult(result);
    } catch {}
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold">Комиссия</h1>
        <div className="inline-flex bg-surface-secondary rounded-lg p-1">
          {(Object.keys(projectLabels) as Array<'ZORGE9' | 'SILVER_BOR'>).map((p) => (
            <button
              key={p}
              onClick={() => setSelectedProject(p)}
              className={`px-4 py-2 rounded-md text-sm font-medium transition ${
                selectedProject === p ? 'bg-accent text-white' : 'text-text-muted hover:text-text'
              }`}
            >
              {projectLabels[p]}
            </button>
          ))}
        </div>
      </div>

      {commission && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          <div className="card">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm text-text-muted">Текущий уровень</h3>
              <TrendingUp className="w-5 h-5 text-accent" />
            </div>
            <p className="text-2xl font-bold text-accent">
              {levelNames[commission.level] || commission.level}
            </p>
            <p className="text-sm text-text-muted mt-1">
              Ставка {projectLabels[selectedProject]}: <span className="text-accent font-bold">{currentRate}%</span>
            </p>
            {commission.nextLevel && (
              <div className="mt-3">
                <div className="flex justify-between text-xs text-text-muted mb-1">
                  <span>Прогресс до {levelNames[commission.nextLevel]}</span>
                  <span>{commission.progress}%</span>
                </div>
                <div className="w-full bg-surface-secondary rounded-full h-2">
                  <div
                    className="bg-accent rounded-full h-2 transition-all"
                    style={{ width: `${commission.progress}%` }}
                  />
                </div>
                <p className="text-xs text-text-muted mt-1">
                  {commission.totalSqmSold} / {commission.nextLevelSqm} м²
                </p>
              </div>
            )}
          </div>

          <div className="card">
            <h3 className="text-sm text-text-muted mb-2">Заработано по проекту</h3>
            <p className="text-2xl font-bold text-accent">
              {Math.round(projectEarned).toLocaleString('ru-RU')} ₽
            </p>
            <p className="text-xs text-text-muted mt-1">{projectLabels[selectedProject]}</p>
            {commission.quarterlyBonusStreak > 0 && (
              <p className="text-xs text-success mt-2">
                Бонусная серия: {commission.quarterlyBonusStreak} кв.
              </p>
            )}
          </div>

          <div className="card">
            <h3 className="text-sm text-text-muted mb-2">Шкала ставок — {projectLabels[selectedProject]}</h3>
            <div className="space-y-1">
              {LEVEL_ORDER.map((lvl) => (
                <div
                  key={lvl}
                  className={`flex justify-between text-sm py-1 px-2 rounded ${
                    lvl === commission.level ? 'bg-accent/10 text-accent font-bold' : ''
                  }`}
                >
                  <span>{levelNames[lvl]}</span>
                  <span>{RATE_TABLE[selectedProject][lvl]}%</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Условия комиссии (ТЗ §6 — карточки условий) */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
        <div className="card">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-lg bg-success/10 flex items-center justify-center flex-shrink-0">
              <Wallet className="w-5 h-5 text-success" />
            </div>
            <div className="flex-1">
              <div className="text-xs font-bold uppercase tracking-wider text-success mb-1">Условия выплаты</div>
              <p className="text-sm text-text-muted leading-relaxed">
                Выплата в течение 5 рабочих дней с момента оплаты клиентом не менее 50% (Зорге 9) или 30% (Серебряный Бор) от суммы договора.
              </p>
            </div>
          </div>
        </div>
        <div className="card">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-lg bg-accent/10 flex items-center justify-center flex-shrink-0">
              <Award className="w-5 h-5 text-accent" />
            </div>
            <div className="flex-1">
              <div className="text-xs font-bold uppercase tracking-wider text-accent mb-1">Квартальный бонус</div>
              <p className="text-sm text-text-muted leading-relaxed">
                При уровне Strong и выше несколько кварталов подряд: +0,1% — +0,15% — +0,2% — +0,25% (максимум). Обнуляется при отсутствии продаж в квартале.
              </p>
            </div>
          </div>
        </div>
        <div className="card">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-lg bg-info/10 flex items-center justify-center flex-shrink-0">
              <CreditCard className="w-5 h-5 text-info" />
            </div>
            <div className="flex-1">
              <div className="text-xs font-bold uppercase tracking-wider text-info mb-1">Рассрочка и ипотека</div>
              <p className="text-sm text-text-muted leading-relaxed">
                При рассрочке ставка уменьшается на 0,5%. При субсидированной ипотеке — фиксированные 4%.
              </p>
            </div>
          </div>
        </div>
        <div className="card">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-lg bg-warning/10 flex items-center justify-center flex-shrink-0">
              <Building2 className="w-5 h-5 text-warning" />
            </div>
            <div className="flex-1">
              <div className="text-xs font-bold uppercase tracking-wider text-warning mb-1">Коммерческие помещения</div>
              <p className="text-sm text-text-muted leading-relaxed">
                Продажа — 3%. Фитнес — 3%. Отдельные здания — 2%. Аренда ритейл — 100% месячного платежа. Аренда фитнес — 50%.
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card">
          <h3 className="text-lg font-semibold mb-4">Калькулятор комиссии</h3>
          <form onSubmit={handleCalculate} className="space-y-4">
            <div>
              <label className="label">Сумма сделки (₽)</label>
              <input
                type="number"
                className="input"
                placeholder="10000000"
                value={calcForm.amount}
                onChange={(e) => setCalcForm({ ...calcForm, amount: e.target.value })}
                required
              />
            </div>
            <div>
              <label className="label">Проект</label>
              <select
                className="input"
                value={calcForm.project}
                onChange={(e) => setCalcForm({ ...calcForm, project: e.target.value })}
              >
                <option value="ZORGE9">Зорге 9</option>
                <option value="SILVER_BOR">Серебряный бор</option>
              </select>
            </div>
            <div>
              <label className="label">ИНН агентства</label>
              <input
                type="text"
                className="input"
                placeholder="7701234567"
                value={calcForm.agencyInn}
                onChange={(e) => setCalcForm({ ...calcForm, agencyInn: e.target.value.replace(/\D/g, '').slice(0, 10) })}
                maxLength={10}
                required
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={calcForm.isInstallment}
                onChange={(e) => setCalcForm({ ...calcForm, isInstallment: e.target.checked })}
              />
              Рассрочка (-0.5%)
            </label>
            <button type="submit" className="btn btn-primary w-full">Рассчитать</button>
          </form>

          {calcResult && (
            <div className="mt-4 p-4 bg-surface-secondary rounded-lg">
              <div className="flex justify-between text-sm mb-2">
                <span className="text-text-muted">Сумма:</span>
                <span>{Math.round(Number(calcResult.amount)).toLocaleString('ru-RU')} ₽</span>
              </div>
              <div className="flex justify-between text-sm mb-2">
                <span className="text-text-muted">Уровень:</span>
                <span>{levelNames[calcResult.level] || calcResult.level}</span>
              </div>
              <div className="flex justify-between text-sm mb-2">
                <span className="text-text-muted">Ставка:</span>
                <span>{calcResult.rate}%</span>
              </div>
              <div className="flex justify-between text-lg font-bold border-t border-border pt-2 mt-2">
                <span>Комиссия:</span>
                <span className="text-accent">{Math.round(Number(calcResult.commission)).toLocaleString('ru-RU')} ₽</span>
              </div>
            </div>
          )}
        </div>

        <div className="card">
          <h3 className="text-lg font-semibold mb-4">
            История комиссий — {projectLabels[selectedProject]}
          </h3>
          {projectDeals.length === 0 ? (
            <p className="text-text-muted">Нет сделок по этому проекту</p>
          ) : (
            <div className="space-y-3">
              {projectDeals.map((deal: any) => (
                <div key={deal.id} className="flex items-center justify-between py-2 border-b border-border last:border-0">
                  <div>
                    <div className="font-medium text-sm">{deal.clientName}</div>
                    <div className="text-xs text-text-muted">
                      {projectLabels[deal.project] || deal.project} · {deal.rate}%
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-bold text-accent">
                      {Math.round(Number(deal.commission)).toLocaleString('ru-RU')} ₽
                    </div>
                    <span className={`text-xs px-2 py-0.5 rounded inline-block mt-1 ${statusLabels[deal.status]?.cls || 'text-text-muted'}`}>
                      {statusLabels[deal.status]?.label || deal.status}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
