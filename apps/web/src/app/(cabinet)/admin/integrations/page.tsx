'use client';

import { useEffect, useState } from 'react';
import { apiGet, apiPatch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Plug, Save, CheckCircle2, AlertCircle } from 'lucide-react';

// 2026-06-04: страница админ-настроек интеграций. Сейчас только Morekit URL,
// но архитектура расширяема — добавляй ключи в SETTINGS_META, в whitelist
// admin.service.INTEGRATION_KEYS и описание ниже.

interface SettingRow {
  key: string;
  dbValue: string | null;
  envValue: string;
  currentValue: string;
  updatedAt: string | null;
  updatedBy: string | null;
}

const SETTINGS_META: Record<string, { label: string; description: string; placeholder: string }> = {
  MOREKIT_WEBHOOK_URL: {
    label: 'Morekit URL',
    description:
      'Endpoint Morekit\'а для прямой отправки фиксаций (без Salesbot в amoCRM). ' +
      'Анна периодически даёт новый URL («копия предыдущего процесса») — поэтому правится из UI без релиза.',
    placeholder: 'https://ep.morekit.io/...',
  },
};

export default function AdminIntegrationsPage() {
  const { broker } = useAuth();
  const [settings, setSettings] = useState<SettingRow[]>([]);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ key: string; ok: boolean; text: string } | null>(null);

  if (broker && broker.role !== 'ADMIN') {
    return <div className="card">Доступ запрещён (только ADMIN)</div>;
  }

  const load = async () => {
    setLoading(true);
    try {
      const data = await apiGet<SettingRow[]>('/admin/integration-settings');
      setSettings(data || []);
      const init: Record<string, string> = {};
      (data || []).forEach((s) => { init[s.key] = s.dbValue ?? ''; });
      setEdits(init);
    } catch (e: any) {
      setMsg({ key: '', ok: false, text: e?.message || 'Не удалось загрузить настройки' });
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const save = async (key: string) => {
    setSavingKey(key);
    setMsg(null);
    try {
      await apiPatch(`/admin/integration-settings/${encodeURIComponent(key)}`, {
        value: edits[key] || '',
      });
      setMsg({ key, ok: true, text: 'Сохранено. Применится при следующей фиксации.' });
      await load();
    } catch (e: any) {
      setMsg({ key, ok: false, text: e?.message || 'Ошибка сохранения' });
    } finally {
      setSavingKey(null);
      setTimeout(() => setMsg((m) => (m?.key === key ? null : m)), 5000);
    }
  };

  return (
    <div>
      <div className="flex items-center gap-2 mb-6">
        <Plug className="w-6 h-6 text-accent" />
        <h1 className="text-2xl md:text-3xl font-bold">Интеграции</h1>
      </div>

      {loading ? (
        <div className="card text-text-muted">Загрузка…</div>
      ) : (
        <div className="space-y-4">
          {settings.map((s) => {
            const meta = SETTINGS_META[s.key] || { label: s.key, description: '', placeholder: '' };
            const dirty = (edits[s.key] || '') !== (s.dbValue ?? '');
            const usingEnvFallback = !s.dbValue && Boolean(s.envValue);
            return (
              <div key={s.key} className="card">
                <div className="flex items-start justify-between gap-4 mb-2">
                  <div>
                    <h2 className="text-lg font-semibold">{meta.label}</h2>
                    <div className="text-xs text-text-muted font-mono mt-0.5">{s.key}</div>
                  </div>
                  <div className="text-xs text-right text-text-muted">
                    {s.updatedAt ? (
                      <>
                        <div>Изменено: {new Date(s.updatedAt).toLocaleString('ru-RU')}</div>
                        {s.updatedBy && <div className="opacity-60">{s.updatedBy.slice(0, 8)}</div>}
                      </>
                    ) : (
                      <div className="opacity-60">не задано в БД</div>
                    )}
                  </div>
                </div>

                {meta.description && (
                  <p className="text-sm text-text-muted mb-3">{meta.description}</p>
                )}

                <div className="space-y-2">
                  <input
                    type="text"
                    className="input font-mono text-sm"
                    placeholder={meta.placeholder}
                    value={edits[s.key] || ''}
                    onChange={(e) => setEdits({ ...edits, [s.key]: e.target.value })}
                  />

                  {usingEnvFallback && (
                    <div className="text-xs text-warning flex items-center gap-1">
                      <AlertCircle className="w-3 h-3" />
                      Сейчас используется значение из env: <span className="font-mono">{s.envValue}</span>. Сохрани здесь, чтобы перезаписать.
                    </div>
                  )}

                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      className="btn btn-primary flex items-center gap-2"
                      onClick={() => save(s.key)}
                      disabled={!dirty || savingKey === s.key}
                    >
                      <Save className="w-4 h-4" />
                      {savingKey === s.key ? 'Сохраняю…' : 'Сохранить'}
                    </button>
                    {msg?.key === s.key && (
                      <div className={`text-sm flex items-center gap-1 ${msg.ok ? 'text-success' : 'text-error'}`}>
                        {msg.ok ? <CheckCircle2 className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
                        {msg.text}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
