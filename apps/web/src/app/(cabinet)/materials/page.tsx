'use client';

import { BookOpen, Image as ImageIcon, Video, FileText, ExternalLink } from 'lucide-react';

const sections = [
  {
    title: 'Тексты для рекламы',
    icon: FileText,
    items: [
      { name: 'Описание проекта Зорге 9', desc: 'Готовые тексты для соцсетей и сайтов' },
      { name: 'Описание проекта Серебряный бор', desc: 'Готовые тексты для соцсетей и сайтов' },
      { name: 'Коммерческие помещения', desc: 'Фитнес, ритейл, офисы' },
    ],
  },
  {
    title: 'Планировки и рендеры',
    icon: ImageIcon,
    items: [
      { name: 'Планировки Зорге 9', desc: 'PDF, PNG в высоком разрешении' },
      { name: 'Планировки Серебряный бор', desc: 'PDF, PNG в высоком разрешении' },
      { name: 'Рендеры фасадов', desc: 'Визуализации для соцсетей' },
    ],
  },
  {
    title: 'Видеоматериалы',
    icon: Video,
    items: [
      { name: 'Видеопрезентации проектов', desc: 'Роликb 1-3 минуты' },
      { name: 'Съёмка с дрона', desc: 'Аэросъёмка территории' },
    ],
  },
  {
    title: 'Регламенты и гайды',
    icon: BookOpen,
    items: [
      { name: 'Регламент размещения рекламы', desc: 'Правила использования бренда' },
      { name: 'Инструкции по работе с клиентами', desc: 'Скрипты и сценарии' },
    ],
  },
];

export default function MaterialsPage() {
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-3xl font-bold">Материалы для брокеров</h1>
        <p className="text-text-muted text-sm mt-1">
          Готовый контент для продвижения проектов ST Michael
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {sections.map((section) => (
          <div key={section.title} className="card">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-accent/10 rounded-lg flex items-center justify-center">
                <section.icon className="w-5 h-5 text-accent" />
              </div>
              <h3 className="font-semibold">{section.title}</h3>
            </div>
            <div className="space-y-2">
              {section.items.map((item) => (
                <div
                  key={item.name}
                  className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-surface-secondary cursor-pointer transition"
                >
                  <div>
                    <div className="text-sm font-medium">{item.name}</div>
                    <div className="text-xs text-text-muted">{item.desc}</div>
                  </div>
                  <ExternalLink className="w-4 h-4 text-text-muted flex-shrink-0" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="card mt-6 text-center py-8 bg-surface-secondary">
        <BookOpen className="w-12 h-12 mx-auto mb-3 text-text-muted" />
        <p className="text-text-muted">
          По вопросам получения материалов обращайтесь в отдел по работе с партнёрами:
        </p>
        <p className="mt-2">
          <a href="tel:+74951504010" className="text-accent font-medium">
            +7 (495) 150-40-10
          </a>
          <span className="text-text-muted mx-3">•</span>
          <a href="mailto:broker@stmichael.ru" className="text-accent font-medium">
            broker@stmichael.ru
          </a>
        </p>
      </div>
    </div>
  );
}
