'use client';

import { useEffect, useState } from 'react';
import { apiGet } from '@/lib/api';
import { FileText, Download } from 'lucide-react';

export default function DocumentsPage() {
  const [documents, setDocuments] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [categoryFilter, setCategoryFilter] = useState('');

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (categoryFilter) params.set('category', categoryFilter);
    apiGet(`/documents?${params}`)
      .then((data) => setDocuments(data.documents || []))
      .catch(() => setDocuments([]))
      .finally(() => setLoading(false));
  }, [categoryFilter]);

  const handleDownload = async (id: string) => {
    try {
      const data = await apiGet(`/documents/${id}/download`);
      if (data.url) {
        window.open(data.url, '_blank');
      }
    } catch {}
  };

  return (
    <div>
      <h1 className="text-3xl font-bold mb-6">Документы</h1>

      <div className="card mb-6">
        <select className="input w-auto" value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
          <option value="">Все категории</option>
          <option value="contract">Договоры</option>
          <option value="presentation">Презентации</option>
          <option value="price_list">Прайс-листы</option>
          <option value="manual">Инструкции</option>
        </select>
      </div>

      <div className="card">
        {loading ? (
          <div className="text-center py-8 text-text-muted">Загрузка...</div>
        ) : documents.length === 0 ? (
          <div className="text-center py-8 text-text-muted">
            <FileText className="w-12 h-12 mx-auto mb-3 text-text-muted/50" />
            Документы не найдены
          </div>
        ) : (
          <div className="space-y-3">
            {documents.map((doc: any) => (
              <div key={doc.id} className="flex items-center justify-between py-3 border-b border-border last:border-0 hover:bg-surface-secondary rounded-lg px-3 -mx-3">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-accent/10 rounded-lg flex items-center justify-center">
                    <FileText className="w-5 h-5 text-accent" />
                  </div>
                  <div>
                    <div className="font-medium text-sm">{doc.name}</div>
                    <div className="text-xs text-text-muted">
                      {doc.category} | {doc.type}
                      {doc.fileSize && ` | ${(doc.fileSize / 1024 / 1024).toFixed(1)} МБ`}
                    </div>
                  </div>
                </div>
                <button
                  className="btn btn-secondary flex items-center gap-2"
                  onClick={() => handleDownload(doc.id)}
                >
                  <Download className="w-4 h-4" />
                  Скачать
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
