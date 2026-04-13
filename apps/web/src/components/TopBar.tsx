'use client';

import { Bell, User, LogOut, Menu } from 'lucide-react';
import { useAuth } from '@/lib/auth';

export function TopBar({ onMenuToggle }: { onMenuToggle?: () => void }) {
  const { broker, logout } = useAuth();

  return (
    <header className="bg-surface border-b border-border px-4 sm:px-6 py-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-3">
          {onMenuToggle && (
            <button
              onClick={onMenuToggle}
              className="lg:hidden p-2 hover:bg-surface-secondary rounded-lg"
            >
              <Menu className="w-5 h-5" />
            </button>
          )}
          <h1 className="text-lg sm:text-xl font-semibold">Личный кабинет</h1>
        </div>

        <div className="flex items-center space-x-2 sm:space-x-4">
          <button className="p-2 hover:bg-surface-secondary rounded-lg">
            <Bell className="w-5 h-5" />
          </button>

          <div className="flex items-center space-x-2 sm:space-x-3">
            <div className="w-8 h-8 bg-accent rounded-full flex items-center justify-center flex-shrink-0">
              <User className="w-4 h-4 text-background" />
            </div>
            <div className="text-sm hidden sm:block">
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
