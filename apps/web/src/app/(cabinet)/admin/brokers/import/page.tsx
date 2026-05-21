'use client';

import { useState } from 'react';
import Link from 'next/link';
import { apiUpload } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { ArrowLeft, Upload, FileSpreadsheet, AlertCircle, CheckCircle2 } from 'lucide-react';

type DryRunResult = {
  dryRun: true;
  stats: {
    total: number;
    invalidPhone: number;
    duplicatesInSheet: number;
    afterFilter: number;
    wouldCreate: number;
    wouldUpdate: number;
    wouldCreateCallLogs: number;
    coordRows: number;
    byCategory: Record<string, number>;
    byCallFlag: Record<string, number>;
  };
  preview: Array<{ phone: string; name: string; category: string; resultStr: string; zorgeStr: string }>;
};

type RealResult = {
  dryRun: false;
  stats: { total: number; invalidPhone: number; duplicatesInSheet: number; afterFilter: number; coordRows: number };
  dbStats: { created: number; updated: number; callLogsCreated: number; errors: number; coordCreated: number; coordUpdated: number };
  errors: Array<{ phone: string; error: string }>;
};

type ImportResult = DryRunResult | RealResult;

export default function AdminBrokersImportPage() {
  const { broker } = useAuth();

  if (broker && broker.role !== 'ADMIN') {
    return (
      <div className="card">
        <h2 className="text-xl font-bold mb-2">Доступ запрещён</h2>
        <p className="text-text-muted text-sm">Импорт базы брокеров доступен только администраторам.</p>
      </div>
    );
  }

  const [file, setFile] = useState<File | null>(null);
  const [filter, setFilter] = useState('ALL');
  const [callFlag, setCallFlag] = useState('да');
  const [limit, setLimit] = useState('');
  const [dryRun, setDryRun] = useState(true);
  const [includeCoords, setIncludeCoords] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) {
      setError('Сначала выбери xlsx-файл');
      return;
    }
    if (!dryRun) {
      const ok = confirm(
        `РЕАЛЬНЫЙ ИМПОРТ в БД.\n\nФайл: ${file.name}\nФильтр: ${filter}\nЗВОНОК: ${callFlag || '(все)'}\nLimit: ${limit || '(нет)'}\n\nПродолжить?`,
      );
      if (!ok) return;
    }

    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('filter', filter);
      if (callFlag) fd.append('callFlag', callFlag);
      if (limit) fd.append('limit', limit);
      fd.append('dryRun', String(dryRun));
      fd.append('includeCoords', String(includeCoords));
      const r = await apiUpload<ImportResult>('/admin/brokers/import-from-xlsx', fd);
      setResult(r);
    } catch (e: any) {
      setError(e?.message || 'Ошибка импорта');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/admin/brokers" className="btn btn-secondary flex items-center gap-2">
          <ArrowLeft className="w-4 h-4" /> Назад
        </Link>
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <FileSpreadsheet className="w-7 h-7 text-accent" />
          Импорт брокеров из xlsx
        </h1>
      </div>

      <div className="card text-sm text-text-muted space-y-1">
        <p>Источник — экспорт Google-таблицы колл-центра (Файл → Скачать → Microsoft Excel).</p>
        <p>Скрипт идемпотентен по полю <code>phone</code> (upsert) — повторный реальный запуск не плодит дубликатов брокеров.</p>
        <p className="text-warning">⚠️ Но <code>CallLog</code> добавляется при каждом реальном запуске. Не запускай дважды подряд без необходимости.</p>
      </div>

      <form onSubmit={handleSubmit} className="card space-y-4">
        <div>
          <label className="block text-sm font-medium mb-2">XLSX-файл</label>
          <input
            type="file"
            accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
            className="input"
            required
          />
          {file && <p className="text-xs text-text-muted mt-1">Выбран: {file.name} ({Math.round(file.size / 1024)} КБ)</p>}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium mb-2">Категории (BrokerCategory)</label>
            <select className="input" value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="ALL">ALL — все категории</option>
              <option value="COLD">COLD — НДЗ, новый</option>
              <option value="WARM">WARM — проинформирован</option>
              <option value="HOT">HOT — запись на БТ / в работе</option>
              <option value="CONVERTED">CONVERTED — был на встрече / сделке</option>
              <option value="ON_BOT_REVIEW">ON_BOT_REVIEW — 2НДЗ / отказ от связи</option>
              <option value="BLACKLIST">BLACKLIST — не брокер / неверный номер</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">Фильтр по ЗВОНОК (col F)</label>
            <select className="input" value={callFlag} onChange={(e) => setCallFlag(e.target.value)}>
              <option value="">Без фильтра</option>
              <option value="да">да — звонок завершён</option>
              <option value="в работе">в работе</option>
              <option value="обработан">обработан</option>
              <option value="да,обработан">да + обработан</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">Limit (для тестов)</label>
            <input
              className="input"
              type="number"
              placeholder="пусто = без лимита"
              min={1}
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-3 justify-end">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
              <span className="text-sm">Dry-run — ничего не пишет, только показывает план (Recommended на первый запуск)</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={includeCoords} onChange={(e) => setIncludeCoords(e.target.checked)} />
              <span className="text-sm">Импортировать также лист координаторов (если есть)</span>
            </label>
          </div>
        </div>

        <button type="submit" disabled={loading || !file} className="btn btn-primary flex items-center gap-2">
          <Upload className={`w-4 h-4 ${loading ? 'animate-pulse' : ''}`} />
          {loading ? 'Обработка…' : dryRun ? 'Проверить (dry-run)' : 'РЕАЛЬНЫЙ ИМПОРТ'}
        </button>
      </form>

      {error && (
        <div className="card bg-error/10 border-error/30 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-error mt-0.5" />
          <div>
            <p className="font-medium text-error">Ошибка</p>
            <p className="text-sm text-text-muted">{error}</p>
          </div>
        </div>
      )}

      {result && (
        <div className="card space-y-4">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-6 h-6 text-success" />
            <h2 className="text-xl font-bold">
              {result.dryRun ? 'Результат проверки (dry-run)' : 'Импорт завершён'}
            </h2>
          </div>

          <div>
            <h3 className="text-sm font-medium text-text-muted mb-2">Статистика обхода</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              <div className="bg-surface-secondary p-3 rounded"><div className="text-text-muted">Всего строк</div><div className="text-lg font-bold">{result.stats.total}</div></div>
              <div className="bg-surface-secondary p-3 rounded"><div className="text-text-muted">Невалидный телефон</div><div className="text-lg font-bold">{result.stats.invalidPhone}</div></div>
              <div className="bg-surface-secondary p-3 rounded"><div className="text-text-muted">Дубли в листе</div><div className="text-lg font-bold">{result.stats.duplicatesInSheet}</div></div>
              <div className="bg-surface-secondary p-3 rounded"><div className="text-text-muted">Под фильтр</div><div className="text-lg font-bold text-accent">{result.stats.afterFilter}</div></div>
            </div>
          </div>

          {result.dryRun && (
            <>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
                <div className="bg-info/10 p-3 rounded">
                  <div className="text-text-muted">Будет создано</div>
                  <div className="text-2xl font-bold text-info">{result.stats.wouldCreate}</div>
                </div>
                <div className="bg-warning/10 p-3 rounded">
                  <div className="text-text-muted">Будет обновлено</div>
                  <div className="text-2xl font-bold text-warning">{result.stats.wouldUpdate}</div>
                </div>
                <div className="bg-success/10 p-3 rounded">
                  <div className="text-text-muted">Новых CallLog</div>
                  <div className="text-2xl font-bold text-success">{result.stats.wouldCreateCallLogs}</div>
                </div>
              </div>

              <div>
                <h3 className="text-sm font-medium text-text-muted mb-2">Категории (после нормализации телефона)</h3>
                <div className="text-sm space-y-1">
                  {Object.entries(result.stats.byCategory).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
                    <div key={k} className="flex justify-between border-b border-border py-1">
                      <span>{k}</span><span className="font-mono">{v}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <h3 className="text-sm font-medium text-text-muted mb-2">Распределение по ЗВОНОК (col F)</h3>
                <div className="text-sm space-y-1">
                  {Object.entries(result.stats.byCallFlag).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
                    <div key={k} className="flex justify-between border-b border-border py-1">
                      <span>{k}</span><span className="font-mono">{v}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <h3 className="text-sm font-medium text-text-muted mb-2">Превью первых 10 кандидатов</h3>
                <div className="text-xs space-y-1 font-mono">
                  {result.preview.map((p, i) => (
                    <div key={i} className="border-b border-border py-1">
                      {i + 1}. {p.phone} · {p.category.padEnd(13)} · {p.name} · {p.resultStr}{p.zorgeStr ? ` | Zorge: ${p.zorgeStr}` : ''}
                    </div>
                  ))}
                </div>
              </div>

              <div className="bg-warning/10 p-3 rounded text-sm">
                <p className="font-medium">Если цифры адекватные — сними галку «Dry-run» и нажми «РЕАЛЬНЫЙ ИМПОРТ».</p>
              </div>
            </>
          )}

          {!result.dryRun && (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                <div className="bg-success/10 p-3 rounded"><div className="text-text-muted">Создано</div><div className="text-2xl font-bold text-success">{result.dbStats.created}</div></div>
                <div className="bg-info/10 p-3 rounded"><div className="text-text-muted">Обновлено</div><div className="text-2xl font-bold text-info">{result.dbStats.updated}</div></div>
                <div className="bg-accent/10 p-3 rounded"><div className="text-text-muted">CallLog</div><div className="text-2xl font-bold text-accent">{result.dbStats.callLogsCreated}</div></div>
                <div className="bg-error/10 p-3 rounded"><div className="text-text-muted">Ошибок</div><div className="text-2xl font-bold text-error">{result.dbStats.errors}</div></div>
              </div>
              {(result.dbStats.coordCreated > 0 || result.dbStats.coordUpdated > 0) && (
                <div className="text-sm text-text-muted">
                  Координаторы: создано {result.dbStats.coordCreated}, обновлено {result.dbStats.coordUpdated}
                </div>
              )}
              {result.errors.length > 0 && (
                <div>
                  <h3 className="text-sm font-medium text-error mb-2">Ошибки (первые 20):</h3>
                  <div className="text-xs space-y-1 font-mono">
                    {result.errors.map((e, i) => (
                      <div key={i} className="border-b border-border py-1">
                        {e.phone} — {e.error}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
