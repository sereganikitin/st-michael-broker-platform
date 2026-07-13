'use client';

// КБ6 (2026-05-25): редизайн материалов.
// — Категории — аккордеон, по умолчанию свёрнуты, раскрываются только по клику.
// — Документы — обычный список со ссылкой.
// — Фотографии (image/* + jpg/png/webp) — плитка превью; клик открывает
//   модальный просмотрщик с навигацией prev/next.
// Правка 2026-07-13: источник данных — /documents/folders (MaterialFolder с
// флагом showInCabinet). Пока раздел живёт с fallback на плоский список по
// subcategory для файлов, не привязанных к папке.

import { useEffect, useMemo, useState } from 'react';
import { apiGet } from '@/lib/api';
import { BookOpen, ExternalLink, ChevronDown, ChevronUp, X, ChevronLeft, ChevronRight, Image as ImageIcon, FileText, Play, FileType } from 'lucide-react';

interface DocItem {
  id: string;
  name: string;
  description: string | null;
  type: string;
  category: string;
  subcategory: string | null;
  folderId?: string | null;
  fileUrl: string;
  fileSize: number | null;
}

interface FolderGroup {
  id: string;
  name: string;
  iconUrl: string | null;
  folderUrl: string | null;
  documents: DocItem[];
}

// 2026-05-28: regex match расширение в конце строки ИЛИ перед ?/#/&
const IMAGE_RE = /\.(jpe?g|png|webp|gif|svg|heic|avif|bmp|tiff?)(\?|#|$)/i;
const VIDEO_RE = /\.(mp4|mov|webm|m4v|avi|mkv)(\?|#|$)/i;
const PDF_RE = /\.pdf(\?|#|$)/i;
const isImage = (d: DocItem) =>
  /^image\//i.test(d.type || '') ||
  /^(jpe?g|png|webp|gif|svg|heic|avif|bmp|tiff?)$/i.test(d.type || '') ||
  IMAGE_RE.test(d.fileUrl || '') ||
  IMAGE_RE.test(d.name || '');
const isVideo = (d: DocItem) =>
  /^video\//i.test(d.type || '') ||
  /^(mp4|mov|webm|m4v|avi|mkv)$/i.test(d.type || '') ||
  VIDEO_RE.test(d.fileUrl || '') ||
  VIDEO_RE.test(d.name || '');
const isPdf = (d: DocItem) =>
  /pdf/i.test(d.type || '') ||
  PDF_RE.test(d.fileUrl || '') ||
  PDF_RE.test(d.name || '');

function PhotoViewer({
  items,
  index,
  onClose,
  onIndex,
}: {
  items: DocItem[];
  index: number;
  onClose: () => void;
  onIndex: (i: number) => void;
}) {
  const cur = items[index];
  if (!cur) return null;
  const prev = () => onIndex((index - 1 + items.length) % items.length);
  const next = () => onIndex((index + 1) % items.length);

  return (
    <div
      className="fixed inset-0 bg-black/85 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <button
        className="absolute top-4 right-4 text-white/80 hover:text-white"
        onClick={onClose}
        aria-label="Закрыть"
      >
        <X className="w-6 h-6" />
      </button>
      {items.length > 1 && (
        <>
          <button
            className="absolute left-4 top-1/2 -translate-y-1/2 text-white/80 hover:text-white p-2 rounded-full bg-black/40"
            onClick={(e) => { e.stopPropagation(); prev(); }}
            aria-label="Назад"
          >
            <ChevronLeft className="w-6 h-6" />
          </button>
          <button
            className="absolute right-4 top-1/2 -translate-y-1/2 text-white/80 hover:text-white p-2 rounded-full bg-black/40"
            onClick={(e) => { e.stopPropagation(); next(); }}
            aria-label="Вперёд"
          >
            <ChevronRight className="w-6 h-6" />
          </button>
        </>
      )}
      <div className="max-w-[90vw] max-h-[90vh] w-full" onClick={(e) => e.stopPropagation()}>
        {isVideo(cur) ? (
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <video src={cur.fileUrl} controls autoPlay className="max-w-full max-h-[80vh] mx-auto block" />
        ) : isPdf(cur) ? (
          <iframe src={cur.fileUrl} className="w-full bg-white" style={{ height: '80vh' }} title={cur.name} />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={cur.fileUrl} alt={cur.name} className="max-w-full max-h-[80vh] object-contain mx-auto" />
        )}
        <div className="mt-2 text-center text-white/80 text-sm">
          {cur.name} <span className="text-white/40">· {index + 1} / {items.length}</span>
        </div>
      </div>
    </div>
  );
}

export default function MaterialsPage() {
  const [folders, setFolders] = useState<FolderGroup[]>([]);
  const [orphanDocs, setOrphanDocs] = useState<DocItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [viewer, setViewer] = useState<{ items: DocItem[]; index: number } | null>(null);

  useEffect(() => {
    // Основной источник: папки с флагом showInCabinet=true.
    // Fallback: плоский список marketing+materials для файлов без папки.
    Promise.all([
      apiGet('/documents/folders').catch(() => []),
      apiGet('/documents?category=marketing&limit=200').catch(() => ({ documents: [] })),
      apiGet('/documents?category=materials&limit=200').catch(() => ({ documents: [] })),
    ])
      .then(([fs, a, b]) => {
        const list: FolderGroup[] = Array.isArray(fs) ? fs : [];
        setFolders(list);
        const all = [...(a.documents || []), ...(b.documents || [])];
        const orphans = all.filter((d: DocItem) => !d.folderId);
        setOrphanDocs(orphans);
      })
      .finally(() => setLoading(false));
  }, []);

  // Формируем итоговые группы: сначала папки в их порядке (уже отсортированы
  // API по sortOrder), затем «Без категории» для файлов без папки.
  const groupList = useMemo(() => {
    const groups: FolderGroup[] = folders.map((f) => ({ ...f, documents: f.documents || [] }));
    if (orphanDocs.length > 0) {
      groups.push({ id: '__orphan__', name: 'Без категории', iconUrl: null, folderUrl: null, documents: orphanDocs });
    }
    return groups;
  }, [folders, orphanDocs]);

  const toggle = (g: string) => setOpenGroups((s) => ({ ...s, [g]: !s[g] }));

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl md:text-3xl font-bold">Материалы для брокеров</h1>
        <p className="text-text-muted text-sm mt-1">
          Готовый контент для продвижения проектов ST Michael
        </p>
      </div>

      {loading ? (
        <div className="card text-center py-8 text-text-muted">Загрузка...</div>
      ) : groupList.length === 0 ? (
        <div className="card text-center py-12 text-text-muted">
          <BookOpen className="w-12 h-12 mx-auto mb-3 text-text-muted/50" />
          <p>Материалы пока не добавлены</p>
          <p className="text-xs mt-2">По вопросам обращайтесь в отдел партнёров: <a href="tel:+74951504010" className="text-accent">+7 (495) 150-40-10</a></p>
        </div>
      ) : (
        <div className="space-y-3">
          {groupList.map((group) => {
            const items = group.documents;
            const images = items.filter(isImage);
            const videos = items.filter(isVideo);
            const pdfs = items.filter(isPdf);
            const docsList = items.filter((d) => !isImage(d) && !isVideo(d) && !isPdf(d));
            const isOpen = !!openGroups[group.id];
            return (
              <div key={group.id} className="card p-0 overflow-hidden">
                <button
                  className="w-full flex items-center justify-between p-4 hover:bg-surface-secondary transition text-left"
                  onClick={() => toggle(group.id)}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    {group.iconUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={group.iconUrl} alt="" className="w-10 h-10 rounded-lg object-cover flex-shrink-0" />
                    ) : null}
                    <div className="min-w-0">
                      <h3 className="font-semibold truncate">{group.name}</h3>
                      <p className="text-xs text-text-muted mt-0.5">
                        {items.length} {items.length === 1 ? 'элемент' : items.length < 5 ? 'элемента' : 'элементов'}
                        {images.length > 0 && ` · ${images.length} фото`}
                        {videos.length > 0 && ` · ${videos.length} видео`}
                        {pdfs.length > 0 && ` · ${pdfs.length} PDF`}
                      </p>
                    </div>
                  </div>
                  {isOpen ? <ChevronUp className="w-5 h-5 text-text-muted flex-shrink-0" /> : <ChevronDown className="w-5 h-5 text-text-muted flex-shrink-0" />}
                </button>
                {isOpen && (
                  <div className="p-4 border-t border-border space-y-4">
                    {images.length > 0 && (
                      <div>
                        <div className="text-xs uppercase tracking-wide text-text-muted mb-2 flex items-center gap-1">
                          <ImageIcon className="w-3 h-3" /> Фотографии
                        </div>
                        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                          {images.map((img, i) => (
                            <button
                              key={img.id}
                              className="bg-surface-secondary rounded-lg overflow-hidden aspect-square hover:ring-2 hover:ring-accent/50 transition"
                              onClick={() => setViewer({ items: images, index: i })}
                              title={img.name}
                            >
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img
                                src={img.fileUrl}
                                alt={img.name}
                                className="w-full h-full object-cover"
                                loading="lazy"
                              />
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {videos.length > 0 && (
                      <div>
                        <div className="text-xs uppercase tracking-wide text-text-muted mb-2 flex items-center gap-1">
                          <Play className="w-3 h-3" /> Видео
                        </div>
                        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                          {videos.map((v, i) => (
                            <button
                              key={v.id}
                              className="bg-black rounded-lg overflow-hidden aspect-square hover:ring-2 hover:ring-accent/50 transition relative group"
                              onClick={() => setViewer({ items: videos, index: i })}
                              title={v.name}
                            >
                              {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                              <video
                                src={v.fileUrl}
                                className="w-full h-full object-cover"
                                preload="metadata"
                                muted
                              />
                              <div className="absolute inset-0 flex items-center justify-center bg-black/30 group-hover:bg-black/10 transition">
                                <Play className="w-10 h-10 text-white fill-white" />
                              </div>
                              <div className="absolute bottom-0 left-0 right-0 text-white text-xs px-2 py-1 bg-gradient-to-t from-black/80 to-transparent truncate text-left">
                                {v.name}
                              </div>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {pdfs.length > 0 && (
                      <div>
                        <div className="text-xs uppercase tracking-wide text-text-muted mb-2 flex items-center gap-1">
                          <FileType className="w-3 h-3" /> PDF
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          {pdfs.map((p, i) => (
                            <button
                              key={p.id}
                              className="flex items-center gap-3 p-3 rounded-lg bg-surface-secondary hover:ring-2 hover:ring-accent/50 transition text-left"
                              onClick={() => setViewer({ items: pdfs, index: i })}
                              title={p.name}
                            >
                              <div className="w-12 h-14 bg-error/20 rounded flex items-center justify-center flex-shrink-0">
                                <FileType className="w-6 h-6 text-error" />
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="text-sm font-medium truncate">{p.name}</div>
                                <div className="text-xs text-text-muted">PDF</div>
                              </div>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {docsList.length > 0 && (
                      <div>
                        <div className="text-xs uppercase tracking-wide text-text-muted mb-2 flex items-center gap-1">
                          <FileText className="w-3 h-3" /> Документы
                        </div>
                        <div className="space-y-1">
                          {docsList.map((d) => (
                            <a
                              key={d.id}
                              href={d.fileUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-surface-secondary cursor-pointer transition"
                            >
                              <div className="min-w-0 flex-1">
                                <div className="text-sm font-medium truncate">{d.name}</div>
                                {d.description && <div className="text-xs text-text-muted truncate">{d.description}</div>}
                              </div>
                              <ExternalLink className="w-4 h-4 text-text-muted flex-shrink-0 ml-2" />
                            </a>
                          ))}
                        </div>
                      </div>
                    )}

                    {group.folderUrl && (
                      <a href={group.folderUrl} target="_blank" rel="noopener noreferrer" className="btn-outline inline-flex items-center gap-2 mt-2 text-sm">
                        Открыть папку на Я.Диске →
                      </a>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="card mt-6 text-center py-6 bg-surface-secondary">
        <p className="text-text-muted text-sm">
          По вопросам получения материалов:&nbsp;
          <a href="tel:+74951504010" className="text-accent font-medium">+7 (495) 150-40-10</a>
          <span className="text-text-muted mx-3">•</span>
          <a href="mailto:broker@stmichael.ru" className="text-accent font-medium">broker@stmichael.ru</a>
        </p>
      </div>

      {viewer && (
        <PhotoViewer
          items={viewer.items}
          index={viewer.index}
          onClose={() => setViewer(null)}
          onIndex={(i) => setViewer({ items: viewer.items, index: i })}
        />
      )}
    </div>
  );
}
