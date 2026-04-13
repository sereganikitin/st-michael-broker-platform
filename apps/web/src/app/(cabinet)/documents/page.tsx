'use client';

import { useEffect, useState } from 'react';
import { apiGet } from '@/lib/api';
import { FileText, Download, RefreshCw, ExternalLink } from 'lucide-react';

interface DocItem {
  name: string;
  url: string;
  type: string;
}

export default function DocumentsPage() {
  const [documents, setDocuments] = useState<DocItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState<string>('');
  const [source, setSource] = useState('');

  const loadDocs = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await apiGet('/documents/external');
      setDocuments(data.documents || []);
      setLastUpdated(data.fetchedAt ? new Date(data.fetchedAt).toLocaleTimeString('ru-RU') : '');
      setSource(data.source || '');
    } catch (e: any) {
      setError(e.message || 'Ошибка загрузки документов');
    }
    setLoading(false);
  };

  useEffect(() => { loadDocs(); }, []);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold">Документы</h1>
          {lastUpdated && (
            <span className="text-text-muted text-sm">Обновлено: {lastUpdated}</span>
          )}
        </div>
        <div className="flex gap-3">
          <button
            className="btn btn-secondary flex items-center gap-2"
            onClick={loadDocs}
            disabled={loading}
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            {loading ? 'Загрузка...' : 'Обновить'}
          </button>
          {source && (
            <a
              href={source}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-secondary flex items-center gap-2"
            >
              <ExternalLink className="w-4 h-4" />
              Источник
            </a>
          )}
        </div>
      </div>

      {error && (
        <div className="mb-4 p-4 rounded-lg bg-error/20 text-error text-sm">{error}</div>
      )}

      <div className="card">
        {loading && documents.length === 0 ? (
          <div className="text-center py-8 text-text-muted">Загрузка документов...</div>
        ) : documents.length === 0 && !error ? (
          <div className="text-center py-8 text-text-muted">
            <FileText className="w-12 h-12 mx-auto mb-3 text-text-muted/50" />
            Документы не найдены
          </div>
        ) : (
          <div className="space-y-3">
            {documents.map((doc, i) => (
              <div
                key={i}
                className="flex items-center justify-between py-3 border-b border-border last:border-0 hover:bg-surface-secondary rounded-lg px-3 -mx-3 transition"
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-accent/10 rounded-lg flex items-center justify-center">
                    <FileText className="w-5 h-5 text-accent" />
                  </div>
                  <div>
                    <div className="font-medium text-sm">{doc.name}</div>
                    <div className="text-xs text-text-muted">{doc.type}</div>
                  </div>
                </div>
                <a
                  href={doc.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn btn-secondary flex items-center gap-2"
                >
                  <Download className="w-4 h-4" />
                  Скачать
                </a>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
