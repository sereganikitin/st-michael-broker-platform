'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { AlertCircle, CheckCircle2, Loader2, Search } from 'lucide-react';
import { apiGet, apiPost } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { getLoyaltyList, type LoyaltyRecord } from '@/lib/loyalty-base-api';

type PartnerKind = 'АН' | 'Ключевой' | 'Частный';
type PartnerList = 'SOLD_2026' | 'SLEEPING';
type MatchStatus = 'AUTO' | 'MANUAL' | 'AMBIGUOUS' | 'UNMATCHED' | 'SKIPPED';

interface OverlayRow {
  partner: {
    key: string;
    name: string;
    kind: PartnerKind;
    list: PartnerList;
    dduCount: number;
    soldMln: number;
    priority: 'A' | 'B' | 'C';
    rate: string | null;
    nextTier: string | null;
    lastDdu: string | null;
    offer: string | null;
    pitch: string;
  };
  match: {
    status: MatchStatus;
    entityType: 'AGENCY' | 'BROKER' | null;
    entityId: string | null;
    entityName: string | null;
    candidates: Array<{ id: string; entityType: 'AGENCY' | 'BROKER'; name: string }>;
    source: 'SAVED' | 'SUGGESTED';
  };
}

interface OverlayResponse {
  source: {
    status: 'UNCONFIRMED';
    accuracy: 'UNKNOWN';
    periodApplied: false;
    provenance: 'ANNA_LEGACY_WORD';
    documentName: string;
    note: string;
    declared: { soldPartners: number; dduCount: number; soldMln: number };
    extracted: { soldPartners: number; dduCount: number; soldMln: number };
    discrepancy: { soldPartners: number; dduCount: number; soldMln: number };
  };
  program: { from: string; until: string; note: string };
  counts: {
    sold: number;
    sleeping: number;
    auto: number;
    manual: number;
    ambiguous: number;
    unmatched: number;
  };
  rows: OverlayRow[];
}

const statusLabel: Record<MatchStatus, { label: string; cls: string }> = {
  AUTO: { label: 'Связано', cls: 'bg-success/20 text-success' },
  MANUAL: { label: 'Вручную', cls: 'bg-info/20 text-info' },
  AMBIGUOUS: { label: 'Уточнить', cls: 'bg-warning/20 text-warning' },
  UNMATCHED: { label: 'Нет карточки', cls: 'bg-error/20 text-error' },
  SKIPPED: { label: 'Пропущено', cls: 'bg-text-muted/20 text-text-muted' },
};

function formatMln(value: number) {
  return `${value.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} млн ₽`;
}

