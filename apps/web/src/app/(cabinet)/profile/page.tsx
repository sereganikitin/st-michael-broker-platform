'use client';

import { useState } from 'react';
import { useAuth } from '@/lib/auth';
import { apiPatch, apiPost } from '@/lib/api';
import { User, Building, Phone, Mail, Shield, Pencil, Check, X, RefreshCw } from 'lucide-react';

const levelNames: Record<string, string> = {
  START: 'Старт', BASIC: 'Базовый', STRONG: 'Продвинутый',
  PREMIUM: 'Премиум', ELITE: 'Элит', CHAMPION: 'Чемпион', LEGEND: 'Легенда',
};

const stageNames: Record<string, string> = {
  NEW_BROKER: 'Новый брокер', BROKER_TOUR: 'Брокер-тур',
  FIXATION: 'Фиксация', MEETING: 'Встреча', DEAL: 'Сделка',
};

export default function ProfilePage() {
  const { broker, refresh } = useAuth();
  const [editing, setEditing] = useState(false);
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string>('');

  const handleAmoSync = async () => {
    setSyncing(true);
    setSyncResult('');
    try {
      const data: any = await apiPost('/amocrm/sync-my-deals', {});
      setSyncResult(`Синхронизация: добавлено сделок ${data.dealsCreated}, обновлено ${data.dealsUpdated}, новых клиентов ${data.clientsCreated}`);
    } catch (e: any) {
      setSyncResult(e.message || 'Ошибка синхронизации');
    }
    setSyncing(false);
  };

  if (!broker) return null;

  const startEdit = () => {
    setFullName(broker.fullName);
    setPhone(broker.phone);
    setEmail(broker.email || '');
    setEditing(true);
    setError('');
    setSuccess('');
  };

  const cancelEdit = () => {
    setEditing(false);
    setError('');
  };

  const saveProfile = async () => {
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      await apiPatch('/auth/me', {
        fullName: fullName !== broker.fullName ? fullName : undefined,
        phone: phone !== broker.phone ? phone : undefined,
        email: email !== (broker.email || '') ? email : undefined,
      });
      await refresh();
      setEditing(false);
      setSuccess('Профиль обновлён');
      setTimeout(() => setSuccess(''), 3000);
    } catch (e: any) {
      setError(e.message || 'Ошибка сохранения');
    }
    setSaving(false);
  };

  const readonlyFields = [
    { icon: Shield, label: 'Роль', value: broker.role === 'BROKER' ? 'Брокер' : broker.role === 'MANAGER' ? 'Менеджер' : 'Админ' },
    { icon: Shield, label: 'Статус', value: broker.status === 'ACTIVE' ? 'Активен' : broker.status },
    { icon: Shield, label: 'Этап воронки', value: stageNames[broker.funnelStage] || broker.funnelStage },
  ];

  return (
    <div>
      <h1 className="text-3xl font-bold mb-6">Профиль</h1>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-4">
              <div className="w-16 h-16 bg-accent rounded-full flex items-center justify-center">
                <User className="w-8 h-8 text-background" />
              </div>
              <div>
                <h2 className="text-xl font-bold">{broker.fullName}</h2>
                <p className="text-text-muted">{broker.phone}</p>
              </div>
            </div>
            {!editing && (
              <div className="flex gap-2">
                <button className="btn btn-secondary flex items-center gap-2" onClick={handleAmoSync} disabled={syncing}>
                  <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
                  {syncing ? 'Синхронизация...' : 'Синхр. amoCRM'}
                </button>
                <button className="btn btn-secondary flex items-center gap-2" onClick={startEdit}>
                  <Pencil className="w-4 h-4" /> Редактировать
                </button>
              </div>
            )}
          </div>

          {syncResult && (
            <div className="mb-4 p-3 bg-info/20 text-info rounded-lg text-sm">{syncResult}</div>
          )}

          {error && <div className="mb-4 p-3 bg-error/20 text-error rounded-lg text-sm">{error}</div>}
          {success && <div className="mb-4 p-3 bg-success/20 text-success rounded-lg text-sm">{success}</div>}

          {editing ? (
            <div className="space-y-4">
              <div>
                <label className="label">ФИО</label>
                <input className="input" value={fullName} onChange={(e) => setFullName(e.target.value)} />
              </div>
              <div>
                <label className="label">Телефон</label>
                <input className="input" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
              </div>
              <div>
                <label className="label">Email</label>
                <input className="input" type="email" placeholder="example@mail.ru" value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>

              <div className="border-t border-border pt-4 mt-2">
                {readonlyFields.map((f) => (
                  <div key={f.label} className="flex items-center gap-3 py-2 border-b border-border last:border-0">
                    <f.icon className="w-4 h-4 text-text-muted" />
                    <span className="text-sm text-text-muted w-32">{f.label}</span>
                    <span className="text-sm font-medium">{f.value}</span>
                  </div>
                ))}
              </div>

              <div className="flex gap-3 pt-2">
                <button className="btn btn-primary flex items-center gap-2" onClick={saveProfile} disabled={saving}>
                  <Check className="w-4 h-4" /> {saving ? 'Сохранение...' : 'Сохранить'}
                </button>
                <button className="btn btn-secondary flex items-center gap-2" onClick={cancelEdit}>
                  <X className="w-4 h-4" /> Отмена
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center gap-3 py-2 border-b border-border">
                <User className="w-4 h-4 text-text-muted" />
                <span className="text-sm text-text-muted w-32">ФИО</span>
                <span className="text-sm font-medium">{broker.fullName}</span>
              </div>
              <div className="flex items-center gap-3 py-2 border-b border-border">
                <Phone className="w-4 h-4 text-text-muted" />
                <span className="text-sm text-text-muted w-32">Телефон</span>
                <span className="text-sm font-medium">{broker.phone}</span>
              </div>
              <div className="flex items-center gap-3 py-2 border-b border-border">
                <Mail className="w-4 h-4 text-text-muted" />
                <span className="text-sm text-text-muted w-32">Email</span>
                <span className="text-sm font-medium">{broker.email || 'Не указан'}</span>
              </div>
              {readonlyFields.map((f) => (
                <div key={f.label} className="flex items-center gap-3 py-2 border-b border-border last:border-0">
                  <f.icon className="w-4 h-4 text-text-muted" />
                  <span className="text-sm text-text-muted w-32">{f.label}</span>
                  <span className="text-sm font-medium">{f.value}</span>
                </div>
              ))}

              <p className="text-xs text-text-muted mt-4">
                Зарегистрирован: {new Date(broker.createdAt).toLocaleDateString('ru-RU')}
              </p>
            </div>
          )}
        </div>

        <div className="card">
          <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <Building className="w-5 h-5 text-accent" />
            Агентства
          </h3>

          {broker.agencies.length === 0 ? (
            <p className="text-text-muted">Нет привязанных агентств</p>
          ) : (
            <div className="space-y-4">
              {broker.agencies.map((agency) => (
                <div key={agency.id} className="p-4 bg-surface-secondary rounded-lg">
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="font-medium">{agency.name}</h4>
                    {agency.isPrimary && (
                      <span className="text-xs bg-accent/20 text-accent px-2 py-1 rounded">Основное</span>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <div><span className="text-text-muted">ИНН: </span><span>{agency.inn}</span></div>
                    <div><span className="text-text-muted">Уровень: </span><span className="text-accent">{levelNames[agency.commissionLevel] || agency.commissionLevel}</span></div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
