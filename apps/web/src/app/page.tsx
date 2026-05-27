// 2026-05-27 SSR root для лендинга. Раньше root был client-component,
// fetch CMS делал useEffect → пользователь видел DEFAULT_ при загрузке,
// потом моргание на свежий текст. Теперь fetch здесь, на сервере,
// HTML отдаётся уже с актуальными данными. Без скачка.
//
// `dynamic = 'force-dynamic'` гарантирует что Next.js НЕ кеширует HTML
// и не пытается ISR-revalidation. На каждый запрос делает свежий fetch.

import LandingClient, { type LandingInitialData } from './LandingClient';

export const dynamic = 'force-dynamic';

// API хост для server-side fetch. Внутри docker-сети — http://api:4000.
// Снаружи — публичный домен. Env переменная NEXT_PUBLIC_API_URL не подходит
// (она для клиента), поэтому используем INTERNAL_API_URL c фолбэком.
function getApiBase(): string {
  return process.env.INTERNAL_API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://api:4000';
}

async function safeFetch<T = any>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

export default async function Page() {
  const base = getApiBase();
  const [
    content,
    events,
    projects,
    promos,
    cooperationDocs,
    analyticsDocs,
    marketingDocs,
    materialsDocs,
    news,
    activePolicies,
  ] = await Promise.all([
    safeFetch<any>(`${base}/api/public/cms/content`),
    safeFetch<any[]>(`${base}/api/public/cms/events`),
    safeFetch<any[]>(`${base}/api/public/cms/projects`),
    safeFetch<any[]>(`${base}/api/public/cms/promos`),
    safeFetch<any>(`${base}/api/public/documents?category=cooperation`),
    safeFetch<any>(`${base}/api/public/documents?category=analytics`),
    safeFetch<any>(`${base}/api/public/documents?category=marketing`),
    safeFetch<any>(`${base}/api/public/documents?category=materials`),
    safeFetch<any[]>(`${base}/api/public/cms/news`),
    safeFetch<any[]>(`${base}/api/public/cms/commission-policies/active`),
  ]);

  // Документы приходят в формате { documents: [...] } — разворачиваем.
  const unwrapDocs = (d: any): any[] =>
    Array.isArray(d?.documents) ? d.documents : Array.isArray(d) ? d : [];

  const initialData: LandingInitialData = {
    content: content || undefined,
    events: Array.isArray(events) ? events : [],
    projects: Array.isArray(projects) ? projects : [],
    promos: Array.isArray(promos) ? promos : [],
    cooperationDocs: unwrapDocs(cooperationDocs),
    analyticsDocs: unwrapDocs(analyticsDocs),
    marketingDocs: unwrapDocs(marketingDocs),
    materialsDocs: unwrapDocs(materialsDocs),
    news: Array.isArray(news) ? news : [],
    activePolicies: Array.isArray(activePolicies) ? activePolicies : [],
  };

  return <LandingClient initialData={initialData} />;
}
