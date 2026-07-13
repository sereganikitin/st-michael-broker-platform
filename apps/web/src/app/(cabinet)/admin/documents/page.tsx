'use client';

// Правка 2026-07-13: полноценный редактор папок Материалов.
// Что можно: создать/переименовать/удалить папку целиком, переставлять порядок
// папок (стрелки ↑/↓), галочки «в кабинете» и «на лендинге», кастомная обложка,
// общая ссылка «Открыть на Я.Диске», массовая загрузка файлов в папку,
// пересортировка файлов внутри папки. Прежний UI «Все документы» сохранён
// снизу — там же остаются файлы категорий cooperation/analytics (лендинговые
// разделы, работают без папок), внешние ссылки и «файлы без папки».

import { useEffect, useMemo, useRef, useState } from 'react';
import { api, apiGet, apiPatch, apiPost, apiDelete, apiUpload } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import {
  FileText, Upload, Link2, Plus, Trash2, Save, ExternalLink, ChevronUp, ChevronDown,
  Folder, FolderPlus, Image as ImageIcon, X,
} from 'lucide-react';

type DocItem = {
  id: string;
  name: string;
  description: string | null;
  type: string;
  category: string;
  subcategory: string | null;
  folderId: string | null;
  fileUrl: string;
  fileSize: number | null;
  isPublic: boolean;
  sortOrder: number;
  createdAt: string;
};

type FolderItem = {
  id: string;
  name: string;
  sortOrder: number;
  showInCabinet: boolean;
  showOnLanding: boolean;
  iconUrl: string | null;
  folderUrl: string | null;
  documentsCount: number;
  documents?: DocItem[];
};

const CATEGORIES = [
  { value: 'cooperation', label: 'Сотрудничество (на лендинге)' },
  { value: 'analytics', label: 'Аналитика (на лендинге)' },
  { value: 'marketing', label: 'Маркетинг (реклама/планировки)' },
  { value: 'materials', label: 'Материалы (для брокеров)' },
];

// Категории, для которых применимы папки MaterialFolder.
const FOLDER_CATEGORIES = new Set(['marketing', 'materials']);

