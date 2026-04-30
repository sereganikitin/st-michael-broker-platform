'use client';

import { useEffect, useState } from 'react';
import { apiGet } from '@/lib/api';
import { FileText, Download } from 'lucide-react';

interface DocItem {
  id: string;
  name: string;
  description: string | null;
  type: string;
  fileUrl: string;
  fileSize: number | null;
  isPublic: boolean;
}

function formatSize(bytes: number | null): string {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function DocumentsPage() {
  const [documents, setDocuments] = useState<DocItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true); setError('');
    try {
      const data = await apiGet('/documents?category=cooperation&limit=200');
      setDocuments(data.documents || []);
    } catch (e: any) {
      setError(e.message || 'Ошибка загрузки');
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-3xl font-bold">Документы</h1>
        <p className="text-text-muted text-sm mt-1">Регламенты, договоры, условия сотрудничества</p>
      </div>

      {error && <div className="mb-4 p-4 rounded-lg bg-error/20 text-error text-sm">{error}</div>}

      <div className="card">
        {loading ? (
          <div className="text-center py-8 text-text-muted">Загрузка...</div>
        ) : documents.length === 0 ? (
          <div className="text-center py-8 text-text-muted">
            <FileText className="w-12 h-12 mx-auto mb-3 text-text-muted/50" />
            Документы пока не добавлены
          </div>
        ) : (
          <div className="space-y-3">
            {documents.map((doc) => (
              <div
                key={doc.id}
                className="flex items-center justify-between py-3 border-b border-border last:border-0 hover:bg-surface-secondary rounded-lg px-3 -mx-3 transition"
              >
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  <div className="w-10 h-10 bg-accent/10 rounded-lg flex items-center justify-center flex-shrink-0">
                    <FileText className="w-5 h-5 text-accent" />
                  </div>
                  <div className="min-w-0">
                    <div className="font-medium text-sm truncate">{doc.name}</div>
                    <div className="text-xs text-text-muted">
                      {doc.type}{doc.fileSize ? ` · ${formatSize(doc.fileSize)}` : ''}
                      {doc.description ? ` · ${doc.description}` : ''}
                    </div>
                  </div>
                </div>
                <a
                  href={doc.fileUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn btn-secondary flex items-center gap-2 ml-3"
                >
                  <Download className="w-4 h-4" />
                  Открыть
                </a>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
