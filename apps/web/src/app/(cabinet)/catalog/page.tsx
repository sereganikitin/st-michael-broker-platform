'use client';

import { useEffect, useState } from 'react';
import { apiGet } from '@/lib/api';
import { Building, Search } from 'lucide-react';

const statusLabels: Record<string, { label: string; cls: string }> = {
  AVAILABLE: { label: 'Свободен', cls: 'bg-success/20 text-success' },
  BOOKED: { label: 'Бронь', cls: 'bg-warning/20 text-warning' },
  SOLD: { label: 'Продан', cls: 'bg-error/20 text-error' },
};

export default function CatalogPage() {
  const [lots, setLots] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [projectFilter, setProjectFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [roomsFilter, setRoomsFilter] = useState('');

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (projectFilter) params.set('project', projectFilter);
    if (statusFilter) params.set('status', statusFilter);
    if (roomsFilter) params.set('rooms', roomsFilter);
    apiGet(`/lots?${params}`)
      .then((data) => setLots(Array.isArray(data) ? data : data.lots || []))
      .catch(() => setLots([]))
      .finally(() => setLoading(false));
  }, [projectFilter, statusFilter, roomsFilter]);

  return (
    <div>
      <h1 className="text-3xl font-bold mb-6">Каталог</h1>

      <div className="card mb-6">
        <div className="flex flex-wrap gap-4">
          <select className="input w-auto" value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)}>
            <option value="">Все проекты</option>
            <option value="ZORGE9">Зорге 9</option>
            <option value="SILVER_BOR">Серебряный бор</option>
          </select>
          <select className="input w-auto" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">Все статусы</option>
            <option value="AVAILABLE">Свободен</option>
            <option value="BOOKED">Бронь</option>
            <option value="SOLD">Продан</option>
          </select>
          <select className="input w-auto" value={roomsFilter} onChange={(e) => setRoomsFilter(e.target.value)}>
            <option value="">Все комнаты</option>
            <option value="studio">Студия</option>
            <option value="1">1-комн.</option>
            <option value="2">2-комн.</option>
            <option value="3">3-комн.</option>
            <option value="4+">4+ комн.</option>
          </select>
        </div>
      </div>

      <div className="card">
        {loading ? (
          <div className="text-center py-8 text-text-muted">Загрузка...</div>
        ) : lots.length === 0 ? (
          <div className="text-center py-8 text-text-muted">
            <Building className="w-12 h-12 mx-auto mb-3 text-text-muted/50" />
            Лоты не найдены
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {lots.map((lot: any) => (
              <div key={lot.id} className="p-4 bg-surface-secondary rounded-lg">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="font-medium">Лот {lot.number}</h3>
                  <span className={`text-xs px-2 py-1 rounded ${statusLabels[lot.status]?.cls || ''}`}>
                    {statusLabels[lot.status]?.label || lot.status}
                  </span>
                </div>
                <div className="space-y-1 text-sm">
                  <div className="flex justify-between">
                    <span className="text-text-muted">Проект:</span>
                    <span>{lot.project === 'ZORGE9' ? 'Зорге 9' : 'Серебряный бор'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-muted">Корпус / Этаж:</span>
                    <span>{lot.building} / {lot.floor}</span>
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
        )}
      </div>
    </div>
  );
}
