'use client';

import { useEffect, useState } from 'react';
import { apiGet } from '@/lib/api';
import { Users, HeartHandshake, Calculator, Calendar } from 'lucide-react';

export default function AnalyticsPage() {
  const [dashboard, setDashboard] = useState<any>(null);
  const [analytics, setAnalytics] = useState<any>(null);
  const [period, setPeriod] = useState<'week' | 'month' | 'all'>('month');

  useEffect(() => {
    apiGet('/analytics/dashboard').then(setDashboard).catch(() => {});
  }, []);

  useEffect(() => {
    const params = new URLSearchParams();
    if (period === 'week') {
      const d = new Date();
      d.setDate(d.getDate() - 7);
      params.set('startDate', d.toISOString());
    } else if (period === 'month') {
      const d = new Date();
      d.setMonth(d.getMonth() - 1);
      params.set('startDate', d.toISOString());
    }
    apiGet(`/analytics/my?${params}`).then(setAnalytics).catch(() => {});
  }, [period]);

  const stats = [
    { name: 'Клиенты', value: dashboard?.clients.total ?? 0, icon: Users, sub: `${dashboard?.clients.activeFixations ?? 0} активных фиксаций` },
    { name: 'Сделки', value: dashboard?.deals.total ?? 0, icon: HeartHandshake, sub: `${dashboard?.deals.pending ?? 0} в работе` },
    { name: 'Комиссия', value: `${(dashboard?.commission.totalEarned ?? 0).toLocaleString('ru-RU')} ₽`, icon: Calculator, sub: `${dashboard?.deals.paid ?? 0} оплаченных` },
    { name: 'Встречи', value: dashboard?.meetings.upcoming ?? 0, icon: Calendar, sub: 'предстоящих' },
  ];

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold">Аналитика</h1>
        <div className="flex gap-2">
          {(['week', 'month', 'all'] as const).map((p) => (
            <button
              key={p}
              className={`btn ${period === p ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setPeriod(p)}
            >
              {p === 'week' ? 'Неделя' : p === 'month' ? 'Месяц' : 'Всё время'}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
        {stats.map((stat) => (
          <div key={stat.name} className="card">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm text-text-muted">{stat.name}</h3>
              <stat.icon className="w-5 h-5 text-accent" />
            </div>
            <p className="text-2xl font-bold text-accent">{stat.value}</p>
            <p className="text-xs text-text-muted mt-1">{stat.sub}</p>
          </div>
        ))}
      </div>

      {analytics && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="card">
            <h3 className="text-lg font-semibold mb-4">Показатели за период</h3>
            <div className="space-y-4">
              {[
                { label: 'Новых клиентов', value: analytics.metrics.clientsCreated },
                { label: 'Проведено встреч', value: analytics.metrics.meetingsHeld },
                { label: 'Закрыто сделок', value: analytics.metrics.dealsClosed },
                { label: 'Совершено звонков', value: analytics.metrics.callsMade },
              ].map((m) => (
                <div key={m.label} className="flex items-center justify-between">
                  <span className="text-sm text-text-muted">{m.label}</span>
                  <span className="text-lg font-bold">{m.value}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <h3 className="text-lg font-semibold mb-4">Конверсия</h3>
            <div className="flex items-center justify-center py-8">
              <div className="text-center">
                <div className="text-5xl font-bold text-accent">{analytics.metrics.conversionRate}%</div>
                <div className="text-sm text-text-muted mt-2">Клиенты → Сделки</div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4 mt-4 pt-4 border-t border-border">
              <div className="text-center">
                <div className="text-xl font-bold">{analytics.metrics.clientsCreated}</div>
                <div className="text-xs text-text-muted">Клиентов</div>
              </div>
              <div className="text-center">
                <div className="text-xl font-bold">{analytics.metrics.dealsClosed}</div>
                <div className="text-xs text-text-muted">Сделок</div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
