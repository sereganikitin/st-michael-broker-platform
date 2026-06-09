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
  isSecret?: boolean;
}

const SETTINGS_META: Record<string, { label: string; description: string; placeholder: string }> = {
  MOREKIT_WEBHOOK_URL: {
    label: 'Morekit URL',
    description:
      'Endpoint Morekit\'а для прямой отправки фиксаций (без Salesbot в amoCRM). ' +
      'Анна периодически даёт новый URL («копия предыдущего процесса») — поэтому правится из UI без релиза.',
    placeholder: 'https://ep.morekit.io/...',
  },
  AMO_ACCESS_TOKEN: {
    label: 'amoCRM access token',
    description:
      'Долгоживущий токен для запросов в amoCRM API. JWT-строка из настроек интеграции amoCRM. ' +
      'При 401 адаптер сам пытается обновить через refresh_token — но если refresh нет, надо ввести access вручную.',
    placeholder: 'eyJ0eXAiOiJKV1Qi...',
  },
  AMO_REFRESH_TOKEN: {
    label: 'amoCRM refresh token',
    description:
      'Refresh-токен для авто-обновления access_token. Получается при первичной OAuth-авторизации. ' +
      'Если задан + есть AMO_CLIENT_ID/SECRET в env, адаптер сам обновит access при 401 без участия человека.',
    placeholder: 'def502...',
  },
  MANGO_API_KEY: {
    label: 'Mango VPBX — уникальный код АТС',
    description:
      '«Уникальный код вашей АТС» из ЛК Mango (vpbx_api_key). Используется как идентификатор приложения и часть HMAC-подписи каждого запроса.',
    placeholder: 'y918tc9kgaza...',
  },
  MANGO_API_SALT: {
    label: 'Mango VPBX — ключ для подписи',
    description:
      '«Ключ для создания подписи» из ЛК Mango (vpbx_api_salt). HMAC-SHA256 от (api_key + json + salt) идёт в параметр sign.',
    placeholder: 'lor605qgarrx...',
  },
  MANGO_API_URL: {
    label: 'Mango VPBX — API URL',
    description:
      'Базовый URL VPBX API. Для обычного аккаунта — https://app.mango-office.ru/vpbx. Если аккаунт Контакт-центр — URL другой.',
    placeholder: 'https://app.mango-office.ru/vpbx',
  },
  GSHEETS_BROKERS_URL: {
    label: 'Google Sheets — URL CSV-экспорта базы брокеров',
    description:
      'Публичная Google Sheet (расшарена «по ссылке: любой может смотреть») с базой брокеров. ' +
      'Формат URL: https://docs.google.com/spreadsheets/d/<SHEET_ID>/export?format=csv&gid=<GID>. ' +
      'Каждые 30 минут scheduler скачивает и upsert\'ит брокеров по телефону. Колонки: Имя | Телефон брокера | Кол-во заявок | Встречи | Сделки | ЗВОНОК | Результат звонка | Обзвон по Зорге | Комментарий.',
    placeholder: 'https://docs.google.com/spreadsheets/d/.../export?format=csv&gid=0',
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
      // Для секретов в edits НЕ кладём dbValue (это маска вида «…abc123 (1024 симв.)»).
      // Иначе сохранение перетёрло бы реальный токен этой маской.
      (data || []).forEach((s) => { init[s.key] = s.isSecret ? '' : (s.dbValue ?? ''); });
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
            const editValue = edits[s.key] || '';
            // Для секрета: dirty если пользователь ввёл что-то непустое (любая новая
            // строка → перезапишет токен). Для обычных — dirty если значение поменялось
            // относительно того, что в БД.
            const dirty = s.isSecret ? editValue.length > 0 : editValue !== (s.dbValue ?? '');
            const usingEnvFallback = !s.dbValue && Boolean(s.envValue);
            const hasDbValue = Boolean(s.dbValue);
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
                  {s.isSecret && hasDbValue && (
                    <div className="text-xs text-success flex items-center gap-1 mb-1">
                      <CheckCircle2 className="w-3 h-3" />
                      Текущее значение: <span className="font-mono">{s.currentValue}</span>. Поле ниже пустое — введи только если нужно перезаписать.
                    </div>
                  )}
                  <input
                    type={s.isSecret ? 'password' : 'text'}
                    autoComplete="off"
                    className="input font-mono text-sm"
                    placeholder={meta.placeholder}
                    value={editValue}
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
