'use client';

import { useEffect, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';

interface Offer {
  version: string;
  title: string;
  body: string;
  updatedAt: string;
}

// Публичная страница оферты — доступна без авторизации (для ссылки с
// формы регистрации). Внутри кабинета есть аналогичная страница
// /documents/offer с возможностью принять акцепт (если ещё не принят).
export default function PublicOfferPage() {
  const [offer, setOffer] = useState<Offer | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/offer/current')
      .then((r) => (r.ok ? r.json() : null))
      .then(setOffer)
      .catch(() => setOffer(null))
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
        ) : !offer ? (
          <div className="text-error">Не удалось загрузить текст оферты.</div>
        ) : (
          <article className="card">
            <h1 className="text-2xl md:text-3xl font-bold mb-2">{offer.title}</h1>
            <p className="text-sm text-text-muted mb-6">
              Версия {offer.version} · обновлено {new Date(offer.updatedAt).toLocaleDateString('ru-RU')}
            </p>
            <div className="prose prose-sm max-w-none whitespace-pre-wrap leading-relaxed text-text">
              {offer.body}
            </div>
          </article>
        )}
      </main>
    </div>
  );
}
