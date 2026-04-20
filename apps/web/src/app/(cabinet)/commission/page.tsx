'use client';

import { useEffect, useState } from 'react';
import { apiGet, apiPost } from '@/lib/api';
import { TrendingUp } from 'lucide-react';

const levelNames: Record<string, string> = {
  START: 'Старт',
  BASIC: 'Базовый',
  STRONG: 'Продвинутый',
  PREMIUM: 'Премиум',
  ELITE: 'Элит',
  CHAMPION: 'Чемпион',
  LEGEND: 'Легенда',
};

export default function CommissionPage() {
  const [commission, setCommission] = useState<any>(null);
  const [deals, setDeals] = useState<any[]>([]);
  const [calcResult, setCalcResult] = useState<any>(null);
  const [calcForm, setCalcForm] = useState({ amount: '', project: 'ZORGE9', agencyInn: '', isInstallment: false });

  useEffect(() => {
    apiGet('/commission/my').then(setCommission).catch(() => {});
    apiGet('/commission/deals').then(setDeals).catch(() => {});
  }, []);

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
      <h1 className="text-3xl font-bold mb-6">Комиссия</h1>

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
            <h3 className="text-sm text-text-muted mb-2">Заработано</h3>
            <p className="text-2xl font-bold text-accent">
              {Math.round(commission.totalEarned || 0).toLocaleString('ru-RU')} ₽
            </p>
            {commission.quarterlyBonusStreak > 0 && (
              <p className="text-xs text-success mt-2">
                Бонусная серия: {commission.quarterlyBonusStreak} кв.
              </p>
            )}
          </div>

          <div className="card">
            <h3 className="text-sm text-text-muted mb-2">Ставки</h3>
            {commission.rates && Object.entries(commission.rates).map(([project, rate]: any) => (
              <div key={project} className="flex justify-between text-sm py-1">
                <span>{project === 'ZORGE9' ? 'Зорге 9' : 'Серебряный бор'}</span>
                <span className="font-bold text-accent">{rate}%</span>
              </div>
            ))}
          </div>
        </div>
      )}

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
          <h3 className="text-lg font-semibold mb-4">История комиссий</h3>
          {deals.length === 0 ? (
            <p className="text-text-muted">Нет данных</p>
          ) : (
            <div className="space-y-3">
              {deals.map((deal: any) => (
                <div key={deal.id} className="flex items-center justify-between py-2 border-b border-border last:border-0">
                  <div>
                    <div className="font-medium text-sm">{deal.clientName}</div>
                    <div className="text-xs text-text-muted">{deal.project} | {deal.rate}%</div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-bold text-accent">
                      {Math.round(Number(deal.commission)).toLocaleString('ru-RU')} ₽
                    </div>
                    <div className="text-xs text-text-muted">{deal.status}</div>
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
