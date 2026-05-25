'use client';

// 2026-05-25: заявки, не переданные в amoCRM.
// Менеджер видит список, причину, попыток. Может нажать «Повторить».

import { useEffect, useState } from 'react';
import { apiGet, apiPost } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { AlertTriangle, RefreshCw, Phone, User, Building, Calendar } from 'lucide-react';
import AmoHealthBanner from '@/components/AmoHealthBanner';

type FailedClient = {
  id: string;
  fullName: string;
  phone: string;
  project: string;
  broker: { id: string; fullName: string; phone: string } | null;
  agency: { id: string; name: string; inn: string } | null;
  amoSyncError: string | null;
  amoSyncAttempts: number;
  amoSyncLastAttemptAt: string | null;
  createdAt: string;
};

const fmt = (s: string | null | undefined) =>
  s ? new Date(s).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : '—';

export default function AmoFailedPage() {
  const { broker } = useAuth();
  const [items, setItems] = useState<FailedClient[]>([]);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [msg, setMsg] = useState('');

  if (broker && broker.role !== 'ADMIN' && broker.role !== 'MANAGER') {
    return <div className="card">Доступ запрещён</div>;
  }

  const load = () => {
    setLoading(true);
    apiGet<FailedClient[]>('/admin/amo-failed-clients')
      .then((d) => setItems(Array.isArray(d) ? d : []))
      .catch((e) => setMsg(e.message || 'Ошибка'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const retry = async (id: string) => {
    setRetrying(id);
    setMsg('');
    try {
      const res: any = await apiPost(`/admin/clients/${id}/retry-amo-sync`, {});
      setMsg(res?.ok ? 'Передано в amoCRM' : `Не удалось: ${res?.error || 'ошибка'}`);
      load();
      setTimeout(() => setMsg(''), 4000);
    } catch (e: any) {
      setMsg(e.message || 'Ошибка');
    } finally {
      setRetrying(null);
    }
  };

  return (
    <div>
      <h1 className="text-2xl md:text-3xl font-bold mb-2 flex items-center gap-2">
        <AlertTriangle className="w-7 h-7 text-error" /> Заявки без amoCRM
      </h1>
      <p className="text-sm text-text-muted mb-4">
        Клиенты, заявки на фиксацию которых сохранились в кабинете, но не передались в amoCRM.
        Нажмите «Повторить», когда amo восстановится — либо передайте в amo вручную.
      </p>

      <AmoHealthBanner />

      {msg && <div className="mb-4 p-3 bg-info/20 text-info rounded text-sm">{msg}</div>}
      {loading && <div className="card">Загрузка…</div>}
      {!loading && items.length === 0 && <div className="card text-text-muted">Очередь пуста — всё в amo.</div>}

      <div className="space-y-3">
        {items.map((c) => (
          <div key={c.id} className="card border-l-4 border-error">
            <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-3">
              <div className="flex-1">
                <div className="font-semibold flex items-center gap-2">
                  <User className="w-4 h-4 text-accent" /> {c.fullName}
                </div>
                <div className="text-sm text-text-muted flex flex-wrap items-center gap-x-3 gap-y-1 mt-1">
                  <span className="flex items-center gap-1"><Phone className="w-4 h-4" /> {c.phone}</span>
                  <span>{c.project}</span>
                  {c.agency && <span className="flex items-center gap-1"><Building className="w-4 h-4" /> {c.agency.name} ({c.agency.inn})</span>}
                  <span className="flex items-center gap-1"><Calendar className="w-4 h-4" /> создано {fmt(c.createdAt)}</span>
                </div>
                {c.broker && (
                  <div className="text-sm mt-1">Брокер: <b>{c.broker.fullName}</b> <span className="text-text-muted">{c.broker.phone}</span></div>
                )}
                {c.amoSyncError && (
                  <div className="text-xs text-error mt-2 break-all"><code>{c.amoSyncError}</code></div>
                )}
                <div className="text-xs text-text-muted mt-1">
                  Попыток: {c.amoSyncAttempts}, последняя: {fmt(c.amoSyncLastAttemptAt)}
                </div>
              </div>
              <button
                className="btn btn-primary inline-flex items-center gap-2 self-start"
                disabled={retrying === c.id}
                onClick={() => retry(c.id)}
              >
                <RefreshCw className={`w-4 h-4 ${retrying === c.id ? 'animate-spin' : ''}`} />
                Повторить
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
