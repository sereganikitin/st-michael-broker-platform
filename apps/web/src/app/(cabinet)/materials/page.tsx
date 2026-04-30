'use client';

import { useEffect, useState } from 'react';
import { apiGet } from '@/lib/api';
import { BookOpen, ExternalLink } from 'lucide-react';

interface DocItem {
  id: string;
  name: string;
  description: string | null;
  type: string;
  category: string;
  subcategory: string | null;
  fileUrl: string;
  fileSize: number | null;
}

export default function MaterialsPage() {
  const [docs, setDocs] = useState<DocItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      apiGet('/documents?category=marketing&limit=200').catch(() => ({ documents: [] })),
      apiGet('/documents?category=materials&limit=200').catch(() => ({ documents: [] })),
    ])
      .then(([a, b]) => setDocs([...(a.documents || []), ...(b.documents || [])]))
      .finally(() => setLoading(false));
  }, []);

  // Group by subcategory (or "Без категории")
  const groups: Record<string, DocItem[]> = {};
  for (const d of docs) {
    const key = d.subcategory || 'Без категории';
    if (!groups[key]) groups[key] = [];
    groups[key].push(d);
  }

  const groupNames = Object.keys(groups).sort();

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-3xl font-bold">Материалы для брокеров</h1>
        <p className="text-text-muted text-sm mt-1">
          Готовый контент для продвижения проектов ST Michael
        </p>
      </div>

      {loading ? (
        <div className="card text-center py-8 text-text-muted">Загрузка...</div>
      ) : docs.length === 0 ? (
        <div className="card text-center py-12 text-text-muted">
          <BookOpen className="w-12 h-12 mx-auto mb-3 text-text-muted/50" />
          <p>Материалы пока не добавлены</p>
          <p className="text-xs mt-2">По вопросам обращайтесь в отдел партнёров: <a href="tel:+74951504010" className="text-accent">+7 (495) 150-40-10</a></p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {groupNames.map((groupName) => (
            <div key={groupName} className="card">
              <h3 className="font-semibold mb-4">{groupName}</h3>
              <div className="space-y-2">
                {groups[groupName].map((d) => (
                  <a
                    key={d.id}
                    href={d.fileUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-surface-secondary cursor-pointer transition"
                  >
                    <div>
                      <div className="text-sm font-medium">{d.name}</div>
                      {d.description && <div className="text-xs text-text-muted">{d.description}</div>}
                    </div>
                    <ExternalLink className="w-4 h-4 text-text-muted flex-shrink-0" />
                  </a>
                ))}
              </div>
            </div>
          ))}
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
    </div>
  );
}
