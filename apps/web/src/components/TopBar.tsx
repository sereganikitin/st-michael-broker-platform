'use client';

import { Bell, User } from 'lucide-react';

export function TopBar() {
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

          <div className="flex items-center space-x-2">
            <div className="w-8 h-8 bg-accent rounded-full flex items-center justify-center">
              <User className="w-4 h-4 text-background" />
            </div>
            <span className="text-sm font-medium">Брокер</span>
          </div>
        </div>
      </div>
    </header>
  );
}