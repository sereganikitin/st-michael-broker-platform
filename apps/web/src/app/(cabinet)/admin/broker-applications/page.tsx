'use client';

// 2026-07-09: заменяет /admin/amo-failed. Единая страница со всеми заявками
// от брокеров (Client + Meeting + Call + OfferAcceptance) — с фильтрами
// по типу заявки, статусу amo-синка, периоду и поиском.
// Доступ: MANAGER + ADMIN.

import { useEffect, useState } from 'react';
import { apiGet, apiPost } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import {
  AlertTriangle, RefreshCw, Search, ChevronLeft, ChevronRight,
  User, HeartHandshake, Phone as PhoneIcon, FileCheck, Building,
  CheckCircle2, XCircle, Clock,
} from 'lucide-react';
import AmoHealthBanner from '@/components/AmoHealthBanner';

type Application = {
  type: 'CLIENT' | 'MEETING' | 'CALL' | 'OFFER';
  id: string;
  personName: string;
  personPhone: string;
  date: string;
  broker: { id: string; fullName: string; phone: string } | null;
  amoStatus: string | null;
  amoLeadId?: string | null;
  amoSyncError?: string | null;
  extra?: any;
};

type Response = {
  items: Application[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  countsByType: { CLIENT: number; MEETING: number; CALL: number; OFFER: number };
  countsByAmoStatus: { SYNCED: number; FAILED: number; PENDING: number };
};

const typeLabels: Record<string, { label: string; Icon: any; color: string }> = {
  CLIENT: { label: 'Фиксация', Icon: User, color: 'text-accent' },
  MEETING: { label: 'Встреча', Icon: HeartHandshake, color: 'text-success' },
  CALL: { label: 'Звонок', Icon: PhoneIcon, color: 'text-info' },
  OFFER: { label: 'Акцепт', Icon: FileCheck, color: 'text-warning' },
};

const fmtDate = (s: string | null | undefined) =>
  s ? new Date(s).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : '—';

const formatPhone = (phone: string | null | undefined): string => {
  if (!phone) return '—';
  let d = phone.replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('8')) d = '7' + d.slice(1);
  if (d.length !== 11) return phone;
  return `+7 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7, 9)}-${d.slice(9, 11)}`;
};

