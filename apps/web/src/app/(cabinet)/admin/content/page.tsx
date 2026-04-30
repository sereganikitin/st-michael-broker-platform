'use client';

import { useEffect, useState } from 'react';
import { api, apiGet } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { FileText, Save, Plus, Trash2 } from 'lucide-react';

type ContentMap = Record<string, any>;

const BLOCKS: { key: string; label: string }[] = [
  { key: 'hero', label: 'Hero (главный экран)' },
  { key: 'advantages', label: 'Преимущества' },
  { key: 'commission', label: 'Комиссия' },
  { key: 'contact', label: 'Контакты' },
];

export default function AdminContentPage() {
  const { broker } = useAuth();
  const [content, setContent] = useState<ContentMap>({});
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<string>('hero');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  if (broker && broker.role !== 'ADMIN' && broker.role !== 'MANAGER') {
    return <div className="card">Доступ запрещён</div>;
  }
  const isAdmin = broker?.role === 'ADMIN';

  const load = () => {
    setLoading(true);
    apiGet('/admin/cms/content')
      .then((d) => setContent(d || {}))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const saveBlock = async (key: string) => {
    setSaving(true); setMessage('');
    try {
      await api(`/admin/cms/content/${key}`, {
        method: 'PATCH',
        body: JSON.stringify({ value: content[key] }),
      });
      setMessage('Сохранено');
      setTimeout(() => setMessage(''), 2000);
    } catch (e: any) { setMessage(e.message || 'Ошибка'); }
    setSaving(false);
  };

  const updateField = (key: string, path: string, value: any) => {
    const next = { ...content };
    if (!next[key]) next[key] = {};
    const obj = { ...next[key] };
    obj[path] = value;
    next[key] = obj;
    setContent(next);
  };

  const updateArrayItem = (key: string, arrField: string, idx: number, patch: any) => {
    const next = { ...content };
    const arr = [...(next[key]?.[arrField] || [])];
    arr[idx] = { ...arr[idx], ...patch };
    next[key] = { ...next[key], [arrField]: arr };
    setContent(next);
  };

  const addArrayItem = (key: string, arrField: string, item: any) => {
    const next = { ...content };
    const arr = [...(next[key]?.[arrField] || []), item];
    next[key] = { ...next[key], [arrField]: arr };
    setContent(next);
  };

  const removeArrayItem = (key: string, arrField: string, idx: number) => {
    const next = { ...content };
    const arr = [...(next[key]?.[arrField] || [])];
    arr.splice(idx, 1);
    next[key] = { ...next[key], [arrField]: arr };
    setContent(next);
  };

  if (loading) return <div className="text-center py-8 text-text-muted">Загрузка...</div>;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <FileText className="w-7 h-7 text-accent" />Контент лендинга
          </h1>
          <span className="text-text-muted text-sm">Редактирование текстовых блоков</span>
        </div>
      </div>

      {message && <div className="mb-4 p-3 rounded-lg bg-info/20 text-info text-sm">{message}</div>}

      <div className="flex gap-2 mb-4 border-b border-border overflow-x-auto">
        {BLOCKS.map((b) => (
          <button
            key={b.key}
            onClick={() => setTab(b.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition whitespace-nowrap ${
              tab === b.key ? 'border-accent text-accent' : 'border-transparent text-text-muted hover:text-text'
            }`}
          >
            {b.label}
          </button>
        ))}
      </div>

      <div className="card">
        {tab === 'hero' && <HeroEditor content={content.hero || {}} updateField={updateField} updateArrayItem={updateArrayItem} addArrayItem={addArrayItem} removeArrayItem={removeArrayItem} />}
        {tab === 'advantages' && <AdvantagesEditor content={content.advantages || {}} updateField={updateField} updateArrayItem={updateArrayItem} addArrayItem={addArrayItem} removeArrayItem={removeArrayItem} />}
        {tab === 'commission' && <CommissionEditor content={content.commission || {}} updateField={updateField} updateArrayItem={updateArrayItem} addArrayItem={addArrayItem} removeArrayItem={removeArrayItem} />}
        {tab === 'contact' && <ContactEditor content={content.contact || {}} updateField={updateField} />}

        <div className="mt-6 pt-4 border-t border-border flex gap-2">
          <button className="btn btn-primary flex items-center gap-2" onClick={() => saveBlock(tab)} disabled={saving || !isAdmin}>
            <Save className="w-4 h-4" /> {saving ? 'Сохранение...' : 'Сохранить'}
          </button>
          {!isAdmin && <span className="text-xs text-text-muted self-center">Только админ может сохранять</span>}
        </div>
      </div>
    </div>
  );
}

// ── HERO ──────────────────────────────────────────────
function HeroEditor({ content, updateField, updateArrayItem, addArrayItem, removeArrayItem }: any) {
  const stats = content.stats || [];
  return (
    <div className="space-y-4">
      <FieldText label="Тег (надзаголовок)" value={content.tag || ''} onChange={(v) => updateField('hero', 'tag', v)} />
      <FieldText label="Заголовок" value={content.title || ''} onChange={(v) => updateField('hero', 'title', v)} />
      <FieldText label="Акцент в заголовке (часть выделится золотым)" value={content.titleAccent || ''} onChange={(v) => updateField('hero', 'titleAccent', v)} hint="Подстрока из заголовка, например: 8% комиссии" />
      <FieldTextarea label="Описание" value={content.description || ''} onChange={(v) => updateField('hero', 'description', v)} />

      <div>
        <label className="label">Цифры внизу (4 блока)</label>
        <div className="space-y-2">
          {stats.map((s: any, i: number) => (
            <div key={i} className="flex gap-2 items-start">
              <input className="input" placeholder="Число (напр. 5–8%)" value={s.number || ''} onChange={(e) => updateArrayItem('hero', 'stats', i, { number: e.target.value })} />
              <input className="input flex-2" placeholder="Подпись" value={s.label || ''} onChange={(e) => updateArrayItem('hero', 'stats', i, { label: e.target.value })} />
              <button className="btn btn-secondary text-error" onClick={() => removeArrayItem('hero', 'stats', i)}><Trash2 className="w-4 h-4" /></button>
            </div>
          ))}
        </div>
        <button className="btn btn-secondary mt-2 flex items-center gap-2 text-sm" onClick={() => addArrayItem('hero', 'stats', { number: '', label: '' })}>
          <Plus className="w-4 h-4" /> Добавить цифру
        </button>
      </div>
    </div>
  );
}

// ── ADVANTAGES ────────────────────────────────────────
function AdvantagesEditor({ content, updateField, updateArrayItem, addArrayItem, removeArrayItem }: any) {
  const items = content.items || [];
  return (
    <div className="space-y-4">
      <FieldText label="Тег" value={content.tag || ''} onChange={(v) => updateField('advantages', 'tag', v)} />
      <FieldText label="Заголовок" value={content.title || ''} onChange={(v) => updateField('advantages', 'title', v)} />
      <FieldText label="Акцент в заголовке" value={content.titleAccent || ''} onChange={(v) => updateField('advantages', 'titleAccent', v)} />

      <div>
        <label className="label">Карточки преимуществ</label>
        <div className="space-y-3">
          {items.map((it: any, i: number) => (
            <div key={i} className="border border-border rounded p-3">
              <div className="flex justify-between items-start mb-2">
                <span className="text-xs text-text-muted">Карточка #{i + 1}</span>
                <button onClick={() => removeArrayItem('advantages', 'items', i)} className="text-error hover:text-error/80"><Trash2 className="w-4 h-4" /></button>
              </div>
              <input className="input mb-2" placeholder="Заголовок" value={it.title || ''} onChange={(e) => updateArrayItem('advantages', 'items', i, { title: e.target.value })} />
              <textarea className="input" placeholder="Описание" rows={2} value={it.description || ''} onChange={(e) => updateArrayItem('advantages', 'items', i, { description: e.target.value })} />
            </div>
          ))}
        </div>
        <button className="btn btn-secondary mt-2 flex items-center gap-2 text-sm" onClick={() => addArrayItem('advantages', 'items', { title: '', description: '' })}>
          <Plus className="w-4 h-4" /> Добавить карточку
        </button>
      </div>
    </div>
  );
}

// ── COMMISSION ────────────────────────────────────────
function CommissionEditor({ content, updateField, updateArrayItem, addArrayItem, removeArrayItem }: any) {
  const levels = content.levels || [];
  const cards = content.cards || [];
  return (
    <div className="space-y-4">
      <FieldText label="Тег" value={content.tag || ''} onChange={(v) => updateField('commission', 'tag', v)} />
      <FieldText label="Заголовок" value={content.title || ''} onChange={(v) => updateField('commission', 'title', v)} />
      <FieldText label="Акцент в заголовке" value={content.titleAccent || ''} onChange={(v) => updateField('commission', 'titleAccent', v)} />
      <FieldTextarea label="Подзаголовок" value={content.subtitle || ''} onChange={(v) => updateField('commission', 'subtitle', v)} />

      <div>
        <label className="label">Уровни шкалы</label>
        <div className="space-y-2">
          {levels.map((lv: any, i: number) => (
            <div key={i} className="flex gap-2 items-center">
              <input className="input flex-1" placeholder="Название (Start)" value={lv.name || ''} onChange={(e) => updateArrayItem('commission', 'levels', i, { name: e.target.value })} />
              <input className="input flex-1" placeholder="Объём (0-59 м2)" value={lv.range || ''} onChange={(e) => updateArrayItem('commission', 'levels', i, { range: e.target.value })} />
              <input className="input w-24" placeholder="Ставка (5,0%)" value={lv.rate || ''} onChange={(e) => updateArrayItem('commission', 'levels', i, { rate: e.target.value })} />
              <label className="flex items-center gap-1 text-xs whitespace-nowrap">
                <input type="checkbox" checked={!!lv.active} onChange={(e) => updateArrayItem('commission', 'levels', i, { active: e.target.checked })} /> active
              </label>
              <button className="btn btn-secondary text-error" onClick={() => removeArrayItem('commission', 'levels', i)}><Trash2 className="w-4 h-4" /></button>
            </div>
          ))}
        </div>
        <button className="btn btn-secondary mt-2 flex items-center gap-2 text-sm" onClick={() => addArrayItem('commission', 'levels', { name: '', range: '', rate: '', active: false })}>
          <Plus className="w-4 h-4" /> Добавить уровень
        </button>
      </div>

      <div>
        <label className="label">Карточки условий (рядом со шкалой)</label>
        <div className="space-y-3">
          {cards.map((c: any, i: number) => (
            <div key={i} className="border border-border rounded p-3">
              <div className="flex justify-between items-start mb-2">
                <span className="text-xs text-text-muted">Карточка #{i + 1}</span>
                <button onClick={() => removeArrayItem('commission', 'cards', i)} className="text-error hover:text-error/80"><Trash2 className="w-4 h-4" /></button>
              </div>
              <input className="input mb-2" placeholder="Заголовок" value={c.title || ''} onChange={(e) => updateArrayItem('commission', 'cards', i, { title: e.target.value })} />
              <textarea className="input" placeholder="Текст" rows={2} value={c.text || ''} onChange={(e) => updateArrayItem('commission', 'cards', i, { text: e.target.value })} />
            </div>
          ))}
        </div>
        <button className="btn btn-secondary mt-2 flex items-center gap-2 text-sm" onClick={() => addArrayItem('commission', 'cards', { title: '', text: '' })}>
          <Plus className="w-4 h-4" /> Добавить карточку
        </button>
      </div>
    </div>
  );
}

// ── CONTACT ───────────────────────────────────────────
function ContactEditor({ content, updateField }: any) {
  return (
    <div className="space-y-4">
      <FieldText label="Тег" value={content.tag || ''} onChange={(v) => updateField('contact', 'tag', v)} />
      <FieldText label="Заголовок" value={content.title || ''} onChange={(v) => updateField('contact', 'title', v)} />
      <FieldText label="Акцент в заголовке" value={content.titleAccent || ''} onChange={(v) => updateField('contact', 'titleAccent', v)} />
      <FieldTextarea label="Описание" value={content.description || ''} onChange={(v) => updateField('contact', 'description', v)} />
      <FieldText label="Заголовок блока контактов" value={content.blockTitle || ''} onChange={(v) => updateField('contact', 'blockTitle', v)} />
      <FieldText label="Телефон" value={content.phone || ''} onChange={(v) => updateField('contact', 'phone', v)} />
      <FieldText label="Email" value={content.email || ''} onChange={(v) => updateField('contact', 'email', v)} />
      <FieldText label="Telegram-канал (URL)" value={content.telegram || ''} onChange={(v) => updateField('contact', 'telegram', v)} />
    </div>
  );
}

// ── helpers ────────────────────────────────────────────
function FieldText({ label, value, onChange, hint }: { label: string; value: string; onChange: (v: string) => void; hint?: string }) {
  return (
    <div>
      <label className="label">{label}</label>
      <input className="input" value={value} onChange={(e) => onChange(e.target.value)} />
      {hint && <div className="text-xs text-text-muted mt-1">{hint}</div>}
    </div>
  );
}

function FieldTextarea({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="label">{label}</label>
      <textarea className="input" rows={3} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
