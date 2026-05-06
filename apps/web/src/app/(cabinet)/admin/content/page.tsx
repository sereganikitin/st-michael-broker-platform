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
  const cards = content.cards || [];
  const levelsByProject = content.levelsByProject || {};
  const [activeProject, setActiveProject] = useState<'ZORGE9' | 'SILVER_BOR'>('ZORGE9');
  const projectLevels = levelsByProject[activeProject] || [];

  const updateProjectLevel = (idx: number, patch: any) => {
    const next = { ...content };
    const lp = { ...(next.levelsByProject || {}) };
    const arr = [...(lp[activeProject] || [])];
    arr[idx] = { ...arr[idx], ...patch };
    lp[activeProject] = arr;
    updateField('commission', 'levelsByProject', lp);
  };
  const addProjectLevel = () => {
    const next = { ...content };
    const lp = { ...(next.levelsByProject || {}) };
    const arr = [...(lp[activeProject] || []), { name: '', range: '', rate: '', active: false }];
    lp[activeProject] = arr;
    updateField('commission', 'levelsByProject', lp);
  };
  const removeProjectLevel = (idx: number) => {
    const next = { ...content };
    const lp = { ...(next.levelsByProject || {}) };
    const arr = [...(lp[activeProject] || [])];
    arr.splice(idx, 1);
    lp[activeProject] = arr;
    updateField('commission', 'levelsByProject', lp);
  };

  return (
    <div className="space-y-4">
      <FieldText label="Тег" value={content.tag || ''} onChange={(v) => updateField('commission', 'tag', v)} />
      <FieldText label="Заголовок" value={content.title || ''} onChange={(v) => updateField('commission', 'title', v)} />
      <FieldText label="Акцент в заголовке" value={content.titleAccent || ''} onChange={(v) => updateField('commission', 'titleAccent', v)} />
      <FieldTextarea label="Подзаголовок" value={content.subtitle || ''} onChange={(v) => updateField('commission', 'subtitle', v)} />

      <div className="border-t border-border pt-4 mt-2">
        <label className="label flex items-center justify-between">
          <span>Шкалы по проектам</span>
          <span className="text-xs text-text-muted font-normal">переключатель Зорге 9 / Серебряный Бор на лендинге</span>
        </label>
        <div className="flex gap-2 mb-3">
          {(['ZORGE9', 'SILVER_BOR'] as const).map((p) => (
            <button
              key={p}
              onClick={() => setActiveProject(p)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
                activeProject === p ? 'bg-accent text-white' : 'bg-surface-secondary text-text-muted hover:text-text'
              }`}
            >
              {p === 'ZORGE9' ? 'Зорге 9' : 'Серебряный Бор'}
              <span className="ml-2 text-xs opacity-70">({(levelsByProject[p] || []).length} уровней)</span>
            </button>
          ))}
        </div>

        <div className="space-y-2">
          {projectLevels.map((lv: any, i: number) => (
            <div key={i} className="flex gap-2 items-center">
              <input className="input flex-1" placeholder="Название (Start)" value={lv.name || ''} onChange={(e) => updateProjectLevel(i, { name: e.target.value })} />
              <input className="input flex-1" placeholder="Объём (0–59 м²)" value={lv.range || ''} onChange={(e) => updateProjectLevel(i, { range: e.target.value })} />
              <input className="input w-24" placeholder="Ставка (5,0%)" value={lv.rate || ''} onChange={(e) => updateProjectLevel(i, { rate: e.target.value })} />
              <label className="flex items-center gap-1 text-xs whitespace-nowrap">
                <input type="checkbox" checked={!!lv.active} onChange={(e) => updateProjectLevel(i, { active: e.target.checked })} /> active
              </label>
              <button className="btn btn-secondary text-error" onClick={() => removeProjectLevel(i)}><Trash2 className="w-4 h-4" /></button>
            </div>
          ))}
        </div>
        <button className="btn btn-secondary mt-2 flex items-center gap-2 text-sm" onClick={addProjectLevel}>
          <Plus className="w-4 h-4" /> Добавить уровень в {activeProject === 'ZORGE9' ? 'Зорге 9' : 'Серебряный Бор'}
        </button>
        <p className="text-xs text-text-muted mt-2">
          Серебряный Бор по новому ТЗ имеет только 6 уровней (без Legend), максимум — Champion 6,25%.
        </p>
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
  const manager = content.manager || {};
  const updateManager = (field: string, value: string) => {
    updateField('contact', 'manager', { ...manager, [field]: value });
  };
  return (
    <div className="space-y-4">
      <FieldText label="Тег" value={content.tag || ''} onChange={(v) => updateField('contact', 'tag', v)} />
      <FieldText label="Заголовок" value={content.title || ''} onChange={(v) => updateField('contact', 'title', v)} />
      <FieldText label="Акцент в заголовке" value={content.titleAccent || ''} onChange={(v) => updateField('contact', 'titleAccent', v)} />
      <FieldTextarea label="Описание" value={content.description || ''} onChange={(v) => updateField('contact', 'description', v)} />

      <div className="border-t border-border pt-4 mt-2">
        <h4 className="text-sm font-semibold mb-3">Горячая линия</h4>
        <FieldText label="Заголовок блока контактов" value={content.blockTitle || ''} onChange={(v) => updateField('contact', 'blockTitle', v)} />
        <FieldText label="Телефон" value={content.phone || ''} onChange={(v) => updateField('contact', 'phone', v)} />
        <FieldText label="Часы работы (необязательно)" value={content.phoneHours || ''} onChange={(v) => updateField('contact', 'phoneHours', v)} hint="Например: Ежедневно с 9:00 до 21:00" />
        <FieldText label="Email" value={content.email || ''} onChange={(v) => updateField('contact', 'email', v)} />
        <FieldText label="Telegram-канал (URL)" value={content.telegram || ''} onChange={(v) => updateField('contact', 'telegram', v)} />
      </div>

      <div className="border-t border-border pt-4 mt-2">
        <h4 className="text-sm font-semibold mb-3">Персональный менеджер (необязательно)</h4>
        <FieldText label="Имя менеджера" value={manager.name || ''} onChange={(v) => updateManager('name', v)} />
        <FieldText label="Должность" value={manager.role || ''} onChange={(v) => updateManager('role', v)} hint="Например: Руководитель отдела по работе с партнёрами" />
        <FieldText label="Телефон менеджера" value={manager.phone || ''} onChange={(v) => updateManager('phone', v)} />
      </div>
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
