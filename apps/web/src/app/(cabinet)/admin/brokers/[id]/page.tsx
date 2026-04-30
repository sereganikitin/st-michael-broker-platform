'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, apiGet } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { ArrowLeft, RefreshCw, Save, Shield, Trash2 } from 'lucide-react';

const roleOptions = [
  { value: 'BROKER', label: 'Брокер' },
  { value: 'MANAGER', label: 'Менеджер' },
  { value: 'ADMIN', label: 'Админ' },
];
const statusOptions = [
  { value: 'ACTIVE', label: 'Активен' },
  { value: 'PENDING', label: 'Ожидает' },
  { value: 'BLOCKED', label: 'Заблокирован' },
];

export default function AdminBrokerDetailPage() {
  const { broker: currentUser } = useAuth();
  const params = useParams();
  const router = useRouter();
  const id = params?.id as string;

  const [broker, setBroker] = useState<any>(null);
  const [deals, setDeals] = useState<any[]>([]);
  const [clients, setClients] = useState<any[]>([]);
  const [meetings, setMeetings] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'profile' | 'clients' | 'deals' | 'meetings'>('profile');

  const [form, setForm] = useState({ fullName: '', email: '', phone: '', role: 'BROKER', status: 'ACTIVE' });
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState('');

  if (currentUser && currentUser.role !== 'ADMIN' && currentUser.role !== 'MANAGER') {
    return <div className="card">Доступ запрещён</div>;
  }
  const isAdmin = currentUser?.role === 'ADMIN';

  const load = async () => {
    setLoading(true);
    try {
      const [b, d, c, m] = await Promise.all([
        apiGet(`/admin/brokers/${id}`),
        apiGet(`/admin/brokers/${id}/deals?limit=10`),
        apiGet(`/admin/brokers/${id}/clients?limit=10`),
        apiGet(`/admin/brokers/${id}/meetings?limit=10`),
      ]);
      setBroker(b);
      setForm({
        fullName: b.fullName || '',
        email: b.email || '',
        phone: b.phone || '',
        role: b.role || 'BROKER',
        status: b.status || 'ACTIVE',
      });
      setDeals(d.deals || []);
      setClients(c.clients || []);
      setMeetings(m.meetings || []);
    } catch {}
    setLoading(false);
  };

  useEffect(() => { if (id) load(); }, [id]);

  const handleSave = async () => {
    setSaving(true); setMessage('');
    try {
      await api(`/admin/brokers/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ fullName: form.fullName, email: form.email, phone: form.phone }),
      });
      if (form.role !== broker.role && isAdmin) {
        await api(`/admin/brokers/${id}/role`, { method: 'PATCH', body: JSON.stringify({ role: form.role }) });
      }
      if (form.status !== broker.status && isAdmin) {
        await api(`/admin/brokers/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status: form.status }) });
      }
      setMessage('Сохранено');
      load();
    } catch (e: any) { setMessage(e.message || 'Ошибка сохранения'); }
    setSaving(false);
  };

  const handleDelete = async () => {
    if (!confirm(`Удалить брокера "${broker.fullName}" со всеми его клиентами, сделками и встречами? Это действие необратимо.`)) return;
    setSaving(true); setMessage('');
    try {
      await api(`/admin/brokers/${id}`, { method: 'DELETE' });
      router.push('/admin/brokers');
    } catch (e: any) {
      setMessage(e.message || 'Ошибка удаления');
      setSaving(false);
    }
  };

  const handleSync = async () => {
    setSyncing(true); setMessage('');
    try {
      const r: any = await api(`/admin/brokers/${id}/sync-amo`, { method: 'PATCH' });
      setMessage(`Синхронизация: +${r.dealsCreated || 0} сделок, +${r.clientsCreated || 0} клиентов`);
      load();
    } catch (e: any) { setMessage(e.message || 'Ошибка синхронизации'); }
    setSyncing(false);
  };

  if (loading) return <div className="text-center py-8 text-text-muted">Загрузка...</div>;
  if (!broker) return <div className="card">Брокер не найден</div>;

  return (
    <div>
      <button onClick={() => router.push('/admin/brokers')} className="btn btn-secondary flex items-center gap-2 mb-4">
        <ArrowLeft className="w-4 h-4" /> К списку
      </button>

      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2"><Shield className="w-7 h-7 text-accent" />{broker.fullName}</h1>
          <span className="text-text-muted text-sm">{broker.phone} · amoCRM ID: {broker.amoContactId ? broker.amoContactId.toString() : '—'}</span>
        </div>
        <button onClick={handleSync} disabled={syncing} className="btn btn-secondary flex items-center gap-2">
          <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
          {syncing ? 'Синхронизация...' : 'Синхр. amoCRM'}
        </button>
      </div>

      {message && <div className="mb-4 p-3 rounded-lg bg-info/20 text-info text-sm">{message}</div>}

      <div className="flex gap-2 mb-4 border-b border-border">
        {(['profile', 'clients', 'deals', 'meetings'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition ${tab === t ? 'border-accent text-accent' : 'border-transparent text-text-muted hover:text-text'}`}
          >
            {t === 'profile' ? 'Профиль' : t === 'clients' ? `Клиенты (${broker._count?.clients ?? 0})` : t === 'deals' ? `Сделки (${broker._count?.deals ?? 0})` : `Встречи (${broker._count?.meetings ?? 0})`}
          </button>
        ))}
      </div>

      {tab === 'profile' && (
        <div className="card">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
            <div>
              <label className="label">ФИО</label>
              <input className="input" value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
            </div>
            <div>
              <label className="label">Телефон</label>
              <input className="input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </div>
            <div>
              <label className="label">Email</label>
              <input className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </div>
            <div>
              <label className="label">Роль</label>
              <select className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} disabled={!isAdmin}>
                {roleOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              {!isAdmin && <div className="text-xs text-text-muted mt-1">Только админ может менять роль</div>}
            </div>
            <div>
              <label className="label">Статус</label>
              <select className="input" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} disabled={!isAdmin}>
                {statusOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Этап воронки</label>
              <input className="input bg-surface-secondary" value={broker.funnelStage} readOnly />
            </div>
          </div>

          <div className="text-sm text-text-muted mb-4">
            Зарегистрирован: {new Date(broker.createdAt).toLocaleDateString('ru-RU')}
            {broker.brokerAgencies?.length > 0 && <> · Агентств: {broker.brokerAgencies.length}</>}
          </div>

          <div className="flex gap-2">
            <button className="btn btn-primary flex items-center gap-2" onClick={handleSave} disabled={saving}>
              <Save className="w-4 h-4" /> {saving ? 'Сохранение...' : 'Сохранить'}
            </button>
            {isAdmin && (
              <button className="btn btn-secondary flex items-center gap-2 text-error ml-auto" onClick={handleDelete} disabled={saving} title="Удалить брокера со всеми данными">
                <Trash2 className="w-4 h-4" /> Удалить
              </button>
            )}
          </div>
        </div>
      )}

      {tab === 'clients' && (
        <div className="card">
          {clients.length === 0 ? (
            <div className="text-text-muted text-center py-6">Нет клиентов</div>
          ) : (
            <div className="space-y-2">
              {clients.map((c: any) => (
                <div key={c.id} className="flex justify-between items-center py-2 border-b border-border last:border-0 text-sm">
                  <div>
                    <div className="font-medium">{c.fullName}</div>
                    <div className="text-text-muted text-xs">{c.phone}</div>
                  </div>
                  <div className="text-text-muted text-xs">{c.uniquenessStatus}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'deals' && (
        <div className="card">
          {deals.length === 0 ? (
            <div className="text-text-muted text-center py-6">Нет сделок</div>
          ) : (
            <div className="space-y-2">
              {deals.map((d: any) => (
                <div key={d.id} className="flex justify-between items-center py-2 border-b border-border last:border-0 text-sm">
                  <div>
                    <div className="font-medium">{d.client?.fullName}</div>
                    <div className="text-text-muted text-xs">{d.project} · {d.status}</div>
                  </div>
                  <div className="font-bold text-accent">{Math.round(Number(d.amount)).toLocaleString('ru-RU')} ₽</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'meetings' && (
        <div className="card">
          {meetings.length === 0 ? (
            <div className="text-text-muted text-center py-6">Нет встреч</div>
          ) : (
            <div className="space-y-2">
              {meetings.map((m: any) => (
                <div key={m.id} className="flex justify-between items-center py-2 border-b border-border last:border-0 text-sm">
                  <div>
                    <div className="font-medium">{m.client?.fullName}</div>
                    <div className="text-text-muted text-xs">{m.type} · {new Date(m.date).toLocaleString('ru-RU')}</div>
                  </div>
                  <div className="text-text-muted text-xs">{m.status}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
