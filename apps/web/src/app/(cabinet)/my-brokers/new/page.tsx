'use client';

// 2026-06-29: отдельная страница для координатора чтобы завести нового
// брокера. Альтернатива модалке-в-фиксации (та удобна когда координатор
// уже в форме фиксации). Эта — просто чтобы добавить брокеров заранее.

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/lib/auth';
import { apiGet, apiPost } from '@/lib/api';
import { UserPlus, ArrowLeft } from 'lucide-react';

interface Agency {
  id: string;
  name: string;
  inn: string;
  isPrimary: boolean;
}

export default function NewBrokerPage() {
  const router = useRouter();
  const { broker, loading: authLoading } = useAuth();
  const isCoordinator = !!(broker as any)?.isCoordinator;

  const [agencies, setAgencies] = useState<Agency[]>([]);
  const [fullName, setFullName] = useState('');
  const [phoneDigits, setPhoneDigits] = useState('');
  const [email, setEmail] = useState('');
  const [agencyId, setAgencyId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ field?: string; message: string } | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (authLoading) return;
    if (!isCoordinator) {
      router.replace('/fixation');
      return;
    }
    apiGet<{ agencies: Agency[] }>('/clients/coordinator/agencies')
      .then((d) => {
        const list = d.agencies || [];
        setAgencies(list);
        const primary = list.find((a) => a.isPrimary) || list[0];
        if (primary) setAgencyId(primary.id);
      })
      .catch(() => setAgencies([]));
  }, [authLoading, isCoordinator]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (!fullName.trim() || fullName.trim().length < 2) {
      setError({ field: 'fullName', message: 'Введите ФИО (минимум 2 символа)' });
      return;
    }
    if (phoneDigits.length !== 10) {
      setError({ field: 'phone', message: 'Введите 10 цифр номера' });
      return;
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError({ field: 'email', message: 'Неверный формат email' });
      return;
    }
    if (!agencyId) {
      setError({ field: 'agencyId', message: 'Выберите агентство' });
      return;
    }

    setLoading(true);
    try {
      const r: any = await apiPost('/clients/coordinator/create-broker', {
        fullName: fullName.trim(),
        phone: '+7' + phoneDigits,
        email: email.trim() || undefined,
        agencyId,
      });
      const newBroker = r?.broker;
      if (r?.created) {
        setSuccess(`Брокер «${newBroker.fullName}» создан. ${email ? 'Письмо с приглашением отправлено.' : ''}`);
      } else {
        setSuccess(`Брокер «${newBroker.fullName}» уже был в системе, не создавался заново.`);
      }
      setFullName('');
      setPhoneDigits('');
      setEmail('');
      // Через 2 секунды возвращаемся на список
      setTimeout(() => router.push('/my-brokers'), 2000);
    } catch (e: any) {
      const raw = e?.response?.data || e;
      setError({
        field: raw?.field,
        message: raw?.message || e?.message || 'Не удалось создать брокера',
      });
    } finally {
      setLoading(false);
    }
  };

  if (authLoading) {
    return <div className="card">Загрузка...</div>;
  }
  if (!isCoordinator) {
    return null;
  }

  return (
    <div className="max-w-xl">
      <Link href="/my-brokers" className="inline-flex items-center gap-2 text-sm text-text-muted hover:text-text mb-4">
        <ArrowLeft className="w-4 h-4" />
        Назад к списку
      </Link>

      <div className="flex items-center gap-2 mb-2">
        <UserPlus className="w-7 h-7 text-accent" />
        <h1 className="text-2xl md:text-3xl font-bold">Новый брокер</h1>
      </div>
      <p className="text-text-muted text-sm mb-6">
        Заполните данные. После создания брокер получит email с приглашением и сможет войти, сбросив пароль через «Забыли пароль».
      </p>

      <div className="card">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="label">ФИО <span className="text-error">*</span></label>
            <input
              type="text"
              className={`input ${error?.field === 'fullName' ? 'border-error' : ''}`}
              placeholder="Иванов Иван Иванович"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              disabled={loading}
            />
            {error?.field === 'fullName' && (
              <div className="text-xs text-error mt-1">{error.message}</div>
            )}
          </div>

          <div>
            <label className="label">Телефон <span className="text-error">*</span></label>
            <div className="flex">
              <span className="inline-flex items-center px-3 bg-surface-secondary border border-r-0 border-border rounded-l text-text-muted text-sm">+7</span>
              <input
                type="tel"
                className={`input rounded-l-none ${error?.field === 'phone' ? 'border-error' : ''}`}
                placeholder="9991234567"
                value={phoneDigits}
                onChange={(e) => setPhoneDigits(e.target.value.replace(/\D/g, '').slice(0, 10))}
                maxLength={10}
                disabled={loading}
              />
            </div>
            {error?.field === 'phone' && (
              <div className="text-xs text-error mt-1">{error.message}</div>
            )}
          </div>

          <div>
            <label className="label">Email <span className="text-text-muted">(необязательно)</span></label>
            <input
              type="email"
              className={`input ${error?.field === 'email' ? 'border-error' : ''}`}
              placeholder="broker@example.ru"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={loading}
            />
            <div className="text-xs text-text-muted mt-1">
              Без email брокер не сможет получить ссылку для входа.
            </div>
            {error?.field === 'email' && (
              <div className="text-xs text-error mt-1">{error.message}</div>
            )}
          </div>

          <div>
            <label className="label">Агентство <span className="text-error">*</span></label>
            <select
              className={`input ${error?.field === 'agencyId' ? 'border-error' : ''}`}
              value={agencyId}
              onChange={(e) => setAgencyId(e.target.value)}
              disabled={loading || agencies.length === 0}
            >
              {agencies.length === 0 && <option value="">— загрузка —</option>}
              {agencies.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} (ИНН {a.inn}){a.isPrimary && agencies.length > 1 ? ' • основное' : ''}
                </option>
              ))}
            </select>
            <div className="text-xs text-text-muted mt-1">
              К этому агентству будет привязан новый брокер.
            </div>
            {error?.field === 'agencyId' && (
              <div className="text-xs text-error mt-1">{error.message}</div>
            )}
          </div>

          {error && !error.field && (
            <div className="p-3 bg-error/20 text-error rounded-lg text-sm">{error.message}</div>
          )}

          {success && (
            <div className="p-3 bg-success/20 text-success rounded-lg text-sm">{success}</div>
          )}

          <div className="flex gap-2 pt-2">
            <Link href="/my-brokers" className="btn btn-secondary flex-1 text-center">
              Отмена
            </Link>
            <button
              type="submit"
              className="btn btn-primary flex-1"
              disabled={loading}
            >
              {loading ? 'Создание…' : 'Создать брокера'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
