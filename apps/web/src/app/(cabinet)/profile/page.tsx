'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { api, apiGet, apiPatch, apiPost, apiUpload } from '@/lib/api';
import {
  User, Building, Phone, Mail, Shield, Pencil, Check, X, RefreshCw,
  Cake, Camera, Lock, Bell, BellOff,
} from 'lucide-react';
import { subscribePush, unsubscribePush, getPushStatus } from '@/lib/push';

const levelNames: Record<string, string> = {
  START: 'Старт', BASIC: 'Базовый', STRONG: 'Продвинутый',
  PREMIUM: 'Премиум', ELITE: 'Элит', CHAMPION: 'Чемпион', LEGEND: 'Легенда',
};

const stageNames: Record<string, string> = {
  NEW_BROKER: 'Новый брокер', BROKER_TOUR: 'Брокер-тур',
  FIXATION: 'Фиксация', MEETING: 'Встреча', DEAL: 'Сделка',
};

const channelLabels: Record<string, string> = {
  EMAIL: 'Email',
  PUSH: 'Push',
  TELEGRAM: 'Telegram',
  SMS: 'SMS',
};

interface FullProfile {
  id: string;
  fullName: string;
  phone: string;
  email: string | null;
  avatarUrl?: string | null;
  birthDate?: string | null;
  role: string;
  status: string;
  funnelStage: string;
  agencies: Array<{
    id: string;
    name: string;
    inn: string;
    isPrimary: boolean;
    commissionLevel: string;
    legalAddress?: string | null;
    bankName?: string | null;
    bankBik?: string | null;
    bankAccount?: string | null;
    correspondentAccount?: string | null;
  }>;
  createdAt: string;
}

// ─── Personal section ───────────────────────────────────────

