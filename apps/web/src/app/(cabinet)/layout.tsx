'use client';

import { Sidebar } from '@/components/Sidebar';
import { TopBar } from '@/components/TopBar';
import { useAuth } from '@/lib/auth';

export default function CabinetLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { broker, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-text-muted">Загрузка...</div>
      </div>
    );
  }

  if (!broker) return null; // Redirect handled by AuthProvider

  return (
    <div className="min-h-screen bg-background">
      <TopBar />
      <div className="flex">
        <Sidebar />
        <main className="flex-1 p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
