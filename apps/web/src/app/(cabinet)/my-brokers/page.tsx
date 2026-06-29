'use client';

// 2026-06-29: страница «Мои брокеры» — координатор видит список брокеров,
// которых он сам завёл через форму фиксации. Только для is_coordinator.

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/lib/auth';
import { apiGet, apiPost } from '@/lib/api';
import { UserPlus, Mail, Trash2, ArrowRight, RefreshCw } from 'lucide-react';

interface CreatedBroker {
  id: string;
  fullName: string;
  phone: string;
  email: string | null;
  status: string;
  createdAt: string;
  createdByCoordAt: string;
  activated: boolean;
  agency: { id: string; name: string; inn: string } | null;
  clientsCount: number;
  dealsCount: number;
}

export default function MyBrokersPage() {
  const { broker, loading: authLoading } = useAuth();
  const router = useRouter();
  const isCoordinator = !!(broker as any)?.isCoordinator;
  const [brokers, setBrokers] = useState<CreatedBroker[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionId, setActionId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    if (authLoading) return;
    if (!isCoordinator) {
      router.replace('/fixation');
      return;
    }
    loadBrokers();
  }, [authLoading, isCoordinator]);

  const loadBrokers = () => {
    setLoading(true);
    apiGet<{ brokers: CreatedBroker[] }>('/clients/coordinator/my-brokers')
      .then((d) => setBrokers(d.brokers || []))
      .catch(() => setBrokers([]))
      .finally(() => setLoading(false));
  };

  const handleResendWelcome = async (b: CreatedBroker) => {
    if (!b.email) {
      setMessage({ kind: 'err', text: 'У брокера не указан email' });
      return;
    }
    setActionId(b.id);
    setMessage(null);
    try {
      await apiPost(`/clients/coordinator/resend-welcome/${b.id}`, {});
      setMessage({ kind: 'ok', text: `Письмо отправлено на ${b.email}` });
    } catch (e: any) {
      setMessage({ kind: 'err', text: e?.message || 'Не удалось отправить' });
    } finally {
      setActionId(null);
    }
  };

  const handleDelete = async (b: CreatedBroker) => {
    if (!confirm(`Удалить брокера "${b.fullName}"? Это можно сделать только если у него нет клиентов и сделок.`)) {
      return;
    }
    setActionId(b.id);
    setMessage(null);
    try {
      await apiPost(`/clients/coordinator/delete-broker/${b.id}`, {});
      setMessage({ kind: 'ok', text: `Брокер ${b.fullName} удалён` });
      setBrokers((prev) => prev.filter((x) => x.id !== b.id));
    } catch (e: any) {
      setMessage({ kind: 'err', text: e?.message || 'Не удалось удалить' });
    } finally {
      setActionId(null);
    }
  };

  const handleFixateOn = (b: CreatedBroker) => {
    // Передаём id брокера через query — форма фиксации сможет подхватить.
    router.push(`/fixation?responsibleBrokerId=${b.id}`);
  };

  if (authLoading || loading) {
    return <div className="card">Загрузка...</div>;
  }

  if (!isCoordinator) {
    return null; // редирект уже идёт
  }

  return (
    <div className="max-w-6xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold flex items-center gap-2">
            <UserPlus className="w-7 h-7 text-accent" />
            Мои брокеры
          </h1>
          <span className="text-text-muted text-sm">
            Брокеры, которых вы завели в систему как координатор. Всего: {brokers.length}
          </span>
        </div>
        <Link href="/my-brokers/new" className="btn btn-primary text-sm">
          + Завести нового
        </Link>
      </div>

      {message && (
        <div
          className={`mb-4 p-3 rounded text-sm ${
            message.kind === 'ok' ? 'bg-success/20 text-success' : 'bg-error/20 text-error'
          }`}
        >
          {message.text}
        </div>
      )}

      <div className="card">
        {brokers.length === 0 ? (
          <div className="text-center py-12 text-text-muted">
            <UserPlus className="w-12 h-12 mx-auto mb-3 opacity-40" />
            <div className="mb-2">Вы ещё никого не завели.</div>
            <div className="text-sm space-x-3">
              <Link href="/my-brokers/new" className="text-accent hover:underline">
                + Завести нового брокера
              </Link>
              <span className="text-text-muted">или</span>
              <Link href="/fixation" className="text-accent hover:underline">
                сразу при фиксации клиента →
              </Link>
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-text-muted text-left border-b border-border">
                  <th className="pb-3 font-medium">ФИО</th>
                  <th className="pb-3 font-medium">Телефон</th>
                  <th className="pb-3 font-medium">Email</th>
                  <th className="pb-3 font-medium">Статус</th>
                  <th className="pb-3 font-medium">Агентство</th>
                  <th className="pb-3 font-medium text-right">Клиенты</th>
                  <th className="pb-3 font-medium text-right">Сделки</th>
                  <th className="pb-3 font-medium">Создан</th>
                  <th className="pb-3 font-medium text-right">Действия</th>
                </tr>
              </thead>
              <tbody>
                {brokers.map((b) => (
                  <tr key={b.id} className="border-b border-border last:border-0 hover:bg-surface-secondary">
                    <td className="py-3 font-medium">{b.fullName}</td>
                    <td className="py-3 text-text-muted">{b.phone}</td>
                    <td className="py-3 text-text-muted text-xs">{b.email || '—'}</td>
                    <td className="py-3">
                      {b.activated ? (
                        <span className="text-xs px-2 py-1 rounded bg-success/20 text-success">Активен</span>
                      ) : (
                        <span className="text-xs px-2 py-1 rounded bg-warning/20 text-warning" title="Брокер ещё не установил пароль и не зашёл в кабинет">
                          Ожидает входа
                        </span>
                      )}
                    </td>
                    <td className="py-3 text-xs text-text-muted">
                      {b.agency ? `${b.agency.name} · ${b.agency.inn}` : '—'}
                    </td>
                    <td className="py-3 text-right">{b.clientsCount}</td>
                    <td className="py-3 text-right">{b.dealsCount}</td>
                    <td className="py-3 text-xs text-text-muted">
                      {new Date(b.createdByCoordAt).toLocaleDateString('ru-RU')}
                    </td>
                    <td className="py-3">
                      <div className="flex gap-1 justify-end">
                        <button
                          type="button"
                          className="p-1.5 hover:bg-surface rounded text-text-muted hover:text-accent disabled:opacity-50"
                          title="Зафиксировать клиента на этого брокера"
                          onClick={() => handleFixateOn(b)}
                          disabled={actionId === b.id}
                        >
                          <ArrowRight className="w-4 h-4" />
                        </button>
                        {!b.activated && b.email && (
                          <button
                            type="button"
                            className="p-1.5 hover:bg-surface rounded text-text-muted hover:text-info disabled:opacity-50"
                            title="Отправить приглашение по email повторно"
                            onClick={() => handleResendWelcome(b)}
                            disabled={actionId === b.id}
                          >
                            {actionId === b.id ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
                          </button>
                        )}
                        {!b.activated && b.clientsCount === 0 && b.dealsCount === 0 && (
                          <button
                            type="button"
                            className="p-1.5 hover:bg-surface rounded text-text-muted hover:text-error disabled:opacity-50"
                            title="Удалить (можно только если нет клиентов и сделок)"
                            onClick={() => handleDelete(b)}
                            disabled={actionId === b.id}
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
