'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { apiGet } from '@/lib/api';
import { Search, ChevronLeft, ChevronRight, Shield } from 'lucide-react';
import { useAuth } from '@/lib/auth';

const roleLabels: Record<string, string> = { BROKER: 'Брокер', MANAGER: 'Менеджер', ADMIN: 'Админ' };
const statusLabels: Record<string, { label: string; cls: string }> = {
  ACTIVE: { label: 'Активен', cls: 'bg-success/20 text-success' },
  PENDING: { label: 'Ожидает', cls: 'bg-warning/20 text-warning' },
  BLOCKED: { label: 'Заблокирован', cls: 'bg-error/20 text-error' },
};

export default function AdminBrokersPage() {
  const { broker } = useAuth();
  const [brokers, setBrokers] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [loading, setLoading] = useState(true);

  if (broker && broker.role !== 'ADMIN' && broker.role !== 'MANAGER') {
    return <div className="card">Доступ запрещён</div>;
  }

  const fetchBrokers = () => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), limit: '20' });
    if (search) params.set('search', search);
    if (roleFilter) params.set('role', roleFilter);
    if (statusFilter) params.set('status', statusFilter);
    apiGet(`/admin/brokers?${params}`)
      .then((data) => {
        setBrokers(data.brokers || []);
        setTotal(data.total || 0);
        setTotalPages(data.totalPages || 1);
      })
      .catch(() => setBrokers([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchBrokers(); }, [page, roleFilter, statusFilter]);

  const handleSearch = (e: React.FormEvent) => { e.preventDefault(); setPage(1); fetchBrokers(); };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2"><Shield className="w-7 h-7 text-accent" />Брокеры</h1>
          <span className="text-text-muted text-sm">Всего в системе: {total}</span>
        </div>
      </div>

      <div className="card mb-6">
        <div className="flex flex-wrap gap-4">
          <form onSubmit={handleSearch} className="flex-1 min-w-[200px] relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
            <input className="input pl-10" placeholder="ФИО, телефон или email..." value={search} onChange={(e) => setSearch(e.target.value)} />
          </form>
          <select className="input w-auto" value={roleFilter} onChange={(e) => { setRoleFilter(e.target.value); setPage(1); }}>
            <option value="">Все роли</option>
            <option value="BROKER">Брокер</option>
            <option value="MANAGER">Менеджер</option>
            <option value="ADMIN">Админ</option>
          </select>
          <select className="input w-auto" value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}>
            <option value="">Все статусы</option>
            <option value="ACTIVE">Активен</option>
            <option value="PENDING">Ожидает</option>
            <option value="BLOCKED">Заблокирован</option>
          </select>
        </div>
      </div>

      <div className="card">
        {loading ? (
          <div className="text-center py-8 text-text-muted">Загрузка...</div>
        ) : brokers.length === 0 ? (
          <div className="text-center py-8 text-text-muted">Брокеры не найдены</div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-text-muted text-left border-b border-border">
                    <th className="pb-3 font-medium">ФИО</th>
                    <th className="pb-3 font-medium">Телефон</th>
                    <th className="pb-3 font-medium">Email</th>
                    <th className="pb-3 font-medium">Роль</th>
                    <th className="pb-3 font-medium">Статус</th>
                    <th className="pb-3 font-medium text-right">Клиенты</th>
                    <th className="pb-3 font-medium text-right">Сделки</th>
                    <th className="pb-3 font-medium text-right">Встречи</th>
                  </tr>
                </thead>
                <tbody>
                  {brokers.map((b: any) => (
                    <tr key={b.id} className="border-b border-border last:border-0 hover:bg-surface-secondary cursor-pointer">
                      <td className="py-3 font-medium">
                        <Link href={`/admin/brokers/${b.id}`} className="hover:text-accent">{b.fullName}</Link>
                      </td>
                      <td className="py-3 text-text-muted">{b.phone}</td>
                      <td className="py-3 text-text-muted text-xs">{b.email || '—'}</td>
                      <td className="py-3">
                        <span className={`text-xs px-2 py-1 rounded ${b.role === 'ADMIN' ? 'bg-accent/20 text-accent' : b.role === 'MANAGER' ? 'bg-info/20 text-info' : 'bg-text-muted/20 text-text-muted'}`}>
                          {roleLabels[b.role] || b.role}
                        </span>
                      </td>
                      <td className="py-3">
                        <span className={`text-xs px-2 py-1 rounded ${statusLabels[b.status]?.cls || ''}`}>
                          {statusLabels[b.status]?.label || b.status}
                        </span>
                      </td>
                      <td className="py-3 text-right">{b._count?.clients ?? 0}</td>
                      <td className="py-3 text-right">{b._count?.deals ?? 0}</td>
                      <td className="py-3 text-right">{b._count?.meetings ?? 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-4 pt-4 border-t border-border">
                <span className="text-sm text-text-muted">Стр. {page} из {totalPages}</span>
                <div className="flex gap-2">
                  <button className="btn btn-secondary" onClick={() => setPage(Math.max(1, page - 1))} disabled={page === 1}><ChevronLeft className="w-4 h-4" /></button>
                  <button className="btn btn-secondary" onClick={() => setPage(Math.min(totalPages, page + 1))} disabled={page === totalPages}><ChevronRight className="w-4 h-4" /></button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
