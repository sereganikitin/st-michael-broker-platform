'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  Users,
  Building,
  HeartHandshake,
  Calculator,
  Calendar,
  FileText,
  BarChart3,
  Settings,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const navigation = [
  { name: 'Дашборд', href: '/dashboard', icon: LayoutDashboard },
  { name: 'Фиксация клиентов', href: '/fixation', icon: Users },
  { name: 'Клиенты', href: '/clients', icon: Users },
  { name: 'Каталог', href: '/catalog', icon: Building },
  { name: 'Сделки', href: '/deals', icon: HeartHandshake },
  { name: 'Комиссия', href: '/commission', icon: Calculator },
  { name: 'Встречи', href: '/meetings', icon: Calendar },
  { name: 'Документы', href: '/documents', icon: FileText },
  { name: 'Аналитика', href: '/analytics', icon: BarChart3 },
  { name: 'Профиль', href: '/profile', icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <div className="w-64 bg-surface min-h-screen border-r border-border">
      <div className="p-6">
        <h2 className="text-xl font-bold text-accent">ST Michael</h2>
        <p className="text-sm text-text-muted">Кабинет брокера</p>
      </div>

      <nav className="px-4">
        <ul className="space-y-2">
          {navigation.map((item) => {
            const isActive = pathname === item.href;
            return (
              <li key={item.name}>
                <Link
                  href={item.href}
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
  );
}