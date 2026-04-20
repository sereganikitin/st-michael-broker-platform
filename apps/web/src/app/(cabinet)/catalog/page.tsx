'use client';

import { useEffect, useMemo, useState } from 'react';
import { apiGet, apiPost } from '@/lib/api';
import { Building, RefreshCw, ChevronLeft, ChevronRight, X, SlidersHorizontal } from 'lucide-react';

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
      <div className="bg-surface rounded-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto p-6 relative" onClick={(e) => e.stopPropagation()}>
        <button className="absolute top-4 right-4 text-text-muted hover:text-text" onClick={onClose}>
          <X className="w-5 h-5" />
        </button>

        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold">{lot.number}</h2>
          <span className={`text-xs px-2 py-1 rounded ${statusLabels[lot.status]?.cls || 'bg-text-muted/20'}`}>
            {statusLabels[lot.status]?.label || lot.status}
          </span>
        </div>

        {lot.propertyType && <div className="text-sm text-accent mb-4">{lot.propertyType}</div>}

        {lot.planImageUrl && (
          <div className="mb-6 bg-surface-secondary rounded-lg p-3">
            <img src={lot.planImageUrl} alt="Планировка" className="w-full rounded max-h-80 object-contain" />
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 text-sm mb-6">
          <div className="bg-surface-secondary rounded-lg p-3"><span className="text-text-muted block text-xs">Проект</span><span className="font-medium">{projectLabels[lot.project] || lot.project}</span></div>
          <div className="bg-surface-secondary rounded-lg p-3"><span className="text-text-muted block text-xs">Корпус</span><span className="font-medium">{lot.building}</span></div>
          <div className="bg-surface-secondary rounded-lg p-3"><span className="text-text-muted block text-xs">Этаж</span><span className="font-medium">{lot.floor}{lot.floorsTotal ? ` / ${lot.floorsTotal}` : ''}</span></div>
          <div className="bg-surface-secondary rounded-lg p-3"><span className="text-text-muted block text-xs">Комнат</span><span className="font-medium">{lot.rooms}</span></div>
          <div className="bg-surface-secondary rounded-lg p-3"><span className="text-text-muted block text-xs">Площадь</span><span className="font-medium">{Number(lot.sqm)} м²</span></div>
          {lot.buildingSection && <div className="bg-surface-secondary rounded-lg p-3"><span className="text-text-muted block text-xs">Секция</span><span className="font-medium">{lot.buildingSection}</span></div>}
          {lot.builtYear && <div className="bg-surface-secondary rounded-lg p-3"><span className="text-text-muted block text-xs">Срок сдачи</span><span className="font-medium">{lot.readyQuarter ? `${lot.readyQuarter} кв. ` : ''}{lot.builtYear}</span></div>}
          {lot.windowView && <div className="bg-surface-secondary rounded-lg p-3 col-span-2"><span className="text-text-muted block text-xs">Вид из окна</span><span className="font-medium">{lot.windowView}</span></div>}
        </div>

        {(lot.hasBalcony || lot.hasTerrace || lot.isPenthouse) && (
          <div className="flex flex-wrap gap-2 mb-4">
            {lot.hasBalcony && <span className="text-xs px-2 py-1 rounded bg-accent/10 text-accent">Балкон</span>}
            {lot.hasTerrace && <span className="text-xs px-2 py-1 rounded bg-accent/10 text-accent">Терраса</span>}
            {lot.isPenthouse && <span className="text-xs px-2 py-1 rounded bg-accent/10 text-accent">Пентхаус</span>}
          </div>
        )}

        <div className="bg-surface-secondary rounded-lg p-4">
          {lot.discountPrice && Number(lot.discountPrice) > 0 ? (
            <>
              <div className="flex justify-between items-center mb-1">
                <span className="text-text-muted text-sm">Без скидки</span>
                <span className="text-sm text-text-muted line-through">{Math.round(Number(lot.price)).toLocaleString('ru-RU')} ₽</span>
              </div>
              <div className="flex justify-between items-center mb-2">
                <span className="text-text-muted">Со скидкой{lot.discountPercent ? ` (-${Number(lot.discountPercent)}%)` : ''}</span>
                <span className="text-2xl font-bold text-accent">{Math.round(Number(lot.discountPrice)).toLocaleString('ru-RU')} ₽</span>
              </div>
              {lot.discountName && <div className="text-xs text-accent mt-1">{lot.discountName}</div>}
            </>
          ) : (
            <div className="flex justify-between items-center mb-2">
              <span className="text-text-muted">Стоимость</span>
              <span className="text-2xl font-bold text-accent">{Math.round(Number(lot.price)).toLocaleString('ru-RU')} ₽</span>
            </div>
          )}
          {Number(lot.pricePerSqm) > 0 && (
            <div className="flex justify-between items-center">
              <span className="text-text-muted text-sm">Цена за м²</span>
              <span className="text-sm">{Math.round(Number(lot.pricePerSqm)).toLocaleString('ru-RU')} ₽/м²</span>
            </div>
          )}
        </div>
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

  // Filters
  const [projectFilter, setProjectFilter] = useState('');
  const [propertyTypeFilter, setPropertyTypeFilter] = useState('');
  const [roomsFilter, setRoomsFilter] = useState('');
  const [buildingFilter, setBuildingFilter] = useState('');
  const [viewFilter, setViewFilter] = useState('');
  const [yearFilter, setYearFilter] = useState('');
  const [priceMin, setPriceMin] = useState('');
  const [priceMax, setPriceMax] = useState('');
  const [sqmMin, setSqmMin] = useState('');
  const [sqmMax, setSqmMax] = useState('');
  const [floorMin, setFloorMin] = useState('');
  const [floorMax, setFloorMax] = useState('');
  const [hasBalcony, setHasBalcony] = useState(false);
  const [hasTerrace, setHasTerrace] = useState(false);
  const [isPenthouse, setIsPenthouse] = useState(false);

  // Filter options from API
  const [propertyTypes, setPropertyTypes] = useState<{ type: string; count: number }[]>([]);
  const [projects, setProjects] = useState<{ project: string; count: number }[]>([]);
  const [buildings, setBuildings] = useState<{ building: string; count: number }[]>([]);
  const [views, setViews] = useState<{ view: string; count: number }[]>([]);
  const [years, setYears] = useState<{ year: number; count: number }[]>([]);

  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<any>(null);
  const [selectedLot, setSelectedLot] = useState<any>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Reset building when project changes if it doesn't belong to the project
  useEffect(() => {
    setBuildingFilter('');
  }, [projectFilter]);

  const buildQuery = useMemo(() => {
    const p = new URLSearchParams({ page: String(page), limit: '18' });
    if (projectFilter) p.set('project', projectFilter);
    if (propertyTypeFilter) p.set('propertyType', propertyTypeFilter);
    if (roomsFilter) p.set('rooms', roomsFilter);
    if (buildingFilter) p.set('building', buildingFilter);
    if (viewFilter) p.set('windowView', viewFilter);
    if (yearFilter) p.set('readyYear', yearFilter);
    if (priceMin) p.set('priceMin', priceMin);
    if (priceMax) p.set('priceMax', priceMax);
    if (sqmMin) p.set('sqmMin', sqmMin);
    if (sqmMax) p.set('sqmMax', sqmMax);
    if (floorMin) p.set('floorMin', floorMin);
    if (floorMax) p.set('floorMax', floorMax);
    if (hasBalcony) p.set('hasBalcony', '1');
    if (hasTerrace) p.set('hasTerrace', '1');
    if (isPenthouse) p.set('isPenthouse', '1');
    return p.toString();
  }, [page, projectFilter, propertyTypeFilter, roomsFilter, buildingFilter, viewFilter, yearFilter,
      priceMin, priceMax, sqmMin, sqmMax, floorMin, floorMax, hasBalcony, hasTerrace, isPenthouse]);

  const fetchLots = () => {
    setLoading(true);
    apiGet(`/lots?${buildQuery}`)
      .then((data) => {
        setLots(data.lots || []);
        setTotal(data.total || 0);
        setTotalPages(data.totalPages || 1);
        if (data.filters?.propertyTypes) setPropertyTypes(data.filters.propertyTypes);
        if (data.filters?.projects) setProjects(data.filters.projects);
        if (data.filters?.buildings) setBuildings(data.filters.buildings);
        if (data.filters?.views) setViews(data.filters.views);
        if (data.filters?.years) setYears(data.filters.years);
      })
      .catch(() => setLots([]))
      .finally(() => setLoading(false));
  };

  const handleSync = async () => {
    setSyncing(true); setSyncResult(null);
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

  useEffect(() => { fetchLots(); }, [buildQuery]);

  const resetFilters = () => {
    setProjectFilter(''); setPropertyTypeFilter(''); setRoomsFilter('');
    setBuildingFilter(''); setViewFilter(''); setYearFilter('');
    setPriceMin(''); setPriceMax(''); setSqmMin(''); setSqmMax('');
    setFloorMin(''); setFloorMax('');
    setHasBalcony(false); setHasTerrace(false); setIsPenthouse(false);
    setPage(1);
  };

  const activeFiltersCount = [
    projectFilter, propertyTypeFilter, roomsFilter, buildingFilter, viewFilter, yearFilter,
    priceMin, priceMax, sqmMin, sqmMax, floorMin, floorMax,
    hasBalcony, hasTerrace, isPenthouse,
  ].filter(Boolean).length;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold">Подбор квартир</h1>
          <span className="text-text-muted text-sm">Всего найдено: {total}</span>
        </div>
        <button
          className="btn btn-secondary p-2"
          onClick={handleSync}
          disabled={syncing}
          title="Обновить каталог"
          aria-label="Обновить каталог"
        >
          <RefreshCw className={`w-5 h-5 ${syncing ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {syncResult && (
        <div className="mb-4 p-4 rounded-lg bg-success/20 text-success text-sm">
          Синхронизация: добавлено {syncResult.created}, обновлено {syncResult.updated}, всего {syncResult.total}
        </div>
      )}

      {/* Filters */}
      <div className="card mb-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2 font-medium"><SlidersHorizontal className="w-4 h-4" />Фильтры{activeFiltersCount > 0 && <span className="text-xs bg-accent text-background px-2 py-0.5 rounded-full">{activeFiltersCount}</span>}</div>
          <div className="flex gap-2">
            {activeFiltersCount > 0 && (
              <button className="btn btn-secondary text-xs" onClick={resetFilters}>Сбросить</button>
            )}
            <button className="btn btn-secondary text-xs" onClick={() => setShowAdvanced(!showAdvanced)}>
              {showAdvanced ? 'Скрыть доп.' : 'Дополнительно'}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
          <div>
            <label className="text-xs text-text-muted block mb-1">Проект</label>
            <select className="input" value={projectFilter} onChange={(e) => { setProjectFilter(e.target.value); setPage(1); }}>
              <option value="">Все проекты</option>
              {projects.map((p) => <option key={p.project} value={p.project}>{projectLabels[p.project] || p.project} ({p.count})</option>)}
            </select>
          </div>

          <div>
            <label className="text-xs text-text-muted block mb-1">Тип</label>
            <select className="input" value={propertyTypeFilter} onChange={(e) => { setPropertyTypeFilter(e.target.value); setPage(1); }}>
              <option value="">Все типы</option>
              {propertyTypes.map((pt) => <option key={pt.type} value={pt.type!}>{pt.type} ({pt.count})</option>)}
            </select>
          </div>

          <div>
            <label className="text-xs text-text-muted block mb-1">Комнатность</label>
            <select className="input" value={roomsFilter} onChange={(e) => { setRoomsFilter(e.target.value); setPage(1); }}>
              <option value="">Любая</option>
              <option value="Студия">Студия</option>
              <option value="1">1-комн.</option>
              <option value="2">2-комн.</option>
              <option value="3">3-комн.</option>
              <option value="4">4+ комн.</option>
            </select>
          </div>

          <div>
            <label className="text-xs text-text-muted block mb-1">Корпус</label>
            <select className="input" value={buildingFilter} onChange={(e) => { setBuildingFilter(e.target.value); setPage(1); }}>
              <option value="">Все корпуса</option>
              {buildings.map((b) => <option key={b.building} value={b.building}>{b.building} ({b.count})</option>)}
            </select>
          </div>

          <div>
            <label className="text-xs text-text-muted block mb-1">Площадь, м²</label>
            <div className="flex gap-2">
              <input type="number" className="input" placeholder="от" value={sqmMin} onChange={(e) => { setSqmMin(e.target.value); setPage(1); }} />
              <input type="number" className="input" placeholder="до" value={sqmMax} onChange={(e) => { setSqmMax(e.target.value); setPage(1); }} />
            </div>
          </div>

          <div>
            <label className="text-xs text-text-muted block mb-1">Цена, ₽</label>
            <div className="flex gap-2">
              <input type="number" className="input" placeholder="от" value={priceMin} onChange={(e) => { setPriceMin(e.target.value); setPage(1); }} />
              <input type="number" className="input" placeholder="до" value={priceMax} onChange={(e) => { setPriceMax(e.target.value); setPage(1); }} />
            </div>
          </div>

          <div>
            <label className="text-xs text-text-muted block mb-1">Этаж</label>
            <div className="flex gap-2">
              <input type="number" className="input" placeholder="от" value={floorMin} onChange={(e) => { setFloorMin(e.target.value); setPage(1); }} />
              <input type="number" className="input" placeholder="до" value={floorMax} onChange={(e) => { setFloorMax(e.target.value); setPage(1); }} />
            </div>
          </div>

          <div>
            <label className="text-xs text-text-muted block mb-1">Срок сдачи</label>
            <select className="input" value={yearFilter} onChange={(e) => { setYearFilter(e.target.value); setPage(1); }}>
              <option value="">Любой</option>
              {years.map((y) => <option key={y.year} value={y.year}>{y.year} ({y.count})</option>)}
            </select>
          </div>
        </div>

        {showAdvanced && (
          <div className="mt-4 pt-4 border-t border-border">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-text-muted block mb-1">Вид из окна</label>
                <select className="input" value={viewFilter} onChange={(e) => { setViewFilter(e.target.value); setPage(1); }}>
                  <option value="">Любой</option>
                  {views.map((v) => <option key={v.view} value={v.view}>{v.view} ({v.count})</option>)}
                </select>
              </div>
              <div className="flex flex-wrap items-center gap-4 pt-4 md:pt-0">
                <label className="flex items-center gap-2 cursor-pointer text-sm">
                  <input type="checkbox" checked={hasBalcony} onChange={(e) => { setHasBalcony(e.target.checked); setPage(1); }} />
                  Балкон / лоджия
                </label>
                <label className="flex items-center gap-2 cursor-pointer text-sm">
                  <input type="checkbox" checked={hasTerrace} onChange={(e) => { setHasTerrace(e.target.checked); setPage(1); }} />
                  Терраса
                </label>
                <label className="flex items-center gap-2 cursor-pointer text-sm">
                  <input type="checkbox" checked={isPenthouse} onChange={(e) => { setIsPenthouse(e.target.checked); setPage(1); }} />
                  Пентхаус
                </label>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="card">
        {loading ? (
          <div className="text-center py-8 text-text-muted">Загрузка...</div>
        ) : lots.length === 0 ? (
          <div className="text-center py-12 text-text-muted">
            <Building className="w-12 h-12 mx-auto mb-3 text-text-muted/50" />
            <p>Лоты не найдены</p>
            <p className="text-sm mt-2">Попробуйте изменить фильтры</p>
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
                  {lot.propertyType && <div className="text-xs text-accent mb-2">{lot.propertyType}</div>}
                  <div className="space-y-1 text-sm">
                    <div className="flex justify-between"><span className="text-text-muted">Проект:</span><span>{projectLabels[lot.project] || lot.project}</span></div>
                    <div className="flex justify-between"><span className="text-text-muted">Корпус:</span><span className="text-right text-xs">{lot.building}</span></div>
                    <div className="flex justify-between"><span className="text-text-muted">Этаж:</span><span>{lot.floor}{lot.floorsTotal ? ` / ${lot.floorsTotal}` : ''}</span></div>
                    <div className="flex justify-between"><span className="text-text-muted">Комнат:</span><span>{lot.rooms}</span></div>
                    <div className="flex justify-between"><span className="text-text-muted">Площадь:</span><span>{Number(lot.sqm)} м²</span></div>
                    {lot.builtYear && (
                      <div className="flex justify-between"><span className="text-text-muted">Сдача:</span><span className="text-xs">{lot.readyQuarter ? `${lot.readyQuarter}кв. ` : ''}{lot.builtYear}</span></div>
                    )}
                    {lot.discountPrice && Number(lot.discountPrice) > 0 ? (
                      <div className="pt-2 border-t border-border">
                        <div className="flex justify-between items-center">
                          <span className="text-text-muted text-xs">Без скидки:</span>
                          <span className="text-xs text-text-muted line-through">{Math.round(Number(lot.price)).toLocaleString('ru-RU')} ₽</span>
                        </div>
                        <div className="flex justify-between items-center mt-0.5">
                          <span className="text-text-muted text-xs">Со скидкой{lot.discountPercent ? ` -${Number(lot.discountPercent)}%` : ''}:</span>
                          <span className="font-bold text-accent">{Math.round(Number(lot.discountPrice)).toLocaleString('ru-RU')} ₽</span>
                        </div>
                      </div>
                    ) : (
                      <div className="flex justify-between pt-2 border-t border-border"><span className="text-text-muted">Цена:</span><span className="font-bold text-accent">{Math.round(Number(lot.price)).toLocaleString('ru-RU')} ₽</span></div>
                    )}
                  </div>
                  {(lot.hasBalcony || lot.hasTerrace || lot.isPenthouse) && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {lot.hasBalcony && <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent">Балкон</span>}
                      {lot.hasTerrace && <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent">Терраса</span>}
                      {lot.isPenthouse && <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent">Пентхаус</span>}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-6 pt-4 border-t border-border">
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

      {selectedLot && <LotDetail lot={selectedLot} onClose={() => setSelectedLot(null)} />}
    </div>
  );
}
