'use client';

import { useEffect, useState } from 'react';
import { api, apiGet } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Megaphone, Plus, Trash2, Save, Eye, EyeOff } from 'lucide-react';

interface Promo {
  id: string;
  title: string;
  subtitle: string | null;
  description: string | null;
  tag: string | null;
  imageUrl: string | null;
  ctaText: string | null;
  ctaHref: string | null;
  project: 'ZORGE9' | 'SILVER_BOR' | null;
  sortOrder: number;
  isActive: boolean;
  expiresAt: string | null;
}

export default function AdminPromosPage() {
  const { broker } = useAuth();
  const [promos, setPromos] = useState<Promo[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<Partial<Promo>>({
    title: '', subtitle: '', description: '', tag: '',
    imageUrl: '', ctaText: '', ctaHref: '', project: null,
    sortOrder: 0, isActive: true, expiresAt: null,
  });

  if (broker && broker.role !== 'ADMIN' && broker.role !== 'MANAGER') {
    return <div className="card">Доступ запрещён</div>;
  }
  const isAdmin = broker?.role === 'ADMIN';

  const load = () => {
    setLoading(true);
    apiGet('/admin/cms/promos')
      .then((d: any) => setPromos(Array.isArray(d) ? d : []))
      .catch(() => setPromos([]))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const create = async () => {
    if (!draft.title?.trim()) return setMessage('Заголовок обязателен');
    setCreating(true); setMessage('');
    try {
      await api('/admin/cms/promos', {
        method: 'POST',
        body: JSON.stringify(draft),
      });
      setDraft({ title: '', subtitle: '', description: '', tag: '', imageUrl: '', ctaText: '', ctaHref: '', project: null, sortOrder: 0, isActive: true, expiresAt: null });
      load();
      setMessage('Создано');
      setTimeout(() => setMessage(''), 2000);
    } catch (e: any) { setMessage(e.message || 'Ошибка'); }
    setCreating(false);
  };

  const update = async (id: string, patch: Partial<Promo>) => {
    try {
      await api(`/admin/cms/promos/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      load();
      setMessage('Сохранено');
      setTimeout(() => setMessage(''), 1500);
    } catch (e: any) { setMessage(e.message || 'Ошибка'); }
  };

  const remove = async (id: string) => {
    if (!confirm('Удалить акцию? Это необратимо.')) return;
    try {
      await api(`/admin/cms/promos/${id}`, { method: 'DELETE' });
      load();
    } catch (e: any) { setMessage(e.message || 'Ошибка'); }
  };

  return (
    <div>
      <h1 className="text-3xl font-bold mb-6 flex items-center gap-2">
        <Megaphone className="w-7 h-7 text-accent" /> Слайдер акций (Блок 3)
      </h1>

      {message && <div className="mb-4 p-3 rounded-lg bg-info/20 text-info text-sm">{message}</div>}

      {/* Create new */}
      <div className="card mb-6">
        <h2 className="text-lg font-semibold mb-3 flex items-center gap-2"><Plus className="w-5 h-5" /> Новая акция</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="md:col-span-2">
            <label className="label">Заголовок *</label>
            <input className="input" placeholder="Старт продаж" value={draft.title || ''} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
          </div>
          <div>
            <label className="label">Подзаголовок</label>
            <input className="input" placeholder="Приоритетный проект Зорге 9" value={draft.subtitle || ''} onChange={(e) => setDraft({ ...draft, subtitle: e.target.value })} />
          </div>
          <div>
            <label className="label">Тег (надпись золотым)</label>
            <input className="input" placeholder="СПЕЦИАЛЬНЫЕ УСЛОВИЯ" value={draft.tag || ''} onChange={(e) => setDraft({ ...draft, tag: e.target.value })} />
          </div>
          <div className="md:col-span-2">
            <label className="label">Описание</label>
            <textarea className="input" rows={2} placeholder="Акция «Быстрый выход на сделку»: до 20 марта 2026 — бонус +0,1% к комиссии..." value={draft.description || ''} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          </div>
          <div>
            <label className="label">Текст кнопки</label>
            <input className="input" placeholder="Подробнее" value={draft.ctaText || ''} onChange={(e) => setDraft({ ...draft, ctaText: e.target.value })} />
          </div>
          <div>
            <label className="label">Ссылка кнопки</label>
            <input className="input" placeholder="#projects или https://..." value={draft.ctaHref || ''} onChange={(e) => setDraft({ ...draft, ctaHref: e.target.value })} />
          </div>
          <div>
            <label className="label">Картинка (URL, необязательно)</label>
            <input className="input" placeholder="/files/promos/xxx.jpg или https://..." value={draft.imageUrl || ''} onChange={(e) => setDraft({ ...draft, imageUrl: e.target.value })} />
          </div>
          <div>
            <label className="label">Проект (необязательно)</label>
            <select className="input" value={draft.project || ''} onChange={(e) => setDraft({ ...draft, project: (e.target.value || null) as any })}>
              <option value="">Без привязки</option>
              <option value="ZORGE9">Зорге 9</option>
              <option value="SILVER_BOR">Серебряный Бор</option>
            </select>
          </div>
          <div>
            <label className="label">Действует до (необязательно)</label>
            <input className="input" type="date" value={(draft.expiresAt || '').slice(0, 10)} onChange={(e) => setDraft({ ...draft, expiresAt: e.target.value || null })} />
          </div>
          <div>
            <label className="label">Порядок (меньше = выше)</label>
            <input className="input" type="number" value={draft.sortOrder ?? 0} onChange={(e) => setDraft({ ...draft, sortOrder: Number(e.target.value) || 0 })} />
          </div>
        </div>
        <div className="mt-4">
          <button className="btn btn-primary" onClick={create} disabled={creating || !isAdmin || !draft.title?.trim()}>
            {creating ? 'Создание...' : 'Создать акцию'}
          </button>
          {!isAdmin && <span className="ml-3 text-xs text-text-muted">Только админ может создавать</span>}
        </div>
      </div>

      {/* List */}
      <div className="card">
        <h2 className="text-lg font-semibold mb-3">Все акции ({promos.length})</h2>

        {loading ? (
          <div className="text-text-muted">Загрузка…</div>
        ) : promos.length === 0 ? (
          <div className="text-text-muted text-center py-8">
            <Megaphone className="w-12 h-12 mx-auto mb-3 text-text-muted/50" />
            Акций пока нет. Создай первую через форму выше.
          </div>
        ) : (
          <div className="space-y-3">
            {promos.map((p) => (
              <div key={p.id} className={`border rounded-lg p-4 ${p.isActive ? 'border-border' : 'border-border opacity-50 bg-surface-secondary'}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    {p.tag && <div className="text-[10px] font-bold tracking-widest uppercase text-accent mb-1">{p.tag}</div>}
                    <div className="font-semibold text-base mb-1">{p.title}</div>
                    {p.subtitle && <div className="text-sm text-text-muted mb-1">{p.subtitle}</div>}
                    {p.description && <div className="text-xs text-text-muted line-clamp-2">{p.description}</div>}
                    <div className="flex flex-wrap gap-2 mt-2 text-xs text-text-muted">
                      {p.project && <span className="px-2 py-0.5 bg-surface-secondary rounded">{p.project === 'ZORGE9' ? 'Зорге 9' : 'Серебряный Бор'}</span>}
                      {p.ctaText && <span className="px-2 py-0.5 bg-surface-secondary rounded">CTA: {p.ctaText}</span>}
                      {p.expiresAt && <span className="px-2 py-0.5 bg-warning/20 text-warning rounded">До {new Date(p.expiresAt).toLocaleDateString('ru-RU')}</span>}
                      <span className="px-2 py-0.5 bg-surface-secondary rounded">#{p.sortOrder}</span>
                    </div>
                  </div>
                  <div className="flex gap-1 flex-shrink-0">
                    <button className="btn btn-secondary p-2" title={p.isActive ? 'Скрыть с лендинга' : 'Показать'} onClick={() => update(p.id, { isActive: !p.isActive })}>
                      {p.isActive ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                    </button>
                    <button className="btn btn-secondary text-error p-2" title="Удалить" onClick={() => remove(p.id)} disabled={!isAdmin}>
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
