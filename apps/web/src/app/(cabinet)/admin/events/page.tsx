'use client';

import { useEffect, useState } from 'react';
import { api, apiGet } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Calendar, Plus, Trash2, Save } from 'lucide-react';

type EventItem = {
  id: string;
  date: string;
  title: string;
  location: string | null;
  isOnline: boolean;
  description: string | null;
  sortOrder: number;
  isActive: boolean;
};

export default function AdminEventsPage() {
  const { broker } = useAuth();
  const [events, setEvents] = useState<EventItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ date: '', title: '', location: '', isOnline: false, description: '' });

  if (broker && broker.role !== 'ADMIN' && broker.role !== 'MANAGER') {
    return <div className="card">Доступ запрещён</div>;
  }
  const isAdmin = broker?.role === 'ADMIN';

  const load = () => {
    setLoading(true);
    apiGet('/admin/cms/events?all=1')
      .then((d) => setEvents(d || []))
      .catch(() => setEvents([]))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const handleCreate = async () => {
    if (!draft.date || !draft.title) return;
    setCreating(true); setMessage('');
    try {
      await api('/admin/cms/events', { method: 'POST', body: JSON.stringify(draft) });
      setDraft({ date: '', title: '', location: '', isOnline: false, description: '' });
      load();
    } catch (e: any) { setMessage(e.message || 'Ошибка'); }
    setCreating(false);
  };

  const handleSave = async (ev: EventItem) => {
    setMessage('');
    try {
      await api(`/admin/cms/events/${ev.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          date: ev.date,
          title: ev.title,
          location: ev.location,
          isOnline: ev.isOnline,
          description: ev.description,
          isActive: ev.isActive,
        }),
      });
      setMessage('Сохранено');
      setTimeout(() => setMessage(''), 1500);
    } catch (e: any) { setMessage(e.message || 'Ошибка'); }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Удалить событие?')) return;
    try {
      await api(`/admin/cms/events/${id}`, { method: 'DELETE' });
      load();
    } catch (e: any) { setMessage(e.message || 'Ошибка удаления'); }
  };

  const updateLocal = (idx: number, patch: Partial<EventItem>) => {
    const next = [...events];
    next[idx] = { ...next[idx], ...patch };
    setEvents(next);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <Calendar className="w-7 h-7 text-accent" />События лендинга
          </h1>
          <span className="text-text-muted text-sm">Брокер-туры, вебинары, обучение</span>
        </div>
      </div>

      {message && <div className="mb-4 p-3 rounded-lg bg-info/20 text-info text-sm">{message}</div>}

      {isAdmin && (
        <div className="card mb-6">
          <h2 className="text-lg font-semibold mb-3">Добавить событие</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
            <div>
              <label className="label">Дата и время</label>
              <input type="datetime-local" className="input" value={draft.date} onChange={(e) => setDraft({ ...draft, date: e.target.value })} />
            </div>
            <div>
              <label className="label">Заголовок</label>
              <input className="input" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
            </div>
            <div>
              <label className="label">Локация (или пусто, если онлайн)</label>
              <input className="input" value={draft.location} onChange={(e) => setDraft({ ...draft, location: e.target.value })} />
            </div>
            <div className="flex items-end gap-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={draft.isOnline} onChange={(e) => setDraft({ ...draft, isOnline: e.target.checked })} />
                Онлайн
              </label>
            </div>
          </div>
          <div className="mb-3">
            <label className="label">Описание (необязательно)</label>
            <textarea className="input" rows={2} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          </div>
          <button className="btn btn-primary flex items-center gap-2" onClick={handleCreate} disabled={creating || !draft.date || !draft.title}>
            <Plus className="w-4 h-4" /> {creating ? 'Создание...' : 'Создать'}
          </button>
        </div>
      )}

      <div className="card">
        <h2 className="text-lg font-semibold mb-3">Все события ({events.length})</h2>
        {loading ? (
          <div className="text-center py-8 text-text-muted">Загрузка...</div>
        ) : events.length === 0 ? (
          <div className="text-text-muted text-center py-6">Нет событий</div>
        ) : (
          <div className="space-y-2">
            {events.map((ev, idx) => (
              <div key={ev.id} className="border border-border rounded p-3">
                <div className="grid grid-cols-1 md:grid-cols-12 gap-2 items-start">
                  <input type="datetime-local" className="input md:col-span-3" value={ev.date.slice(0, 16)} onChange={(e) => updateLocal(idx, { date: e.target.value })} disabled={!isAdmin} />
                  <input className="input md:col-span-3" value={ev.title} onChange={(e) => updateLocal(idx, { title: e.target.value })} disabled={!isAdmin} />
                  <input className="input md:col-span-2" placeholder="Локация" value={ev.location || ''} onChange={(e) => updateLocal(idx, { location: e.target.value })} disabled={!isAdmin} />
                  <label className="flex items-center gap-1 text-xs md:col-span-1">
                    <input type="checkbox" checked={ev.isOnline} onChange={(e) => updateLocal(idx, { isOnline: e.target.checked })} disabled={!isAdmin} /> Онлайн
                  </label>
                  <label className="flex items-center gap-1 text-xs md:col-span-1">
                    <input type="checkbox" checked={ev.isActive} onChange={(e) => updateLocal(idx, { isActive: e.target.checked })} disabled={!isAdmin} /> Активно
                  </label>
                  <div className="md:col-span-2 flex gap-1 justify-end">
                    {isAdmin && (
                      <>
                        <button className="btn btn-primary text-sm" onClick={() => handleSave(ev)}><Save className="w-4 h-4" /></button>
                        <button className="btn btn-secondary text-error text-sm" onClick={() => handleDelete(ev.id)}><Trash2 className="w-4 h-4" /></button>
                      </>
                    )}
                  </div>
                </div>
                <textarea className="input mt-2 text-sm" rows={1} placeholder="Описание" value={ev.description || ''} onChange={(e) => updateLocal(idx, { description: e.target.value })} disabled={!isAdmin} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