function PersonalSection({ profile, onChanged }: { profile: FullProfile; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [fullName, setFullName] = useState(profile.fullName);
  const [phone, setPhone] = useState(profile.phone);
  const [email, setEmail] = useState(profile.email || '');
  const [birthDate, setBirthDate] = useState(profile.birthDate ? profile.birthDate.slice(0, 10) : '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const [uploading, setUploading] = useState(false);

  const startEdit = () => {
    setFullName(profile.fullName);
    setPhone(profile.phone);
    setEmail(profile.email || '');
    setBirthDate(profile.birthDate ? profile.birthDate.slice(0, 10) : '');
    setEditing(true);
    setErr(''); setOk('');
  };

  const save = async () => {
    setSaving(true); setErr('');
    try {
      await apiPatch('/auth/me', {
        fullName: fullName !== profile.fullName ? fullName : undefined,
        phone: phone !== profile.phone ? phone : undefined,
        email: email !== (profile.email || '') ? email : undefined,
        birthDate: birthDate || null,
      });
      setOk('Сохранено');
      setEditing(false);
      onChanged();
      setTimeout(() => setOk(''), 2500);
    } catch (e: any) { setErr(e.message || 'Ошибка'); }
    setSaving(false);
  };

  const onAvatarPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true); setErr('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      await apiUpload('/auth/avatar', fd);
      onChanged();
      setOk('Аватар обновлён');
      setTimeout(() => setOk(''), 2500);
    } catch (e: any) {
      setErr(e.message || 'Ошибка загрузки');
    }
    setUploading(false);
    e.target.value = '';
  };

  const initials = profile.fullName.split(/\s+/).slice(0, 2).map((s) => s[0]).join('').toUpperCase();

  return (
    <div className="card">
      <div className="flex items-start justify-between mb-6">
        <div className="flex items-center gap-4">
          <div className="relative">
            <div className="w-20 h-20 rounded-full overflow-hidden bg-accent flex items-center justify-center">
              {profile.avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={profile.avatarUrl} alt="" className="w-full h-full object-cover" />
              ) : (
                <span className="text-white text-2xl font-bold">{initials || <User className="w-8 h-8" />}</span>
              )}
            </div>
            <label className={`absolute -bottom-1 -right-1 w-8 h-8 rounded-full bg-surface-secondary border border-border flex items-center justify-center cursor-pointer hover:bg-surface ${uploading ? 'opacity-60' : ''}`}>
              <Camera className="w-4 h-4" />
              <input
                type="file"
                accept="image/*"
                className="hidden"
                disabled={uploading}
                onChange={onAvatarPick}
              />
            </label>
          </div>
          <div>
            <h2 className="text-xl font-bold">{profile.fullName}</h2>
            <p className="text-text-muted text-sm">{profile.phone}</p>
          </div>
        </div>
        {!editing && (
          <button className="btn btn-secondary flex items-center gap-2" onClick={startEdit}>
            <Pencil className="w-4 h-4" /> Редактировать
          </button>
        )}
      </div>

      {err && <div className="mb-3 p-3 bg-error/20 text-error rounded text-sm">{err}</div>}
      {ok && <div className="mb-3 p-3 bg-success/20 text-success rounded text-sm">{ok}</div>}

      {editing ? (
        <div className="space-y-3">
          <div>
            <label className="label">ФИО</label>
            <input className="input" value={fullName} onChange={(e) => setFullName(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Телефон</label>
              <input className="input" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>
            <div>
              <label className="label">Email</label>
              <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
          </div>
          <div>
            <label className="label">Дата рождения</label>
            <input className="input" type="date" value={birthDate} onChange={(e) => setBirthDate(e.target.value)} />
          </div>
          <div className="flex gap-2 pt-2">
            <button className="btn btn-primary flex items-center gap-2" onClick={save} disabled={saving}>
              <Check className="w-4 h-4" /> {saving ? 'Сохранение...' : 'Сохранить'}
            </button>
            <button className="btn btn-secondary flex items-center gap-2" onClick={() => setEditing(false)}>
              <X className="w-4 h-4" /> Отмена
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-2 text-sm">
          <Row icon={User} label="ФИО" value={profile.fullName} />
          <Row icon={Phone} label="Телефон" value={profile.phone} />
          <Row icon={Mail} label="Email" value={profile.email || 'Не указан'} />
          <Row icon={Cake} label="Дата рождения" value={profile.birthDate ? new Date(profile.birthDate).toLocaleDateString('ru-RU') : 'Не указана'} />
          <Row icon={Shield} label="Роль" value={profile.role === 'BROKER' ? 'Брокер' : profile.role === 'MANAGER' ? 'Менеджер' : 'Админ'} />
          <Row icon={Shield} label="Статус" value={profile.status === 'ACTIVE' ? 'Активен' : profile.status} />
          <Row icon={Shield} label="Этап воронки" value={stageNames[profile.funnelStage] || profile.funnelStage} />
          <p className="text-xs text-text-muted mt-3">
            Зарегистрирован: {new Date(profile.createdAt).toLocaleDateString('ru-RU')}
          </p>
        </div>
      )}
    </div>
  );
}

function Row({ icon: Icon, label, value }: { icon: any; label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 py-2 border-b border-border last:border-0">
      <Icon className="w-4 h-4 text-text-muted" />
      <span className="text-text-muted w-32">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

// ─── Agency section ─────────────────────────────────────────

function AgencySection({ profile, onChanged }: { profile: FullProfile; onChanged: () => void }) {
  const primary = profile.agencies.find((a) => a.isPrimary) || profile.agencies[0];
  const [editing, setEditing] = useState(false);
  const [legalAddress, setLegalAddress] = useState('');
  const [bankName, setBankName] = useState('');
  const [bankBik, setBankBik] = useState('');
  const [bankAccount, setBankAccount] = useState('');
  const [correspondentAccount, setCorrespondentAccount] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');

  const startEdit = () => {
    if (!primary) return;
    setLegalAddress(primary.legalAddress || '');
    setBankName(primary.bankName || '');
    setBankBik(primary.bankBik || '');
    setBankAccount(primary.bankAccount || '');
    setCorrespondentAccount(primary.correspondentAccount || '');
    setEditing(true);
    setErr(''); setOk('');
  };

  const save = async () => {
    if (!primary) return;
    setSaving(true); setErr('');
    try {
      await apiPatch('/auth/me', {
        agency: {
          id: primary.id,
          legalAddress, bankName, bankBik, bankAccount, correspondentAccount,
        },
      });
      setOk('Сохранено');
      setEditing(false);
      onChanged();
      setTimeout(() => setOk(''), 2500);
    } catch (e: any) { setErr(e.message || 'Ошибка'); }
    setSaving(false);
  };

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold flex items-center gap-2">
          <Building className="w-5 h-5 text-accent" />
          Агентства
        </h3>
        {primary && !editing && (
          <button className="btn btn-secondary flex items-center gap-2" onClick={startEdit}>
            <Pencil className="w-4 h-4" /> Реквизиты
          </button>
        )}
      </div>

      {err && <div className="mb-3 p-3 bg-error/20 text-error rounded text-sm">{err}</div>}
      {ok && <div className="mb-3 p-3 bg-success/20 text-success rounded text-sm">{ok}</div>}

      {profile.agencies.length === 0 && <p className="text-text-muted">Нет привязанных агентств</p>}

      {editing && primary ? (
        <div className="space-y-3">
          <div className="text-sm font-medium">{primary.name} (ИНН {primary.inn})</div>
          <div>
            <label className="label">Юридический адрес</label>
            <input className="input" value={legalAddress} onChange={(e) => setLegalAddress(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Название банка</label>
              <input className="input" value={bankName} onChange={(e) => setBankName(e.target.value)} />
            </div>
            <div>
              <label className="label">БИК</label>
              <input className="input" value={bankBik} onChange={(e) => setBankBik(e.target.value.replace(/\D/g, '').slice(0, 9))} />
            </div>
          </div>
          <div>
            <label className="label">Расчётный счёт</label>
            <input className="input" value={bankAccount} onChange={(e) => setBankAccount(e.target.value.replace(/\D/g, '').slice(0, 20))} />
          </div>
          <div>
            <label className="label">Корреспондентский счёт</label>
            <input className="input" value={correspondentAccount} onChange={(e) => setCorrespondentAccount(e.target.value.replace(/\D/g, '').slice(0, 20))} />
          </div>
          <div className="flex gap-2 pt-2">
            <button className="btn btn-primary flex items-center gap-2" onClick={save} disabled={saving}>
              <Check className="w-4 h-4" /> {saving ? 'Сохранение...' : 'Сохранить'}
            </button>
            <button className="btn btn-secondary flex items-center gap-2" onClick={() => setEditing(false)}>
              <X className="w-4 h-4" /> Отмена
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {profile.agencies.map((agency) => (
            <div key={agency.id} className="p-4 bg-surface-secondary rounded-lg">
              <div className="flex items-center justify-between mb-2">
                <h4 className="font-medium">{agency.name}</h4>
                {agency.isPrimary && (
                  <span className="text-xs bg-accent/20 text-accent px-2 py-1 rounded">Основное</span>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2 text-sm mb-2">
                <div><span className="text-text-muted">ИНН: </span><span>{agency.inn}</span></div>
                <div><span className="text-text-muted">Уровень: </span><span className="text-accent">{levelNames[agency.commissionLevel] || agency.commissionLevel}</span></div>
              </div>
              {agency.isPrimary && (
                <div className="text-xs text-text-muted space-y-1 mt-2 pt-2 border-t border-border">
                  <div>Юр. адрес: <span className="text-text">{agency.legalAddress || '—'}</span></div>
                  <div>Банк: <span className="text-text">{agency.bankName || '—'}</span></div>
                  <div>БИК: <span className="text-text">{agency.bankBik || '—'}</span> · Р/с: <span className="text-text">{agency.bankAccount || '—'}</span></div>
                  <div>К/с: <span className="text-text">{agency.correspondentAccount || '—'}</span></div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Notifications section ──────────────────────────────────

function NotificationsSection() {
  const [data, setData] = useState<{
    events: Array<{ type: string; label: string; icon?: string }>;
    channels: string[];
    preferences: Record<string, Record<string, boolean>>;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [ok, setOk] = useState('');
  const [err, setErr] = useState('');

  // Push-specific state
  const [push, setPush] = useState<{ supported: boolean; permission: string; subscribed: boolean }>({
    supported: false, permission: 'default', subscribed: false,
  });
  const [pushBusy, setPushBusy] = useState(false);

  const load = () => {
    setLoading(true);
    apiGet('/notifications/preferences')
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
    getPushStatus().then(setPush).catch(() => {});
  };

  useEffect(load, []);

  const toggle = (eventType: string, channel: string) => {
    if (!data) return;
    setData({
      ...data,
      preferences: {
        ...data.preferences,
        [eventType]: {
          ...data.preferences[eventType],
          [channel]: !data.preferences[eventType]?.[channel],
        },
      },
    });
  };

  const save = async () => {
    if (!data) return;
    setSaving(true); setErr('');
    try {
      await api('/notifications/preferences', {
        method: 'PUT',
        body: JSON.stringify({ preferences: data.preferences }),
      });
      setOk('Настройки сохранены');
      setTimeout(() => setOk(''), 2500);
    } catch (e: any) { setErr(e.message || 'Ошибка'); }
    setSaving(false);
  };

  const handlePushSubscribe = async () => {
    setPushBusy(true); setErr('');
    try {
      const r = await subscribePush();
      if (!r.ok) {
        if (r.reason === 'insecure-context') setErr('Push доступен только по HTTPS или на localhost.');
        else if (r.reason === 'denied') setErr('Разрешение на уведомления отклонено в браузере.');
        else if (r.reason === 'unsupported') setErr('Браузер не поддерживает Push.');
        else if (r.reason === 'vapid-not-configured') setErr('VAPID-ключи не настроены на сервере.');
        else setErr('Не удалось подписаться (' + r.reason + ').');
      } else {
        setOk('Push подключён');
        setTimeout(() => setOk(''), 2500);
      }
    } catch (e: any) { setErr(e.message || 'Ошибка'); }
    const s = await getPushStatus(); setPush(s);
    setPushBusy(false);
  };

  const handlePushUnsubscribe = async () => {
    setPushBusy(true); setErr('');
    try {
      await unsubscribePush();
      setOk('Push отключён');
      setTimeout(() => setOk(''), 2500);
    } catch (e: any) { setErr(e.message || 'Ошибка'); }
    const s = await getPushStatus(); setPush(s);
    setPushBusy(false);
  };

  return (
    <div className="card">
      <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
        <Bell className="w-5 h-5 text-accent" />
        Уведомления
      </h3>

      {/* Push subscribe */}
      <div className="p-4 bg-surface-secondary rounded-lg mb-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1">
            <div className="font-medium text-sm mb-1">Push-уведомления в браузере</div>
            <div className="text-xs text-text-muted">
              {!push.supported && 'Браузер не поддерживает Push.'}
              {push.supported && push.subscribed && 'Уведомления приходят на эту вкладку, даже если она закрыта.'}
              {push.supported && !push.subscribed && 'Не подключено. Включите, чтобы получать важные оповещения.'}
            </div>
          </div>
          {push.supported && (
            push.subscribed ? (
              <button className="btn btn-secondary flex items-center gap-2" onClick={handlePushUnsubscribe} disabled={pushBusy}>
                <BellOff className="w-4 h-4" /> Отключить
              </button>
            ) : (
              <button className="btn btn-primary flex items-center gap-2" onClick={handlePushSubscribe} disabled={pushBusy}>
                <Bell className="w-4 h-4" /> Включить
              </button>
            )
          )}
        </div>
      </div>

      {err && <div className="mb-3 p-3 bg-error/20 text-error rounded text-sm">{err}</div>}
      {ok && <div className="mb-3 p-3 bg-success/20 text-success rounded text-sm">{ok}</div>}

      {loading || !data ? (
        <div className="text-text-muted text-sm">Загрузка…</div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-2 font-medium text-text-muted">Тип события</th>
                  {data.channels.map((ch) => (
                    <th key={ch} className="text-center py-2 font-medium text-text-muted w-24">
                      {channelLabels[ch] || ch}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.events.map((ev) => (
                  <tr key={ev.type} className="border-b border-border last:border-0">
                    <td className="py-3">
                      {ev.icon ? <span className="mr-2">{ev.icon}</span> : null}
                      {ev.label}
                    </td>
                    {data.channels.map((ch) => {
                      const enabled = !!data.preferences[ev.type]?.[ch];
                      return (
                        <td key={ch} className="text-center py-3">
                          <button
                            type="button"
                            onClick={() => toggle(ev.type, ch)}
                            className={`w-10 h-6 rounded-full transition-colors relative ${
                              enabled ? 'bg-accent' : 'bg-surface-secondary border border-border'
                            }`}
                            aria-pressed={enabled}
                          >
                            <span
                              className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
                                enabled ? 'translate-x-4' : 'translate-x-0.5'
                              }`}
                            />
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-4 flex justify-end">
            <button className="btn btn-primary flex items-center gap-2" onClick={save} disabled={saving}>
              <Check className="w-4 h-4" /> {saving ? 'Сохранение...' : 'Сохранить настройки'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Security section ───────────────────────────────────────

function SecuritySection() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');

  const submit = async () => {
    setErr('');
    if (!current) return setErr('Введите текущий пароль');
    if (next.length < 8) return setErr('Новый пароль должен быть не менее 8 символов');
    if (next !== confirm) return setErr('Пароли не совпадают');

    setSaving(true);
    try {
      await apiPost('/auth/change-password', { currentPassword: current, newPassword: next });
      setOk('Пароль изменён');
      setCurrent(''); setNext(''); setConfirm('');
      setTimeout(() => setOk(''), 2500);
    } catch (e: any) { setErr(e.message || 'Ошибка'); }
    setSaving(false);
  };

  return (
    <div className="card">
      <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
        <Lock className="w-5 h-5 text-accent" />
        Смена пароля
      </h3>

      {err && <div className="mb-3 p-3 bg-error/20 text-error rounded text-sm">{err}</div>}
      {ok && <div className="mb-3 p-3 bg-success/20 text-success rounded text-sm">{ok}</div>}

      <div className="space-y-3 max-w-md">
        <div>
          <label className="label">Текущий пароль</label>
          <input className="input" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
        </div>
        <div>
          <label className="label">Новый пароль</label>
          <input className="input" type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
          <p className="text-xs text-text-muted mt-1">Минимум 8 символов</p>
        </div>
        <div>
          <label className="label">Подтверждение нового пароля</label>
          <input className="input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
        </div>
        <div className="pt-2">
          <button className="btn btn-primary" onClick={submit} disabled={saving || !current || !next || !confirm}>
            {saving ? 'Сохранение...' : 'Сменить пароль'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Page ───────────────────────────────────────────────────

export default function ProfilePage() {
  const { broker, refresh } = useAuth();
  const [profile, setProfile] = useState<FullProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');

  const loadProfile = async () => {
    try {
      const data = await apiGet<FullProfile>('/auth/me');
      setProfile(data);
    } catch {}
    setLoading(false);
  };

  useEffect(() => { loadProfile(); }, []);

  const handleAmoSync = async () => {
    setSyncing(true); setSyncMsg('');
    try {
      const data: any = await apiPost('/amocrm/sync-my-deals', {});
      setSyncMsg(`Синхронизация: добавлено ${data.dealsCreated}, обновлено ${data.dealsUpdated}, новых клиентов ${data.clientsCreated}`);
    } catch (e: any) { setSyncMsg(e.message || 'Ошибка синхронизации'); }
    setSyncing(false);
  };

  const onChanged = async () => {
    await loadProfile();
    await refresh();
  };

  if (loading || !profile || !broker) {
    return <div className="text-text-muted">Загрузка профиля…</div>;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold">Профиль</h1>
        <button className="btn btn-secondary flex items-center gap-2" onClick={handleAmoSync} disabled={syncing}>
          <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
          {syncing ? 'Синхронизация...' : 'Синхр. amoCRM'}
        </button>
      </div>

      {syncMsg && <div className="mb-4 p-3 bg-info/20 text-info rounded text-sm">{syncMsg}</div>}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <PersonalSection profile={profile} onChanged={onChanged} />
        <AgencySection profile={profile} onChanged={onChanged} />
      </div>

      <div className="grid grid-cols-1 gap-6">
        <NotificationsSection />
        <SecuritySection />
      </div>
    </div>
  );
}