export default function BrokerApplicationsPage() {
  const { broker } = useAuth();
  const [data, setData] = useState<Response | null>(null);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const [page, setPage] = useState(1);
  const [typeFilter, setTypeFilter] = useState<'ALL' | 'CLIENT' | 'MEETING' | 'CALL' | 'OFFER'>('ALL');
  const [amoStatusFilter, setAmoStatusFilter] = useState<'ALL' | 'SYNCED' | 'FAILED' | 'PENDING'>('ALL');
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');

  if (broker && broker.role !== 'ADMIN' && broker.role !== 'MANAGER') {
    return <div className="card">Доступ запрещён</div>;
  }

  const load = () => {
    setLoading(true);
    const params = new URLSearchParams({
      page: String(page),
      limit: '50',
      type: typeFilter,
      amoStatus: amoStatusFilter,
    });
    if (search) params.set('search', search);
    apiGet<Response>(`/admin/broker-applications?${params}`)
      .then((d) => setData(d))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  };

  useEffect(load, [page, typeFilter, amoStatusFilter, search]);

  const handleRetry = async (clientId: string) => {
    setRetrying(clientId);
    setMsg('');
    try {
      await apiPost(`/admin/clients/${clientId}/retry-amo-sync`, {});
      setMsg('Повторная отправка запущена');
      setTimeout(() => setMsg(''), 3000);
      load();
    } catch (e: any) {
      setMsg(e?.message || 'Ошибка');
    }
    setRetrying(null);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold flex items-center gap-2">
            <AlertTriangle className="w-7 h-7 text-accent" /> Все заявки от брокеров
          </h1>
          <div className="text-text-muted text-sm mt-1">
            Фиксации клиентов, встречи, звонки и акцепты договоров — по всем брокерам.
          </div>
        </div>
      </div>

      <AmoHealthBanner />

      {msg && (
        <div className="mb-4 p-3 rounded-lg bg-info/20 text-info text-sm">{msg}</div>
      )}

      {/* KPI-бар */}
      {data && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          {(['CLIENT', 'MEETING', 'CALL', 'OFFER'] as const).map((t) => {
            const meta = typeLabels[t];
            const count = data.countsByType[t] || 0;
            return (
              <button
                key={t}
                onClick={() => { setTypeFilter(t); setPage(1); }}
                className={`card text-left transition ${typeFilter === t ? 'ring-2 ring-accent' : ''}`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <meta.Icon className={`w-4 h-4 ${meta.color}`} />
                  <span className="text-xs text-text-muted">{meta.label}</span>
                </div>
                <div className="text-2xl font-bold">{count}</div>
              </button>
            );
          })}
        </div>
      )}

      {/* Фильтры */}
      <div className="card mb-4">
        <div className="flex flex-col md:flex-row gap-3">
          <form
            onSubmit={(e) => { e.preventDefault(); setSearch(searchInput); setPage(1); }}
            className="flex-1 min-w-0 relative"
          >
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
            <input
              className="input pl-10"
              placeholder="Поиск по ФИО или телефону..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
          </form>
          <select
            className="input w-auto"
            value={typeFilter}
            onChange={(e) => { setTypeFilter(e.target.value as any); setPage(1); }}
          >
            <option value="ALL">Все типы</option>
            <option value="CLIENT">Фиксации</option>
            <option value="MEETING">Встречи</option>
            <option value="CALL">Звонки</option>
            <option value="OFFER">Акцепты</option>
          </select>
          <select
            className="input w-auto"
            value={amoStatusFilter}
            onChange={(e) => { setAmoStatusFilter(e.target.value as any); setPage(1); }}
          >
            <option value="ALL">Все статусы amo</option>
            <option value="SYNCED">Синхронизировано</option>
            <option value="FAILED">Ошибка синка</option>
            <option value="PENDING">В очереди</option>
          </select>
        </div>
        {data && amoStatusFilter === 'ALL' && (
          <div className="flex gap-4 mt-3 text-xs text-text-muted">
            <span className="flex items-center gap-1">
              <CheckCircle2 className="w-3 h-3 text-success" />
              Синхронизировано: <b className="text-success">{data.countsByAmoStatus.SYNCED}</b>
            </span>
            <span className="flex items-center gap-1">
              <XCircle className="w-3 h-3 text-error" />
              Ошибок: <b className="text-error">{data.countsByAmoStatus.FAILED}</b>
            </span>
            <span className="flex items-center gap-1">
              <Clock className="w-3 h-3 text-warning" />
              В очереди: <b className="text-warning">{data.countsByAmoStatus.PENDING}</b>
            </span>
          </div>
        )}
      </div>

      {/* Таблица */}
      <div className="card">
        {loading ? (
          <div className="text-center py-8 text-text-muted">Загрузка...</div>
        ) : !data || data.items.length === 0 ? (
          <div className="text-center py-8 text-text-muted">
            Заявок нет по выбранным фильтрам
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[900px]">
                <thead>
                  <tr className="text-text-muted text-left border-b border-border">
                    <th className="pb-3 font-medium">Тип</th>
                    <th className="pb-3 font-medium">ФИО</th>
                    <th className="pb-3 font-medium">Телефон</th>
                    <th className="pb-3 font-medium">Дата</th>
                    <th className="pb-3 font-medium">Брокер</th>
                    <th className="pb-3 font-medium">Статус amo</th>
                    <th className="pb-3 font-medium text-right">Действия</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((item) => {
                    const meta = typeLabels[item.type];
                    return (
                      <tr key={`${item.type}-${item.id}`} className="border-b border-border last:border-0 hover:bg-surface-secondary">
                        <td className="py-3">
                          <span className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded ${meta.color} bg-current/10`}>
                            <meta.Icon className="w-3 h-3" />
                            {meta.label}
                          </span>
                        </td>
                        <td className="py-3">
                          <div className="font-medium">{item.personName}</div>
                          {item.extra?.project && (
                            <div className="text-xs text-text-muted">
                              {item.extra.project === 'ZORGE9' ? 'Зорге 9' : 'Серебряный бор'}
                            </div>
                          )}
                        </td>
                        <td className="py-3 text-text-muted">{formatPhone(item.personPhone)}</td>
                        <td className="py-3 text-text-muted">{fmtDate(item.date)}</td>
                        <td className="py-3">
                          {item.broker ? (
                            <>
                              <div className="text-sm">{item.broker.fullName}</div>
                              <div className="text-xs text-text-muted">{formatPhone(item.broker.phone)}</div>
                            </>
                          ) : (
                            <span className="text-text-muted">—</span>
                          )}
                        </td>
                        <td className="py-3">
                          {item.amoStatus === 'SYNCED' && (
                            <span className="text-xs px-2 py-1 rounded bg-success/20 text-success inline-flex items-center gap-1">
                              <CheckCircle2 className="w-3 h-3" /> Синк
                            </span>
                          )}
                          {item.amoStatus === 'FAILED' && (
                            <div>
                              <span className="text-xs px-2 py-1 rounded bg-error/20 text-error inline-flex items-center gap-1">
                                <XCircle className="w-3 h-3" /> Ошибка
                              </span>
                              {item.amoSyncError && (
                                <div className="text-xs text-error mt-1 max-w-xs truncate" title={item.amoSyncError}>
                                  {item.amoSyncError}
                                </div>
                              )}
                            </div>
                          )}
                          {item.amoStatus === 'PENDING' && (
                            <span className="text-xs px-2 py-1 rounded bg-warning/20 text-warning inline-flex items-center gap-1">
                              <Clock className="w-3 h-3" /> Очередь
                            </span>
                          )}
                          {item.amoStatus === null && (
                            <span className="text-xs text-text-muted">—</span>
                          )}
                        </td>
                        <td className="py-3 text-right">
                          {item.type === 'CLIENT' && item.amoStatus === 'FAILED' && (
                            <button
                              className="btn btn-secondary text-xs flex items-center gap-1 ml-auto"
                              onClick={() => handleRetry(item.id)}
                              disabled={retrying === item.id}
                            >
                              <RefreshCw className={`w-3 h-3 ${retrying === item.id ? 'animate-spin' : ''}`} />
                              Повторить
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {data.totalPages > 1 && (
              <div className="flex items-center justify-between mt-4 pt-4 border-t border-border">
                <span className="text-sm text-text-muted">
                  Стр. {page} из {data.totalPages} · всего {data.total}
                </span>
                <div className="flex gap-2">
                  <button
                    className="btn btn-secondary"
                    onClick={() => setPage(Math.max(1, page - 1))}
                    disabled={page === 1}
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <button
                    className="btn btn-secondary"
                    onClick={() => setPage(Math.min(data.totalPages, page + 1))}
                    disabled={page === data.totalPages}
                  >
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
