'use client';

import { useEffect, useRef, useState } from 'react';
import { apiGet } from '@/lib/api';
import { Search, ChevronLeft, ChevronRight, Upload, X } from 'lucide-react';

const statusLabels: Record<string, { label: string; cls: string }> = {
  CONDITIONALLY_UNIQUE: { label: 'Уникален', cls: 'bg-success/20 text-success' },
  REJECTED: { label: 'Отклонён', cls: 'bg-error/20 text-error' },
  UNDER_REVIEW: { label: 'На проверке', cls: 'bg-warning/20 text-warning' },
  EXPIRED: { label: 'Истёк', cls: 'bg-text-muted/20 text-text-muted' },
};

const fixationLabels: Record<string, { label: string; cls: string }> = {
  NOT_FIXED: { label: 'Не зафикс.', cls: 'text-text-muted' },
  FIXED: { label: 'Зафикс.', cls: 'text-success' },
  EXPIRED: { label: 'Истёк', cls: 'text-error' },
  ANNULLED: { label: 'Аннулир.', cls: 'text-error' },
};

const projectLabels: Record<string, string> = {
  ZORGE9: 'Зорге 9',
  SILVER_BOR: 'Серебряный бор',
};

function ClientDetail({ client, onClose }: { client: any; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-surface rounded-xl max-w-lg w-full max-h-[90vh] overflow-y-auto p-6 relative"
        onClick={(e) => e.stopPropagation()}
      >
        <button className="absolute top-4 right-4 text-text-muted hover:text-text" onClick={onClose}>
          <X className="w-5 h-5" />
        </button>

        <h2 className="text-xl font-bold mb-1">{client.fullName}</h2>
        <p className="text-text-muted text-sm mb-4">{client.phone}</p>

        <div className="flex gap-2 mb-4">
          <span className={`text-xs px-2 py-1 rounded ${statusLabels[client.uniquenessStatus]?.cls || 'bg-text-muted/20'}`}>
            {statusLabels[client.uniquenessStatus]?.label || client.uniquenessStatus}
          </span>
          <span className={`text-xs px-2 py-1 rounded ${fixationLabels[client.fixationStatus]?.cls || ''}`}>
            {fixationLabels[client.fixationStatus]?.label || client.fixationStatus}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-3 text-sm mb-4">
          {client.email && (
            <div className="bg-surface-secondary rounded-lg p-3 col-span-2">
              <span className="text-text-muted block text-xs">Email</span>
              <span className="font-medium">{client.email}</span>
            </div>
          )}
          <div className="bg-surface-secondary rounded-lg p-3">
            <span className="text-text-muted block text-xs">Проект</span>
            <span className="font-medium">{projectLabels[client.project] || client.project}</span>
          </div>
          <div className="bg-surface-secondary rounded-lg p-3">
            <span className="text-text-muted block text-xs">Статус</span>
            <span className="font-medium">{client.status}</span>
          </div>
          {client.uniquenessExpiresAt && (
            <div className="bg-surface-secondary rounded-lg p-3">
              <span className="text-text-muted block text-xs">Уникальность до</span>
              <span className="font-medium">{new Date(client.uniquenessExpiresAt).toLocaleDateString('ru-RU')}</span>
            </div>
          )}
          {client.fixationExpiresAt && (
            <div className="bg-surface-secondary rounded-lg p-3">
              <span className="text-text-muted block text-xs">Фиксация до</span>
              <span className="font-medium">{new Date(client.fixationExpiresAt).toLocaleDateString('ru-RU')}</span>
            </div>
          )}
          <div className="bg-surface-secondary rounded-lg p-3">
            <span className="text-text-muted block text-xs">Дата создания</span>
            <span className="font-medium">{new Date(client.createdAt).toLocaleDateString('ru-RU')}</span>
          </div>
          <div className="bg-surface-secondary rounded-lg p-3">
            <span className="text-text-muted block text-xs">Обновлён</span>
            <span className="font-medium">{new Date(client.updatedAt).toLocaleDateString('ru-RU')}</span>
          </div>
        </div>

        {client.comment && (
          <div className="bg-surface-secondary rounded-lg p-3 mb-4">
            <span className="text-text-muted block text-xs mb-1">Комментарий</span>
            <span className="text-sm whitespace-pre-wrap">{client.comment}</span>
          </div>
        )}

        {client.uniquenessReason && (
          <div className="bg-surface-secondary rounded-lg p-3 mb-4">
            <span className="text-text-muted block text-xs mb-1">Причина уникальности</span>
            <span className="text-sm">{client.uniquenessReason}</span>
          </div>
        )}

        {client.deals && client.deals.length > 0 && (
          <div>
            <h3 className="text-sm font-medium mb-2">Сделки</h3>
            <div className="space-y-2">
              {client.deals.map((deal: any) => (
                <div key={deal.id} className="bg-surface-secondary rounded-lg p-3 flex justify-between text-sm">
                  <span>Статус: {deal.status}</span>
                  {deal.amount && <span className="font-medium">{Number(deal.amount).toLocaleString('ru-RU')} ₽</span>}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function ClientsPage() {
  const [clients, setClients] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [projectFilter, setProjectFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ imported: number; skipped: number; errors: string[] } | null>(null);
  const [selectedClient, setSelectedClient] = useState<any>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    setImportResult(null);

    const token = localStorage.getItem('accessToken');
    const formData = new FormData();
    formData.append('file', file);

    // Fire-and-forget: запускаем импорт, но не ждём ответа (файл большой)
    fetch('/api/clients/import', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    })
      .then((res) => res.json().catch(() => null))
      .then((data) => {
        if (data && typeof data.imported === 'number') {
          setImportResult(data);
          fetchClients();
        }
      })
      .catch(() => {
        // Тихо игнорируем — импорт продолжается на сервере
      });

    setImportResult({
      imported: 0,
      skipped: 0,
      errors: ['Импорт запущен. Файл большой — обработка может занять несколько минут. Обновите страницу через пару минут.'],
    });
    setImporting(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const fetchClients = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: '15' });
      if (search) params.set('search', search);
      if (statusFilter) params.set('status', statusFilter);
      if (projectFilter) params.set('project', projectFilter);
      const data = await apiGet(`/clients?${params}`);
      setClients(data.clients || []);
      setTotal(data.total || 0);
      setTotalPages(data.totalPages || 1);
    } catch {
      setClients([]);
    }
    setLoading(false);
  };

  useEffect(() => { fetchClients(); }, [page, statusFilter, projectFilter]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    fetchClients();
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold">Клиенты</h1>
        <div className="flex items-center gap-3">
          <span className="text-text-muted text-sm">Всего: {total}</span>
          <input ref={fileInputRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={handleImport} />
          <button
            className="btn btn-secondary flex items-center gap-2"
            onClick={() => fileInputRef.current?.click()}
            disabled={importing}
          >
            <Upload className="w-4 h-4" />
            {importing ? 'Импорт...' : 'Импорт Excel'}
          </button>
        </div>
      </div>

      {importResult && (
        <div className="mb-4 p-4 rounded-lg text-sm bg-info/20 text-info">
          {importResult.imported > 0 && (
            <p className="font-medium">Импорт завершён: добавлено {importResult.imported}, пропущено {importResult.skipped}</p>
          )}
          {importResult.errors.length > 0 && (
            <ul className="space-y-1 text-xs">
              {importResult.errors.map((e, i) => <li key={i}>{e}</li>)}
            </ul>
          )}
        </div>
      )}

      <div className="card mb-6">
        <div className="flex flex-wrap gap-4">
          <form onSubmit={handleSearch} className="flex-1 min-w-[200px] relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
            <input
              className="input pl-10"
              placeholder="Поиск по имени или телефону..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </form>
          <select
            className="input w-auto"
            value={projectFilter}
            onChange={(e) => { setProjectFilter(e.target.value); setPage(1); }}
          >
            <option value="">Все проекты</option>
            <option value="ZORGE9">Зорге 9</option>
            <option value="SILVER_BOR">Серебряный бор</option>
          </select>
          <select
            className="input w-auto"
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
          >
            <option value="">Все статусы</option>
            <option value="CONDITIONALLY_UNIQUE">Уникален</option>
            <option value="UNDER_REVIEW">На проверке</option>
            <option value="REJECTED">Отклонён</option>
            <option value="EXPIRED">Истёк</option>
          </select>
        </div>
      </div>

      <div className="card">
        {loading ? (
          <div className="text-center py-8 text-text-muted">Загрузка...</div>
        ) : clients.length === 0 ? (
          <div className="text-center py-8 text-text-muted">Клиенты не найдены</div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-text-muted text-left border-b border-border">
                    <th className="pb-3 font-medium">ФИО</th>
                    <th className="pb-3 font-medium">Телефон</th>
                    <th className="pb-3 font-medium">Проект</th>
                    <th className="pb-3 font-medium">Уникальность</th>
                    <th className="pb-3 font-medium">Фиксация</th>
                    <th className="pb-3 font-medium">Дата</th>
                  </tr>
                </thead>
                <tbody>
                  {clients.map((c: any) => (
                    <tr
                      key={c.id}
                      className="border-b border-border last:border-0 hover:bg-surface-secondary cursor-pointer transition"
                      onClick={() => setSelectedClient(c)}
                    >
                      <td className="py-3 font-medium">{c.fullName}</td>
                      <td className="py-3 text-text-muted">{c.phone}</td>
                      <td className="py-3">{projectLabels[c.project] || c.project}</td>
                      <td className="py-3">
                        <span className={`text-xs px-2 py-1 rounded ${statusLabels[c.uniquenessStatus]?.cls || ''}`}>
                          {statusLabels[c.uniquenessStatus]?.label || c.uniquenessStatus}
                        </span>
                      </td>
                      <td className="py-3">
                        <span className={fixationLabels[c.fixationStatus]?.cls || ''}>
                          {fixationLabels[c.fixationStatus]?.label || c.fixationStatus}
                        </span>
                      </td>
                      <td className="py-3 text-text-muted">
                        {new Date(c.createdAt).toLocaleDateString('ru-RU')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-4 pt-4 border-t border-border">
                <span className="text-sm text-text-muted">Стр. {page} из {totalPages}</span>
                <div className="flex gap-2">
                  <button
                    className="btn btn-secondary"
                    onClick={() => setPage(Math.max(1, page - 1))}
                    disabled={page === 1}
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <button
                    className="btn btn-secondary"
                    onClick={() => setPage(Math.min(totalPages, page + 1))}
                    disabled={page === totalPages}
                  >
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {selectedClient && <ClientDetail client={selectedClient} onClose={() => setSelectedClient(null)} />}
    </div>
  );
}