function formatSize(bytes: number | null): string {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function AdminDocumentsPage() {
  const { broker } = useAuth();
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [foldersLoading, setFoldersLoading] = useState(true);
  const [docs, setDocs] = useState<DocItem[]>([]);
  const [docsLoading, setDocsLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [message, setMessage] = useState('');
  const [expandedFolder, setExpandedFolder] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState('');

  if (broker && broker.role !== 'ADMIN' && broker.role !== 'MANAGER') {
    return <div className="card">Доступ запрещён</div>;
  }
  const isAdmin = broker?.role === 'ADMIN';

  const loadFolders = async () => {
    setFoldersLoading(true);
    try {
      const list = await apiGet('/admin/documents/folders?include=documents');
      setFolders(Array.isArray(list) ? list : []);
    } catch { setFolders([]); }
    setFoldersLoading(false);
  };

  const loadDocs = () => {
    setDocsLoading(true);
    const q = filter ? `?category=${filter}&limit=200` : '?limit=200';
    apiGet(`/admin/documents${q}`)
      .then((d) => setDocs(d.documents || []))
      .catch(() => setDocs([]))
      .finally(() => setDocsLoading(false));
  };
  useEffect(() => { loadFolders(); }, []);
  useEffect(loadDocs, [filter]);

  const flash = (m: string) => { setMessage(m); setTimeout(() => setMessage(''), 2000); };

  // ─── Folders ─────────────────────────────────────────────────

  const createFolder = async () => {
    const name = newFolderName.trim();
    if (!name) return;
    try {
      await apiPost('/admin/documents/folders', { name, showInCabinet: true, showOnLanding: false });
      setNewFolderName('');
      await loadFolders();
      flash('Папка создана');
    } catch (e: any) { flash(e.message || 'Ошибка'); }
  };

  const patchFolder = async (id: string, patch: Partial<FolderItem>) => {
    try {
      await apiPatch(`/admin/documents/folders/${id}`, patch);
      await loadFolders();
      // Переименование папки синхронизирует subcategory у файлов — перезагрузим и общий список
      if (patch.name !== undefined) loadDocs();
    } catch (e: any) { flash(e.message || 'Ошибка'); }
  };

  const deleteFolder = async (f: FolderItem, deleteDocuments: boolean) => {
    const suffix = deleteDocuments
      ? `Также будут удалены ${f.documentsCount} файлов внутри.`
      : `Файлы (${f.documentsCount}) сохранятся в разделе «Файлы без папки».`;
    if (!confirm(`Удалить папку «${f.name}»?\n${suffix}`)) return;
    try {
      await apiDelete(`/admin/documents/folders/${f.id}?deleteDocuments=${deleteDocuments ? 'true' : 'false'}`);
      await loadFolders();
      loadDocs();
      flash('Папка удалена');
    } catch (e: any) { flash(e.message || 'Ошибка'); }
  };

  const moveFolder = async (idx: number, dir: -1 | 1) => {
    const j = idx + dir;
    if (j < 0 || j >= folders.length) return;
    // Меняем sortOrder так, чтобы папка-соседка получила порядок текущей и наоборот.
    const a = folders[idx];
    const b = folders[j];
    const aNew = b.sortOrder;
    const bNew = a.sortOrder;
    // Если у обеих одинаковый sortOrder (0) — переназначим по индексу.
    const items = aNew === bNew
      ? folders.map((f, i) => ({ id: f.id, sortOrder: (i + 1) * 10 }))
        .map((it) => it.id === a.id ? { ...it, sortOrder: (j + 1) * 10 } : it.id === b.id ? { ...it, sortOrder: (idx + 1) * 10 } : it)
      : [{ id: a.id, sortOrder: aNew }, { id: b.id, sortOrder: bNew }];
    try {
      await apiPatch('/admin/documents/folders/reorder', { items });
      await loadFolders();
    } catch (e: any) { flash(e.message || 'Ошибка'); }
  };

  const uploadFolderIcon = async (f: FolderItem, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    try {
      await apiUpload(`/admin/documents/folders/${f.id}/icon`, fd);
      await loadFolders();
      flash('Обложка обновлена');
    } catch (e: any) { flash(e.message || 'Ошибка'); }
  };

  // ─── Files inside a folder ───────────────────────────────────

  const moveDocInFolder = async (folder: FolderItem, idx: number, dir: -1 | 1) => {
    if (!folder.documents) return;
    const j = idx + dir;
    if (j < 0 || j >= folder.documents.length) return;
    const items = folder.documents.map((d, i) => {
      let order = d.sortOrder;
      if (i === idx) order = folder.documents![j].sortOrder;
      else if (i === j) order = folder.documents![idx].sortOrder;
      return { id: d.id, sortOrder: order };
    });
    // Если все sortOrder одинаковые — переназначаем по позиции.
    const same = items.every((it, _, arr) => it.sortOrder === arr[0].sortOrder);
    const finalItems = same ? items.map((it, i) => ({ ...it, sortOrder: (i === idx ? j : i === j ? idx : i) * 10 + 10 })) : items;
    try {
      await apiPatch(`/admin/documents/folders/${folder.id}/documents/reorder`, { items: finalItems });
      await loadFolders();
    } catch (e: any) { flash(e.message || 'Ошибка'); }
  };

  const deleteDoc = async (id: string) => {
    if (!confirm('Удалить файл? Это удалит и физический файл с диска.')) return;
    try {
      await api(`/admin/documents/${id}`, { method: 'DELETE' });
      await Promise.all([loadFolders(), loadDocs()]);
    } catch (e: any) { flash(e.message || 'Ошибка'); }
  };

  const attachDocToFolder = async (docId: string, folderId: string | null) => {
    try {
      await api(`/admin/documents/${docId}`, {
        method: 'PATCH',
        body: JSON.stringify({ folderId }),
      });
      await Promise.all([loadFolders(), loadDocs()]);
      flash('Готово');
    } catch (e: any) { flash(e.message || 'Ошибка'); }
  };

  // ─── Bulk upload ─────────────────────────────────────────────

  const bulkInputRef = useRef<HTMLInputElement>(null);
  const [bulkFolder, setBulkFolder] = useState('');
  const [bulkCategory, setBulkCategory] = useState('materials');
  const [bulkFiles, setBulkFiles] = useState<FileList | null>(null);
  const [bulkUploading, setBulkUploading] = useState(false);

  const handleBulkUpload = async () => {
    if (!bulkFiles || bulkFiles.length === 0) return;
    setBulkUploading(true);
    try {
      const fd = new FormData();
      Array.from(bulkFiles).forEach((f) => fd.append('files', f));
      fd.append('category', bulkCategory);
      if (bulkFolder) fd.append('folderId', bulkFolder);
      fd.append('isPublic', 'true');
      await apiUpload('/admin/documents/upload-multi', fd);
      setBulkFiles(null);
      if (bulkInputRef.current) bulkInputRef.current.value = '';
      await Promise.all([loadFolders(), loadDocs()]);
      flash('Файлы загружены');
    } catch (e: any) { flash(e.message || 'Ошибка загрузки'); }
    setBulkUploading(false);
  };

  // ─── Single-file/external forms (сохраняем для не-папочных категорий) ───

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadDraft, setUploadDraft] = useState({
    name: '', description: '', category: 'cooperation', subcategory: '', isPublic: true, sortOrder: 0,
  });
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  const [extDraft, setExtDraft] = useState({
    name: '', description: '', url: '', category: 'cooperation', subcategory: '', isPublic: true, sortOrder: 0,
  });
  const [extSaving, setExtSaving] = useState(false);

  const handleUpload = async () => {
    if (!uploadFile) return;
    setUploading(true); setMessage('');
    try {
      const fd = new FormData();
      fd.append('file', uploadFile);
      fd.append('category', uploadDraft.category);
      if (uploadDraft.name) fd.append('name', uploadDraft.name);
      if (uploadDraft.description) fd.append('description', uploadDraft.description);
      if (uploadDraft.subcategory) fd.append('subcategory', uploadDraft.subcategory);
      fd.append('isPublic', String(uploadDraft.isPublic));
      fd.append('sortOrder', String(uploadDraft.sortOrder));
      await apiUpload('/admin/documents/upload', fd);
      setUploadFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      setUploadDraft({ ...uploadDraft, name: '', description: '', subcategory: '' });
      loadDocs();
      flash('Файл загружен');
    } catch (e: any) { setMessage(e.message || 'Ошибка загрузки'); }
    setUploading(false);
  };

  const handleAddExternal = async () => {
    if (!extDraft.url || !extDraft.name) return;
    setExtSaving(true); setMessage('');
    try {
      await apiPost('/admin/documents/external', extDraft);
      setExtDraft({ ...extDraft, name: '', description: '', url: '', subcategory: '' });
      loadDocs();
      loadFolders();
      flash('Ссылка добавлена');
    } catch (e: any) { setMessage(e.message || 'Ошибка'); }
    setExtSaving(false);
  };

  const handleSaveDoc = async (d: DocItem) => {
    try {
      await api(`/admin/documents/${d.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: d.name, description: d.description, category: d.category,
          subcategory: d.subcategory, isPublic: d.isPublic, sortOrder: d.sortOrder,
        }),
      });
      flash('Сохранено');
    } catch (e: any) { flash(e.message || 'Ошибка'); }
  };

  const updateDocLocal = (idx: number, patch: Partial<DocItem>) => {
    const next = [...docs];
    next[idx] = { ...next[idx], ...patch };
    setDocs(next);
  };

  // Файлы без папки в категориях marketing/materials — показываем отдельным блоком
  const orphanDocs = useMemo(
    () => docs.filter((d) => FOLDER_CATEGORIES.has(d.category) && !d.folderId),
    [docs],
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold flex items-center gap-2">
            <FileText className="w-7 h-7 text-accent" />Файлы и документы
          </h1>
          <span className="text-text-muted text-sm">Папки Материалов + отдельные файлы для лендинга</span>
        </div>
      </div>

      {message && <div className="mb-4 p-3 rounded-lg bg-info/20 text-info text-sm">{message}</div>}

      {/* ── Секция «Папки Материалов» ─────────────────────────── */}
      <div className="card mb-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Folder className="w-5 h-5" /> Папки Материалов
          </h2>
          {isAdmin && (
            <div className="flex items-center gap-2">
              <input
                className="input text-sm w-56"
                placeholder="Название новой папки"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') createFolder(); }}
              />
              <button className="btn btn-primary text-xs flex items-center gap-1" onClick={createFolder} disabled={!newFolderName.trim()}>
                <FolderPlus className="w-4 h-4" /> Создать
              </button>
            </div>
          )}
        </div>

        {foldersLoading ? (
          <div className="text-center py-4 text-text-muted text-sm">Загрузка папок…</div>
        ) : folders.length === 0 ? (
          <div className="text-center py-6 text-text-muted text-sm">Папок пока нет. Создайте первую справа.</div>
        ) : (
          <div className="space-y-2">
            {folders.map((f, idx) => {
              const isExpanded = expandedFolder === f.id;
              return (
                <div key={f.id} className="border border-border rounded-lg">
                  <div className="flex items-center gap-2 p-3">
                    {isAdmin && (
                      <div className="flex flex-col">
                        <button className="text-text-muted hover:text-text" onClick={() => moveFolder(idx, -1)} disabled={idx === 0} title="Выше">
                          <ChevronUp className="w-4 h-4" />
                        </button>
                        <button className="text-text-muted hover:text-text" onClick={() => moveFolder(idx, 1)} disabled={idx === folders.length - 1} title="Ниже">
                          <ChevronDown className="w-4 h-4" />
                        </button>
                      </div>
                    )}

                    <FolderIconEditor folder={f} isAdmin={!!isAdmin} onUpload={(file) => uploadFolderIcon(f, file)} onClear={() => patchFolder(f.id, { iconUrl: null })} />

                    <div className="flex-1 min-w-0">
                      <input
                        className="input text-sm font-semibold"
                        defaultValue={f.name}
                        disabled={!isAdmin}
                        onBlur={(e) => { if (e.target.value.trim() && e.target.value.trim() !== f.name) patchFolder(f.id, { name: e.target.value.trim() }); }}
                      />
                      <div className="text-xs text-text-muted mt-1">{f.documentsCount} {f.documentsCount === 1 ? 'файл' : f.documentsCount < 5 ? 'файла' : 'файлов'}</div>
                    </div>

                    <div className="flex flex-col gap-1 text-xs">
                      <label className="flex items-center gap-1 cursor-pointer">
                        <input type="checkbox" checked={f.showInCabinet} disabled={!isAdmin} onChange={(e) => patchFolder(f.id, { showInCabinet: e.target.checked })} />
                        В кабинете
                      </label>
                      <label className="flex items-center gap-1 cursor-pointer">
                        <input type="checkbox" checked={f.showOnLanding} disabled={!isAdmin} onChange={(e) => patchFolder(f.id, { showOnLanding: e.target.checked })} />
                        На лендинге
                      </label>
                    </div>

                    <div className="flex flex-col gap-1 items-stretch">
                      <input
                        className="input text-xs w-56"
                        placeholder="Ссылка «Открыть на Я.Диске»"
                        defaultValue={f.folderUrl || ''}
                        disabled={!isAdmin}
                        onBlur={(e) => { if ((e.target.value || null) !== f.folderUrl) patchFolder(f.id, { folderUrl: e.target.value || null }); }}
                      />
                    </div>

                    <div className="flex flex-col gap-1">
                      <button className="btn btn-secondary text-xs" onClick={() => setExpandedFolder(isExpanded ? null : f.id)}>
                        {isExpanded ? 'Свернуть' : 'Файлы'}
                      </button>
                      {isAdmin && (
                        <button className="btn btn-secondary text-error text-xs flex items-center gap-1" onClick={() => deleteFolder(f, false)}>
                          <Trash2 className="w-3 h-3" /> Папку
                        </button>
                      )}
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="border-t border-border p-3 bg-surface-secondary/40">
                      {(!f.documents || f.documents.length === 0) ? (
                        <div className="text-sm text-text-muted text-center py-3">В папке пока нет файлов. Загрузите ниже через «Массовая загрузка».</div>
                      ) : (
                        <div className="space-y-1">
                          {f.documents.map((d, i) => (
                            <div key={d.id} className="flex items-center gap-2 py-1 text-sm">
                              {isAdmin && (
                                <div className="flex flex-col">
                                  <button className="text-text-muted hover:text-text" onClick={() => moveDocInFolder(f, i, -1)} disabled={i === 0}><ChevronUp className="w-3 h-3" /></button>
                                  <button className="text-text-muted hover:text-text" onClick={() => moveDocInFolder(f, i, 1)} disabled={i === f.documents!.length - 1}><ChevronDown className="w-3 h-3" /></button>
                                </div>
                              )}
                              <FileText className="w-4 h-4 text-text-muted flex-shrink-0" />
                              <span className="flex-1 min-w-0 truncate">{d.name}</span>
                              <span className="text-xs text-text-muted">{d.type}</span>
                              <span className="text-xs text-text-muted">{formatSize(d.fileSize)}</span>
                              <a href={d.fileUrl} target="_blank" rel="noopener noreferrer" className="text-accent"><ExternalLink className="w-3 h-3" /></a>
                              {isAdmin && (
                                <button className="text-error" onClick={() => deleteDoc(d.id)} title="Удалить"><Trash2 className="w-3 h-3" /></button>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                      {isAdmin && f.documentsCount > 0 && (
                        <button className="mt-3 text-xs text-error underline" onClick={() => deleteFolder(f, true)}>
                          Удалить папку вместе с {f.documentsCount} файлами
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Массовая загрузка в папку ─────────────────────────── */}
      {isAdmin && (
        <div className="card mb-4">
          <h2 className="text-lg font-semibold flex items-center gap-2 mb-3">
            <Upload className="w-5 h-5" /> Массовая загрузка файлов в папку
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
            <div>
              <label className="label">Папка</label>
              <select className="input" value={bulkFolder} onChange={(e) => setBulkFolder(e.target.value)}>
                <option value="">— без папки —</option>
                {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Категория</label>
              <select className="input" value={bulkCategory} onChange={(e) => setBulkCategory(e.target.value)}>
                {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </div>
            <div className="md:col-span-2">
              <label className="label">Файлы (можно выбрать несколько, до 50 за раз)</label>
              <input
                ref={bulkInputRef}
                type="file"
                multiple
                className="input"
                onChange={(e) => setBulkFiles(e.target.files)}
              />
              {bulkFiles && bulkFiles.length > 0 && (
                <div className="text-xs text-text-muted mt-1">Выбрано {bulkFiles.length} файлов</div>
              )}
            </div>
          </div>
          <div className="mt-3">
            <button
              className="btn btn-primary flex items-center gap-2"
              onClick={handleBulkUpload}
              disabled={bulkUploading || !bulkFiles || bulkFiles.length === 0}
            >
              <Upload className="w-4 h-4" /> {bulkUploading ? 'Загрузка…' : `Загрузить ${bulkFiles ? bulkFiles.length : 0} файлов`}
            </button>
          </div>
        </div>
      )}

      {/* ── Файлы без папки (marketing/materials) ─────────────── */}
      {orphanDocs.length > 0 && (
        <div className="card mb-4">
          <h2 className="text-lg font-semibold flex items-center gap-2 mb-3">
            <FileText className="w-5 h-5" /> Файлы без папки ({orphanDocs.length})
          </h2>
          <div className="space-y-1">
            {orphanDocs.map((d) => (
              <div key={d.id} className="flex items-center gap-2 text-sm py-1">
                <FileText className="w-4 h-4 text-text-muted flex-shrink-0" />
                <span className="flex-1 min-w-0 truncate">{d.name}</span>
                <span className="text-xs px-2 rounded bg-surface-secondary">{d.category}</span>
                {isAdmin && (
                  <select
                    className="input text-xs w-40"
                    value=""
                    onChange={(e) => e.target.value && attachDocToFolder(d.id, e.target.value)}
                  >
                    <option value="">Прицепить к папке…</option>
                    {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                  </select>
                )}
                <a href={d.fileUrl} target="_blank" rel="noopener noreferrer" className="text-accent"><ExternalLink className="w-3 h-3" /></a>
                {isAdmin && (
                  <button className="text-error" onClick={() => deleteDoc(d.id)}><Trash2 className="w-3 h-3" /></button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Единичная загрузка / внешние ссылки — для cooperation/analytics ── */}
      {isAdmin && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
          <div className="card">
            <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
              <Upload className="w-5 h-5" /> Загрузить один файл (для «Сотрудничество/Аналитика»)
            </h2>
            <div className="space-y-3">
              <div>
                <label className="label">Файл (до 200 MB)</label>
                <input
                  ref={fileInputRef}
                  type="file"
                  className="input"
                  onChange={(e) => setUploadFile(e.target.files?.[0] || null)}
                />
                {uploadFile && <div className="text-xs text-text-muted mt-1">{uploadFile.name} · {formatSize(uploadFile.size)}</div>}
              </div>
              <div>
                <label className="label">Название (если пусто — взять из имени файла)</label>
                <input className="input" value={uploadDraft.name} onChange={(e) => setUploadDraft({ ...uploadDraft, name: e.target.value })} />
              </div>
              <div>
                <label className="label">Описание (опционально)</label>
                <input className="input" value={uploadDraft.description} onChange={(e) => setUploadDraft({ ...uploadDraft, description: e.target.value })} />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="label">Категория</label>
                  <select className="input" value={uploadDraft.category} onChange={(e) => setUploadDraft({ ...uploadDraft, category: e.target.value })}>
                    {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="label">Подкатегория (только для cooperation/analytics)</label>
                  <input className="input" value={uploadDraft.subcategory} onChange={(e) => setUploadDraft({ ...uploadDraft, subcategory: e.target.value })} />
                </div>
              </div>
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={uploadDraft.isPublic} onChange={(e) => setUploadDraft({ ...uploadDraft, isPublic: e.target.checked })} />
                  Публично
                </label>
              </div>
              <button className="btn btn-primary flex items-center gap-2" onClick={handleUpload} disabled={uploading || !uploadFile}>
                <Upload className="w-4 h-4" /> {uploading ? 'Загрузка…' : 'Загрузить'}
              </button>
            </div>
          </div>

          <div className="card">
            <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
              <Link2 className="w-5 h-5" /> Внешняя ссылка
            </h2>
            <div className="space-y-3">
              <div>
                <label className="label">URL</label>
                <input className="input" placeholder="https://..." value={extDraft.url} onChange={(e) => setExtDraft({ ...extDraft, url: e.target.value })} />
              </div>
              <div>
                <label className="label">Название</label>
                <input className="input" value={extDraft.name} onChange={(e) => setExtDraft({ ...extDraft, name: e.target.value })} />
              </div>
              <div>
                <label className="label">Описание</label>
                <input className="input" value={extDraft.description} onChange={(e) => setExtDraft({ ...extDraft, description: e.target.value })} />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="label">Категория</label>
                  <select className="input" value={extDraft.category} onChange={(e) => setExtDraft({ ...extDraft, category: e.target.value })}>
                    {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="label">Подкатегория</label>
                  <input className="input" value={extDraft.subcategory} onChange={(e) => setExtDraft({ ...extDraft, subcategory: e.target.value })} />
                </div>
              </div>
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={extDraft.isPublic} onChange={(e) => setExtDraft({ ...extDraft, isPublic: e.target.checked })} />
                  Публично
                </label>
              </div>
              <button className="btn btn-primary flex items-center gap-2" onClick={handleAddExternal} disabled={extSaving || !extDraft.url || !extDraft.name}>
                <Plus className="w-4 h-4" /> {extSaving ? 'Сохранение…' : 'Добавить'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="card mb-4">
        <div className="flex items-center gap-3">
          <span className="text-sm text-text-muted">Фильтр:</span>
          <select className="input w-auto" value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">Все категории</option>
            {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
          <span className="text-sm text-text-muted ml-auto">Всего: {docs.length}</span>
        </div>
      </div>

      <div className="space-y-2">
        {docsLoading ? (
          <div className="text-center py-8 text-text-muted card">Загрузка...</div>
        ) : docs.length === 0 ? (
          <div className="card text-center py-8 text-text-muted">
            <FileText className="w-10 h-10 mx-auto mb-2 text-text-muted/50" />
            Документы не найдены
          </div>
        ) : (
          docs.map((d, idx) => (
            <div key={d.id} className="card">
              <div className="grid grid-cols-1 md:grid-cols-12 gap-2 items-center mb-2">
                <input className="input md:col-span-3" value={d.name} onChange={(e) => updateDocLocal(idx, { name: e.target.value })} disabled={!isAdmin} />
                <input className="input md:col-span-3 text-sm" placeholder="Описание" value={d.description || ''} onChange={(e) => updateDocLocal(idx, { description: e.target.value })} disabled={!isAdmin} />
                <select className="input md:col-span-2 text-sm" value={d.category} onChange={(e) => updateDocLocal(idx, { category: e.target.value })} disabled={!isAdmin}>
                  {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.value}</option>)}
                </select>
                <input className="input md:col-span-2 text-sm" placeholder="Подкат." value={d.subcategory || ''} onChange={(e) => updateDocLocal(idx, { subcategory: e.target.value })} disabled={!isAdmin} />
                <input className="input md:col-span-1 text-sm" type="number" value={d.sortOrder} onChange={(e) => updateDocLocal(idx, { sortOrder: Number(e.target.value) })} disabled={!isAdmin} title="Порядок" />
                <label className="flex items-center gap-1 text-xs md:col-span-1">
                  <input type="checkbox" checked={d.isPublic} onChange={(e) => updateDocLocal(idx, { isPublic: e.target.checked })} disabled={!isAdmin} />
                  Public
                </label>
              </div>
              <div className="flex items-center gap-2 text-xs text-text-muted">
                <span className="px-2 py-0.5 rounded bg-surface-secondary">{d.type}</span>
                <span>{formatSize(d.fileSize)}</span>
                <a href={d.fileUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-accent hover:underline">
                  <ExternalLink className="w-3 h-3" /> Открыть
                </a>
                <span className="text-text-muted/60 truncate">{d.fileUrl}</span>
                {isAdmin && (
                  <div className="ml-auto flex gap-1">
                    <button onClick={() => handleSaveDoc(d)} className="btn btn-primary text-xs"><Save className="w-3 h-3" /></button>
                    <button onClick={() => deleteDoc(d.id)} className="btn btn-secondary text-error text-xs"><Trash2 className="w-3 h-3" /></button>
                  </div>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function FolderIconEditor({
  folder, isAdmin, onUpload, onClear,
}: {
  folder: FolderItem; isAdmin: boolean;
  onUpload: (file: File) => void;
  onClear: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className="relative w-12 h-12 rounded-lg overflow-hidden bg-surface-secondary flex-shrink-0 flex items-center justify-center">
      {folder.iconUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={folder.iconUrl} alt="" className="w-full h-full object-cover" />
      ) : (
        <Folder className="w-6 h-6 text-text-muted" />
      )}
      {isAdmin && (
        <>
          <input
            ref={ref}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f); e.target.value = ''; }}
          />
          <button
            type="button"
            title="Загрузить обложку"
            className="absolute inset-0 bg-black/40 opacity-0 hover:opacity-100 text-white flex items-center justify-center text-xs"
            onClick={() => ref.current?.click()}
          >
            <ImageIcon className="w-4 h-4" />
          </button>
          {folder.iconUrl && (
            <button
              type="button"
              title="Убрать обложку"
              className="absolute top-0 right-0 w-4 h-4 bg-black/60 text-white rounded-bl flex items-center justify-center"
              onClick={(e) => { e.stopPropagation(); onClear(); }}
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </>
      )}
    </div>
  );
}
