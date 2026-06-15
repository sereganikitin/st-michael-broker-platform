'use client';

import { useEffect, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';

interface Privacy {
  version: string;
  title: string;
  body: string;
  updatedAt: string;
}

// Публичная страница согласия на обработку ПД (152-ФЗ) — доступна без
// авторизации. Ссылка на странице регистрации возле чек-бокса.
export default function PublicPrivacyPage() {
  const [privacy, setPrivacy] = useState<Privacy | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/privacy/current')
      .then((r) => (r.ok ? r.json() : null))
      .then(setPrivacy)
      .catch(() => setPrivacy(null))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-surface">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between">
          <Link href="/register" className="text-text-muted hover:text-text flex items-center gap-1 text-sm">
            <ArrowLeft className="w-4 h-4" /> Назад к регистрации
          </Link>
          <span className="text-xs text-text-muted">ST Michael · Кабинет брокера</span>
        </div>
      </header>
      <main className="max-w-4xl mx-auto px-4 py-8">
        {loading ? (
          <div className="text-text-muted">Загрузка…</div>
        ) : !privacy ? (
          <div className="text-error">Не удалось загрузить текст согласия.</div>
        ) : (
          <article className="card">
            <h1 className="text-2xl md:text-3xl font-bold mb-2">{privacy.title}</h1>
            <p className="text-sm text-text-muted mb-6">
              Версия {privacy.version} · обновлено {new Date(privacy.updatedAt).toLocaleDateString('ru-RU')}
            </p>
            <div className="prose prose-sm max-w-none whitespace-pre-wrap leading-relaxed text-text">
              {privacy.body}
            </div>
          </article>
        )}
      </main>
    </div>
  );
}
