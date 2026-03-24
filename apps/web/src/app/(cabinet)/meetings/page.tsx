'use client';

import { useEffect, useState } from 'react';
import { apiGet, apiPost } from '@/lib/api';
import { Calendar, ChevronLeft, ChevronRight } from 'lucide-react';

const statusLabels: Record<string, { label: string; cls: string }> = {
  PENDING: { label: 'Ожидает', cls: 'bg-warning/20 text-warning' },
  CONFIRMED: { label: 'Подтверждена', cls: 'bg-info/20 text-info' },
  COMPLETED: { label: 'Завершена', cls: 'bg-success/20 text-success' },
  CANCELLED: { label: 'Отменена', cls: 'bg-error/20 text-error' },
};

const typeLabels: Record<string, string> = {
  OFFICE_VISIT: 'Офис',
  ONLINE: 'Онлайн',
  BROKER_TOUR: 'Брокер-тур',
};

export default function MeetingsPage() {
  const [meetings, setMeetings] = useState<any[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ clientId: '', type: 'OFFICE_VISIT', date: '', comment: '' });
  const [formError, setFormError] = useState('');

  const fetchMeetings = () => {
    setLoading(true);
    apiGet(`/meetings?page=${page}&limit=15`)
      .then((data) => {
        setMeetings(data.meetings || []);
        setTotal(data.total || 0);
        setTotalPages(data.totalPages || 1);
      })
      .catch(() => setMeetings([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchMeetings(); }, [page]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');
    try {
      await apiPost('/meetings', {
        ...form,
        date: new Date(form.date).toISOString(),
      });
      setShowForm(false);
      setForm({ clientId: '', type: 'OFFICE_VISIT', date: '', comment: '' });
      fetchMeetings();
    } catch (err: any) {
      setFormError(err.message || 'Ошибка при создании встречи');
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold">Встречи</h1>
        <div className="flex items-center gap-3">
          <span className="text-text-muted text-sm">Всего: {total}</span>
          <button className="btn btn-primary" onClick={() => setShowForm(!showForm)}>
            {showForm ? 'Закрыть' : 'Запланировать'}
          </button>
        </div>
      </div>

      {showForm && (
        <div className="card mb-6">
          <h3 className="font-semibold mb-4">Новая встреча</h3>
          {formError && <div className="mb-3 p-3 bg-error/20 text-error rounded-lg text-sm">{formError}</div>}
          <form onSubmit={handleCreate} className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="label">ID клиента</label>
              <input className="input" value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })} required placeholder="UUID клиента" />
            </div>
            <div>
              <label className="label">Тип встречи</label>
              <select className="input" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                <option value="OFFICE_VISIT">Визит в офис</option>
                <option value="ONLINE">Онлайн</option>
                <option value="BROKER_TOUR">Брокер-тур</option>
              </select>
            </div>
            <div>
              <label className="label">Дата и время</label>
              <input type="datetime-local" className="input" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} required />
            </div>
            <div>
              <label className="label">Комментарий</label>
              <input className="input" value={form.comment} onChange={(e) => setForm({ ...form, comment: e.target.value })} placeholder="Необязательно" />
            </div>
            <div className="md:col-span-2">
              <button type="submit" className="btn btn-primary">Создать встречу</button>
            </div>
          </form>
        </div>
      )}

      <div className="card">
        {loading ? (
          <div className="text-center py-8 text-text-muted">Загрузка...</div>
        ) : meetings.length === 0 ? (
          <div className="text-center py-8 text-text-muted">
            <Calendar className="w-12 h-12 mx-auto mb-3 text-text-muted/50" />
            Встречи не найдены
          </div>
        ) : (
          <>
            <div className="space-y-3">
              {meetings.map((m: any) => (
                <div key={m.id} className="flex items-center justify-between py-3 border-b border-border last:border-0">
                  <div className="flex items-center gap-4">
                    <div className="w-12 h-12 bg-surface-secondary rounded-lg flex flex-col items-center justify-center text-xs">
                      <span className="font-bold">{new Date(m.date).getDate()}</span>
                      <span className="text-text-muted">{new Date(m.date).toLocaleDateString('ru-RU', { month: 'short' })}</span>
                    </div>
                    <div>
                      <div className="font-medium text-sm">{m.client?.fullName}</div>
                      <div className="text-xs text-text-muted">
                        {typeLabels[m.type] || m.type} | {new Date(m.date).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
                      </div>
                    </div>
                  </div>
                  <span className={`text-xs px-2 py-1 rounded ${statusLabels[m.status]?.cls || ''}`}>
                    {statusLabels[m.status]?.label || m.status}
                  </span>
                </div>
              ))}
            </div>

            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-4 pt-4 border-t border-border">
                <span className="text-sm text-text-muted">Стр. {page} из {totalPages}</span>
                <div className="flex gap-2">
                  <button className="btn btn-secondary" onClick={() => setPage(Math.max(1, page - 1))} disabled={page === 1}>
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <button className="btn btn-secondary" onClick={() => setPage(Math.min(totalPages, page + 1))} disabled={page === totalPages}>
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
