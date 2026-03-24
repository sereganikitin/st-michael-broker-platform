'use client';

import { useAuth } from '@/lib/auth';
import { User, Building, Phone, Mail, Shield } from 'lucide-react';

const levelNames: Record<string, string> = {
  START: 'Старт', BASIC: 'Базовый', STRONG: 'Продвинутый',
  PREMIUM: 'Премиум', ELITE: 'Элит', CHAMPION: 'Чемпион', LEGEND: 'Легенда',
};

const stageNames: Record<string, string> = {
  NEW_BROKER: 'Новый брокер', BROKER_TOUR: 'Брокер-тур',
  FIXATION: 'Фиксация', MEETING: 'Встреча', DEAL: 'Сделка',
};

export default function ProfilePage() {
  const { broker } = useAuth();

  if (!broker) return null;

  const fields = [
    { icon: User, label: 'ФИО', value: broker.fullName },
    { icon: Phone, label: 'Телефон', value: broker.phone },
    { icon: Mail, label: 'Email', value: broker.email || 'Не указан' },
    { icon: Shield, label: 'Роль', value: broker.role === 'BROKER' ? 'Брокер' : broker.role === 'MANAGER' ? 'Менеджер' : 'Админ' },
    { icon: Shield, label: 'Статус', value: broker.status === 'ACTIVE' ? 'Активен' : broker.status },
    { icon: Shield, label: 'Этап воронки', value: stageNames[broker.funnelStage] || broker.funnelStage },
  ];

  return (
    <div>
      <h1 className="text-3xl font-bold mb-6">Профиль</h1>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card">
          <div className="flex items-center gap-4 mb-6">
            <div className="w-16 h-16 bg-accent rounded-full flex items-center justify-center">
              <User className="w-8 h-8 text-background" />
            </div>
            <div>
              <h2 className="text-xl font-bold">{broker.fullName}</h2>
              <p className="text-text-muted">{broker.phone}</p>
            </div>
          </div>

          <div className="space-y-4">
            {fields.map((f) => (
              <div key={f.label} className="flex items-center gap-3 py-2 border-b border-border last:border-0">
                <f.icon className="w-4 h-4 text-text-muted" />
                <span className="text-sm text-text-muted w-32">{f.label}</span>
                <span className="text-sm font-medium">{f.value}</span>
              </div>
            ))}
          </div>

          <p className="text-xs text-text-muted mt-4">
            Зарегистрирован: {new Date(broker.createdAt).toLocaleDateString('ru-RU')}
          </p>
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
                    <div>
                      <span className="text-text-muted">ИНН: </span>
                      <span>{agency.inn}</span>
                    </div>
                    <div>
                      <span className="text-text-muted">Уровень: </span>
                      <span className="text-accent">{levelNames[agency.commissionLevel] || agency.commissionLevel}</span>
                    </div>
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
