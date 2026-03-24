'use client';

import { Bell, User, LogOut } from 'lucide-react';
import { useAuth } from '@/lib/auth';

export function TopBar() {
  const { broker, logout } = useAuth();

  return (
    <header className="bg-surface border-b border-border px-6 py-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-4">
          <h1 className="text-xl font-semibold">Личный кабинет</h1>
        </div>

        <div className="flex items-center space-x-4">
          <button className="p-2 hover:bg-surface-secondary rounded-lg">
            <Bell className="w-5 h-5" />
          </button>

          <div className="flex items-center space-x-3">
            <div className="w-8 h-8 bg-accent rounded-full flex items-center justify-center">
              <User className="w-4 h-4 text-background" />
            </div>
            <div className="text-sm">
              <div className="font-medium">{broker?.fullName || 'Брокер'}</div>
              <div className="text-text-muted text-xs">{broker?.phone}</div>
            </div>
            <button
              onClick={logout}
              className="p-2 hover:bg-surface-secondary rounded-lg text-text-muted hover:text-error"
              title="Выйти"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </header>
  );
}
