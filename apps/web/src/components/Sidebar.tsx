'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Users,
  Building,
  HeartHandshake,
  Calculator,
  Calendar,
  FileText,
  Settings,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const navigation = [
  { name: 'Фиксация клиентов', href: '/fixation', icon: Users },
  { name: 'Клиенты', href: '/clients', icon: Users },
  { name: 'Каталог', href: '/catalog', icon: Building },
  { name: 'Сделки', href: '/deals', icon: HeartHandshake },
  { name: 'Комиссия', href: '/commission', icon: Calculator },
  { name: 'Встречи', href: '/meetings', icon: Calendar },
  { name: 'Документы', href: '/documents', icon: FileText },
  { name: 'Профиль', href: '/profile', icon: Settings },
];

export function Sidebar({ open, onClose }: { open?: boolean; onClose?: () => void }) {
  const pathname = usePathname();

  return (
    <>
      {/* Mobile overlay */}
      {open && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={onClose}
        />
      )}

      {/* Sidebar */}
      <div
        className={cn(
          'fixed top-0 left-0 z-50 h-full w-64 bg-surface border-r border-border transition-transform duration-200 ease-in-out lg:static lg:translate-x-0 lg:z-auto',
          open ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        <div className="p-6 flex items-center justify-between">
          <div>
            <h2 className="text-xl font-bold text-accent">ST Michael</h2>
            <p className="text-sm text-text-muted">Кабинет брокера</p>
          </div>
          {onClose && (
            <button
              onClick={onClose}
              className="lg:hidden p-2 hover:bg-surface-secondary rounded-lg"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>

        <nav className="px-4">
          <ul className="space-y-2">
            {navigation.map((item) => {
              const isActive = pathname === item.href;
              return (
                <li key={item.name}>
                  <Link
                    href={item.href}
                    onClick={onClose}
                    className={cn(
                      'flex items-center px-4 py-2 text-sm font-medium rounded-lg transition-colors',
                      isActive
                        ? 'bg-accent text-background'
                        : 'text-text hover:bg-surface-secondary'
                    )}
                  >
                    <item.icon className="w-5 h-5 mr-3" />
                    {item.name}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </div>
    </>
  );
}