export default function LoyaltyProgramPage() {
  const { broker } = useAuth();
  const isStaff = broker?.role === 'ADMIN' || broker?.role === 'MANAGER';
  const [list, setList] = useState<PartnerList>('SOLD_2026');
  const [data, setData] = useState<OverlayResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [pickerKey, setPickerKey] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<LoyaltyRecord[]>([]);
  const [searching, setSearching] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await apiGet<OverlayResponse>(`/loyalty-program/2026?list=${list}`);
      setData(next);
    } catch (err: any) {
      setError(err?.message || 'Не удалось загрузить программу');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [list]);

  useEffect(() => {
    if (isStaff) void load();
  }, [isStaff, load]);

  const rows = data?.rows || [];
  const openRow = useMemo(
    () => rows.find((row) => row.partner.key === pickerKey) || null,
    [rows, pickerKey],
  );

  useEffect(() => {
    if (!pickerKey) {
      setHits([]);
      setQuery('');
      return;
    }
    const seed = openRow?.partner.name || '';
    setQuery(seed);
  }, [pickerKey, openRow?.partner.name]);

  useEffect(() => {
    if (!pickerKey) return;
    const handle = window.setTimeout(async () => {
      setSearching(true);
      try {
        const result = await getLoyaltyList('anna', 'agencies', {
          search: query.trim(),
          page: 1,
          pageSize: 8,
        });
        setHits(result.items || []);
      } catch {
        setHits([]);
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => window.clearTimeout(handle);
  }, [pickerKey, query]);

  async function decide(partnerKey: string, body: Record<string, string>) {
    setBusyKey(partnerKey);
    try {
      await apiPost('/loyalty-program/2026/matches', { partnerKey, ...body });
      setPickerKey(null);
      await load();
    } catch (err: any) {
      setError(err?.message || 'Не удалось сохранить связь');
    } finally {
      setBusyKey(null);
    }
  }

  if (broker && !isStaff) {
    return (
      <div className="p-6">
        <h1 className="text-xl font-semibold mb-2">Программа 2026</h1>
        <p className="text-sm text-text-muted">Раздел только для сотрудников КЦ и администраторов.</p>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Программа лояльности 2026</h1>
        <p className="text-sm text-text-muted mt-1 max-w-3xl">
          Список из Word клеим на карточки агентств Анны. Это справочник для звонков,
          не колонка «Сделки». Считаем продажи с 1 января 2026, условия до 31 января 2027.
        </p>
      </div>

      {data && (
        <div className="rounded-xl border border-warning/40 bg-warning/10 p-4 text-sm space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">Срез Word — НЕ ПОДТВЕРЖДЕНО</span>
            <span className="rounded-full bg-warning/20 px-2 py-0.5 text-xs">
              точность {data.source.accuracy}
            </span>
            <span className="rounded-full bg-warning/20 px-2 py-0.5 text-xs">
              период не применён
            </span>
          </div>
          <p>{data.source.note}</p>
          <p className="text-text-muted">
            В строках файла: {data.source.extracted.soldPartners} партнёров,{' '}
            {data.source.extracted.dduCount} ДДУ, {formatMln(data.source.extracted.soldMln)}.
            В заголовке файла: {data.source.declared.soldPartners} партнёра,{' '}
            {data.source.declared.dduCount} ДДУ, {formatMln(data.source.declared.soldMln)}.
            Отсутствующая строка не найдена и не добавлена.
          </p>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setList('SOLD_2026')}
          className={`px-3 py-1.5 rounded text-sm ${list === 'SOLD_2026' ? 'bg-accent text-white' : 'bg-surface-secondary'}`}
        >
          Продали в 2026
        </button>
        <button
          type="button"
          onClick={() => setList('SLEEPING')}
          className={`px-3 py-1.5 rounded text-sm ${list === 'SLEEPING' ? 'bg-accent text-white' : 'bg-surface-secondary'}`}
        >
          Спящие · не рабочий набор
        </button>
      </div>

      {data && list === 'SOLD_2026' && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-sm">
          <Kpi label="Партнёров" value={data.counts.sold} />
          <Kpi label="Связано" value={data.counts.auto + data.counts.manual} />
          <Kpi label="Уточнить" value={data.counts.ambiguous} />
          <Kpi label="Нет карточки" value={data.counts.unmatched} />
          <Kpi label="Спящих в Word" value={data.counts.sleeping} />
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 text-sm text-error bg-error/10 rounded p-3">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-text-muted text-sm">
          <Loader2 className="w-4 h-4 animate-spin" /> Загружаем карточки Анны…
        </div>
      ) : rows.length === 0 ? (
        <p className="text-sm text-text-muted">В этом списке никого нет.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="min-w-full text-sm">
            <thead className="bg-surface-secondary text-left text-text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Партнёр</th>
                <th className="px-3 py-2 font-medium">ДДУ / сумма</th>
                <th className="px-3 py-2 font-medium">Карточка Анны</th>
                <th className="px-3 py-2 font-medium">Посыл</th>
                <th className="px-3 py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const badge = statusLabel[row.match.status];
                return (
                  <tr key={row.partner.key} className="border-t border-border align-top">
                    <td className="px-3 py-3">
                      <div className="font-medium">{row.partner.name}</div>
                      <div className="text-xs text-text-muted mt-0.5">
                        {row.partner.kind} · приоритет {row.partner.priority}
                        {row.partner.rate ? ` · доплата ${row.partner.rate}` : ''}
                      </div>
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap">
                      <div>{row.partner.dduCount} ДДУ</div>
                      <div className="text-xs text-text-muted">{formatMln(row.partner.soldMln)}</div>
                    </td>
                    <td className="px-3 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded ${badge.cls}`}>{badge.label}</span>
                      {row.match.entityName && (
                        <div className="mt-1">
                          <Link
                            href={`/admin/loyalty-base/anna/${row.match.entityType === 'BROKER' ? 'brokers' : 'agencies'}/${row.match.entityId}`}
                            className="text-accent hover:underline"
                          >
                            {row.match.entityName}
                          </Link>
                        </div>
                      )}
                      {row.match.status === 'AMBIGUOUS' && row.match.candidates.length > 0 && (
                        <div className="mt-2 space-y-1">
                          {row.match.candidates.map((candidate) => (
                            <button
                              key={candidate.id}
                              type="button"
                              disabled={busyKey === row.partner.key}
                              onClick={() =>
                                decide(row.partner.key, {
                                  [candidate.entityType === 'AGENCY' ? 'organizationId' : 'personId']:
                                    candidate.id,
                                })
                              }
                              className="block text-left text-xs text-accent hover:underline"
                            >
                              Это {candidate.name}
                            </button>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-3 text-xs text-text-muted max-w-sm">
                      {row.partner.pitch}
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap">
                      <button
                        type="button"
                        className="text-xs text-accent hover:underline"
                        onClick={() => setPickerKey(row.partner.key)}
                      >
                        Выбрать карточку
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {pickerKey && openRow && (
        <div
          className="fixed inset-0 bg-black/50 z-50 flex items-end md:items-center justify-center p-4"
          onClick={() => setPickerKey(null)}
        >
          <div
            className="bg-surface rounded-xl w-full max-w-lg p-4 space-y-3"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="font-semibold">Привязать «{openRow.partner.name}»</h2>
            <p className="text-xs text-text-muted">
              Ищем в агентствах Анны по имени и алиасам. Если карточек несколько — выберите одну.
            </p>
            <label className="flex items-center gap-2 bg-surface-secondary rounded px-3 py-2">
              <Search className="w-4 h-4 text-text-muted" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="bg-transparent w-full outline-none text-sm"
                placeholder="Имя агентства"
              />
            </label>
            {searching ? (
              <div className="text-xs text-text-muted flex items-center gap-2">
                <Loader2 className="w-3 h-3 animate-spin" /> Ищем…
              </div>
            ) : hits.length === 0 ? (
              <p className="text-sm text-text-muted">Ничего не нашли. Можно оставить без связи.</p>
            ) : (
              <ul className="divide-y divide-border max-h-64 overflow-y-auto">
                {hits.map((hit) => (
                  <li key={hit.id}>
                    <button
                      type="button"
                      className="w-full text-left py-2 hover:bg-surface-secondary px-1"
                      onClick={() => decide(openRow.partner.key, { organizationId: hit.id })}
                    >
                      <div className="text-sm font-medium">{hit.name}</div>
                      <div className="text-xs text-text-muted">
                        {hit.company || hit.aliases.slice(0, 3).join(' · ') || 'агентство Анны'}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex justify-between pt-1">
              <button
                type="button"
                className="text-xs text-text-muted hover:underline"
                onClick={() => decide(openRow.partner.key, { status: 'SKIPPED' })}
              >
                Пропустить
              </button>
              <button
                type="button"
                className="text-sm"
                onClick={() => setPickerKey(null)}
              >
                Закрыть
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-surface-secondary rounded-lg p-3">
      <div className="text-xs text-text-muted">{label}</div>
      <div className="text-lg font-semibold flex items-center gap-1">
        {label === 'Связано' && <CheckCircle2 className="w-4 h-4 text-success" />}
        {value}
      </div>
    </div>
  );
}
