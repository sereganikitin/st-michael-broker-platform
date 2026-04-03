'use client';

import { useEffect, useState } from 'react';
import { apiGet, apiPost } from '@/lib/api';
import { Building, RefreshCw, ChevronLeft, ChevronRight, X } from 'lucide-react';

const statusLabels: Record<string, { label: string; cls: string }> = {
  AVAILABLE: { label: 'Свободен', cls: 'bg-success/20 text-success' },
  BOOKED: { label: 'Бронь', cls: 'bg-warning/20 text-warning' },
  SOLD: { label: 'Продан', cls: 'bg-error/20 text-error' },
};

const projectLabels: Record<string, string> = {
  ZORGE9: 'Зорге 9',
  SILVER_BOR: 'Серебряный бор',
};

function LotDetail({ lot, onClose }: { lot: any; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-surface rounded-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto p-6 relative"
        onClick={(e) => e.stopPropagation()}
      >
        <button className="absolute top-4 right-4 text-text-muted hover:text-text" onClick={onClose}>
          <X className="w-5 h-5" />
        </button>

        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold">{lot.number}</h2>
          <span className={`text-xs px-2 py-1 rounded ${statusLabels[lot.status]?.cls || 'bg-text-muted/20'}`}>
            {statusLabels[lot.status]?.label || lot.status}
          </span>
        </div>

        {lot.propertyType && (
          <div className="text-sm text-accent mb-4">{lot.propertyType}</div>
        )}

        {lot.planImageUrl && (
          <div className="mb-6 bg-surface-secondary rounded-lg p-3">
            <img src={lot.planImageUrl} alt="Планировка" className="w-full rounded max-h-80 object-contain" />
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 text-sm mb-6">
          <div className="bg-surface-secondary rounded-lg p-3">
            <span className="text-text-muted block text-xs">Проект</span>
            <span className="font-medium">{projectLabels[lot.project] || lot.project}</span>
          </div>
          <div className="bg-surface-secondary rounded-lg p-3">
            <span className="text-text-muted block text-xs">Корпус</span>
            <span className="font-medium">{lot.building}</span>
          </div>
          <div className="bg-surface-secondary rounded-lg p-3">
            <span className="text-text-muted block text-xs">Этаж</span>
            <span className="font-medium">{lot.floor}{lot.floorsTotal ? ` / ${lot.floorsTotal}` : ''}</span>
          </div>
          <div className="bg-surface-secondary rounded-lg p-3">
            <span className="text-text-muted block text-xs">Комнат</span>
            <span className="font-medium">{lot.rooms}</span>
          </div>
          <div className="bg-surface-secondary rounded-lg p-3">
            <span className="text-text-muted block text-xs">Площадь</span>
            <span className="font-medium">{Number(lot.sqm)} м²</span>
          </div>
          {lot.buildingSection && (
            <div className="bg-surface-secondary rounded-lg p-3">
              <span className="text-text-muted block text-xs">Секция</span>
              <span className="font-medium">{lot.buildingSection}</span>
            </div>
          )}
          {lot.windowView && (
            <div className="bg-surface-secondary rounded-lg p-3 col-span-2">
              <span className="text-text-muted block text-xs">Вид из окна</span>
              <span className="font-medium">{lot.windowView}</span>
            </div>
          )}
        </div>

        <div className="bg-surface-secondary rounded-lg p-4">
          <div className="flex justify-between items-center mb-2">
            <span className="text-text-muted">Стоимость</span>
            <span className="text-2xl font-bold text-accent">{Number(lot.price).toLocaleString('ru-RU')} ₽</span>
          </div>
          {Number(lot.pricePerSqm) > 0 && (
            <div className="flex justify-between items-center">
              <span className="text-text-muted text-sm">Цена за м²</span>
              <span className="text-sm">{Number(lot.pricePerSqm).toLocaleString('ru-RU')} ₽/м²</span>
            </div>
          )}
        </div>

        {lot.description && (
          <div className="mt-4 text-sm text-text-muted">
            <span className="block text-xs mb-1">Описание</span>
            {lot.description}
          </div>
        )}
      </div>
    </div>
  );
}

export default function CatalogPage() {
  const [lots, setLots] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [projectFilter, setProjectFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [roomsFilter, setRoomsFilter] = useState('');
  const [propertyTypeFilter, setPropertyTypeFilter] = useState('');
  const [propertyTypes, setPropertyTypes] = useState<{ type: string; count: number }[]>([]);
  const [projects, setProjects] = useState<{ project: string; count: number }[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<{ created: number; updated: number; total: number } | null>(null);
  const [selectedLot, setSelectedLot] = useState<any>(null);

  const fetchLots = () => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), limit: '18' });
    if (projectFilter) params.set('project', projectFilter);
    if (statusFilter) params.set('status', statusFilter);
    if (roomsFilter) params.set('rooms', roomsFilter);
    if (propertyTypeFilter) params.set('propertyType', propertyTypeFilter);
    apiGet(`/lots?${params}`)
      .then((data) => {
        setLots(data.lots || []);
        setTotal(data.total || 0);
        setTotalPages(data.totalPages || 1);
        if (data.filters?.propertyTypes) setPropertyTypes(data.filters.propertyTypes);
        if (data.filters?.projects) setProjects(data.filters.projects);
      })
      .catch(() => setLots([]))
      .finally(() => setLoading(false));
  };

  const handleSync = async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const data = await apiPost('/lots/sync', {});
      setSyncResult(data);
      setPage(1);
      fetchLots();
    } catch (e: any) {
      alert(e.message || 'Ошибка синхронизации');
    }
    setSyncing(false);
  };

  useEffect(() => { fetchLots(); }, [page, projectFilter, statusFilter, roomsFilter, propertyTypeFilter]);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold">Каталог</h1>
          <span className="text-text-muted text-sm">Всего лотов: {total}</span>
        </div>
        <button className="btn btn-secondary flex items-center gap-2" onClick={handleSync} disabled={syncing}>
          <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
          {syncing ? 'Загрузка...' : 'Обновить из фида'}
        </button>
      </div>

      {syncResult && (
        <div className="mb-4 p-4 rounded-lg bg-success/20 text-success text-sm">
          Синхронизация: добавлено {syncResult.created}, обновлено {syncResult.updated}, всего в фиде {syncResult.total}
        </div>
      )}

      <div className="card mb-6">
        <div className="flex flex-wrap gap-4">
          <select className="input w-auto" value={projectFilter} onChange={(e) => { setProjectFilter(e.target.value); setPage(1); }}>
            <option value="">Все проекты</option>
            {projects.map((p) => (
              <option key={p.project} value={p.project}>
                {projectLabels[p.project] || p.project} ({p.count})
              </option>
            ))}
          </select>

          <select className="input w-auto" value={propertyTypeFilter} onChange={(e) => { setPropertyTypeFilter(e.target.value); setPage(1); }}>
            <option value="">Все типы</option>
            {propertyTypes.map((pt) => (
              <option key={pt.type} value={pt.type!}>
                {pt.type} ({pt.count})
              </option>
            ))}
          </select>

          <select className="input w-auto" value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}>
            <option value="">Все статусы</option>
            <option value="AVAILABLE">Свободен</option>
            <option value="BOOKED">Бронь</option>
          </select>

          <select className="input w-auto" value={roomsFilter} onChange={(e) => { setRoomsFilter(e.target.value); setPage(1); }}>
            <option value="">Все комнаты</option>
            <option value="Студия">Студия</option>
            <option value="1">1-комн.</option>
            <option value="2">2-комн.</option>
            <option value="3">3-комн.</option>
            <option value="4">4+ комн.</option>
          </select>
        </div>
      </div>

      <div className="card">
        {loading ? (
          <div className="text-center py-8 text-text-muted">Загрузка...</div>
        ) : lots.length === 0 ? (
          <div className="text-center py-12 text-text-muted">
            <Building className="w-12 h-12 mx-auto mb-3 text-text-muted/50" />
            <p>Лоты не найдены</p>
            <p className="text-sm mt-2">Нажмите "Обновить из фида" для загрузки каталога</p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {lots.map((lot: any) => (
                <div
                  key={lot.id}
                  className="p-4 bg-surface-secondary rounded-lg cursor-pointer hover:ring-2 hover:ring-accent/50 transition"
                  onClick={() => setSelectedLot(lot)}
                >
                  {lot.planImageUrl && (
                    <div className="mb-3 bg-surface rounded-lg p-2">
                      <img src={lot.planImageUrl} alt="Планировка" className="w-full rounded max-h-40 object-contain" />
                    </div>
                  )}
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="font-medium text-sm">{lot.number}</h3>
                    <span className={`text-xs px-2 py-1 rounded ${statusLabels[lot.status]?.cls || 'bg-text-muted/20'}`}>
                      {statusLabels[lot.status]?.label || lot.status}
                    </span>
                  </div>
                  {lot.propertyType && (
                    <div className="text-xs text-accent mb-2">{lot.propertyType}</div>
                  )}
                  <div className="space-y-1 text-sm">
                    <div className="flex justify-between">
                      <span className="text-text-muted">Проект:</span>
                      <span>{projectLabels[lot.project] || lot.project}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-text-muted">Корпус:</span>
                      <span className="text-right text-xs">{lot.building}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-text-muted">Этаж:</span>
                      <span>{lot.floor}{lot.floorsTotal ? ` / ${lot.floorsTotal}` : ''}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-text-muted">Комнат:</span>
                      <span>{lot.rooms}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-text-muted">Площадь:</span>
                      <span>{Number(lot.sqm)} м²</span>
                    </div>
                    <div className="flex justify-between pt-2 border-t border-border">
                      <span className="text-text-muted">Цена:</span>
                      <span className="font-bold text-accent">{Number(lot.price).toLocaleString('ru-RU')} ₽</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-6 pt-4 border-t border-border">
                <span className="text-sm text-text-muted">Стр. {page} из {totalPages}</span>
                <div className="flex gap-2">
                  <button className="btn btn-secondary" onClick={() => setPage(Math.max(1, page - 1))} disabled={page === 1}>
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <button className="btn btn-secondary" onClick={() => setPage(Math.min(totalPages, page + 1))} disabled={page === totalPages}>
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {selectedLot && <LotDetail lot={selectedLot} onClose={() => setSelectedLot(null)} />}
    </div>
  );
}
