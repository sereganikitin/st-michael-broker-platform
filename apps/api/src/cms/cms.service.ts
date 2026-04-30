import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@st-michael/database';

const KNOWN_KEYS = ['hero', 'advantages', 'commission', 'contact'] as const;

const DEFAULT_CONTENT: Record<string, any> = {
  hero: {
    tag: 'Партнёрская программа',
    title: 'Зарабатывайте от 5% до 8% комиссии',
    titleAccent: '8% комиссии',
    description:
      'Продавайте апартаменты Зорге 9 и Квартал Серебряный Бор. Прогрессивная шкала, личный кабинет, выделенная поддержка на каждом этапе сделки.',
    stats: [
      { number: '5–8%', label: 'Средняя комиссия по программе' },
      { number: '5 дней', label: 'Скорость фиксации клиента' },
      { number: '30 дней', label: 'Срок уникальности' },
      { number: '2', label: 'Активных проекта' },
    ],
  },
  advantages: {
    tag: 'Преимущества',
    title: 'Почему брокеры выбирают нас',
    titleAccent: 'выбирают нас',
    items: [
      { title: 'Выделенный отдел партнёров', description: 'Команда всегда на связи для решения любых вопросов по сделкам и клиентам.' },
      { title: '30 дней фиксации клиента', description: 'Один из самых длинных сроков фиксации на рынке. С возможностью продления.' },
      { title: 'Выплата за 5 рабочих дней', description: 'Один из самых коротких сроков выплаты комиссионного вознаграждения.' },
      { title: 'Личный кабинет брокера', description: 'Фиксация клиентов, просмотр комиссии, каталог объектов, статусы сделок.' },
      { title: 'Прогрессивная шкала 5-8%', description: 'Накопительная программа по агентству. Квартальные бонусы сверху.' },
      { title: 'Рекламные материалы', description: 'Готовые тексты, визуалы для соцсетей, брошюры, планировки, видео.' },
    ],
  },
  commission: {
    tag: 'Комиссия и условия выплаты',
    title: 'Прогрессивная шкала вознаграждения',
    titleAccent: 'шкала',
    subtitle: 'Чем больше продаёте — тем выше ставка. Накопление по агентству, по обоим проектам.',
    levels: [
      { name: 'Start', range: '0-59 м2', rate: '5,0%', active: false },
      { name: 'Basic', range: '60-119 м2', rate: '5,5%', active: false },
      { name: 'Strong', range: '120-199 м2', rate: '6,0%', active: true },
      { name: 'Premium', range: '200-319 м2', rate: '6,5%', active: false },
      { name: 'Elite', range: '320-499 м2', rate: '7,0%', active: false },
      { name: 'Champion', range: '500-699 м2', rate: '7,5%', active: false },
      { name: 'Legend', range: '700+ м2', rate: '8,0%', active: false },
    ],
    cards: [
      { title: 'Условия выплаты', text: 'Выплата в течение 5 рабочих дней с момента оплаты клиентом не менее 50% (Зорге 9) или 30% (Серебряный Бор) от суммы договора.' },
      { title: 'Квартальный бонус', text: 'При уровне Strong и выше несколько кварталов подряд: +0,1% — +0,15% — +0,2% — +0,25% (максимум).' },
      { title: 'Рассрочка и ипотека', text: 'При рассрочке ставка уменьшается на 0,5%. При субсидированной ипотеке — фиксированные 4%.' },
      { title: 'Коммерческие помещения', text: 'Продажа — 3%. Фитнес — 3%. Отдельные здания — 2%. Аренда ритейл — 100% месячного платежа.' },
    ],
  },
  contact: {
    tag: 'Команда',
    title: 'Всегда на связи',
    titleAccent: 'на связи',
    description: 'В нашем бизнесе процессы запускают точные коммуникации с партнёрами. Мы всегда готовы найти индивидуальный подход к каждому брокеру и агентству.',
    blockTitle: 'Отдел по работе с партнёрами',
    phone: '+7 (495) 150-40-10',
    email: 'broker@stmichael.ru',
    telegram: 'https://t.me/stmichaelBroker',
  },
};

@Injectable()
export class CmsService {
  constructor(@Inject('PrismaClient') private prisma: PrismaClient) {}

  async getAllContent() {
    const rows = await this.prisma.siteContent.findMany();
    const map: Record<string, any> = { ...DEFAULT_CONTENT };
    for (const r of rows) map[r.key] = r.value;
    return map;
  }

  async getContent(key: string) {
    const row = await this.prisma.siteContent.findUnique({ where: { key } });
    return row?.value ?? DEFAULT_CONTENT[key] ?? null;
  }

  async upsertContent(key: string, value: any, updatedBy?: string) {
    return this.prisma.siteContent.upsert({
      where: { key },
      update: { value, updatedBy },
      create: { key, value, updatedBy },
    });
  }

  // ─── Events ─────────────────────────────────────

  async listEvents(opts: { onlyActive?: boolean; onlyFuture?: boolean } = {}) {
    const where: any = {};
    if (opts.onlyActive) where.isActive = true;
    if (opts.onlyFuture) where.date = { gte: new Date() };
    return this.prisma.landingEvent.findMany({
      where,
      orderBy: [{ date: 'asc' }, { sortOrder: 'asc' }],
    });
  }

  async createEvent(data: any) {
    return this.prisma.landingEvent.create({
      data: {
        date: new Date(data.date),
        title: data.title,
        location: data.location || null,
        isOnline: !!data.isOnline,
        description: data.description || null,
        sortOrder: Number(data.sortOrder) || 0,
        isActive: data.isActive !== false,
      },
    });
  }

  async updateEvent(id: string, data: any) {
    const patch: any = {};
    if (data.date !== undefined) patch.date = new Date(data.date);
    if (data.title !== undefined) patch.title = data.title;
    if (data.location !== undefined) patch.location = data.location || null;
    if (data.isOnline !== undefined) patch.isOnline = !!data.isOnline;
    if (data.description !== undefined) patch.description = data.description || null;
    if (data.sortOrder !== undefined) patch.sortOrder = Number(data.sortOrder) || 0;
    if (data.isActive !== undefined) patch.isActive = !!data.isActive;
    return this.prisma.landingEvent.update({ where: { id }, data: patch });
  }

  async deleteEvent(id: string) {
    await this.prisma.landingEvent.delete({ where: { id } });
    return { deleted: true };
  }

  // ─── Projects ───────────────────────────────────

  async listProjects(onlyActive = false) {
    const where: any = {};
    if (onlyActive) where.isActive = true;
    return this.prisma.landingProject.findMany({
      where,
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async createProject(data: any) {
    if (!data.slug || !data.name || !data.description) {
      throw new NotFoundException('slug, name, description обязательны');
    }
    return this.prisma.landingProject.create({
      data: {
        slug: data.slug,
        tag: data.tag || null,
        name: data.name,
        subtitle: data.subtitle || null,
        description: data.description,
        ctaText: data.ctaText || null,
        ctaHref: data.ctaHref || null,
        sortOrder: Number(data.sortOrder) || 0,
        isActive: data.isActive !== false,
      },
    });
  }

  async updateProject(id: string, data: any) {
    const patch: any = {};
    for (const k of ['slug', 'tag', 'name', 'subtitle', 'description', 'ctaText', 'ctaHref'] as const) {
      if (data[k] !== undefined) patch[k] = data[k] || null;
    }
    if (patch.name === null) delete patch.name; // name required
    if (patch.description === null) delete patch.description;
    if (data.sortOrder !== undefined) patch.sortOrder = Number(data.sortOrder) || 0;
    if (data.isActive !== undefined) patch.isActive = !!data.isActive;
    return this.prisma.landingProject.update({ where: { id }, data: patch });
  }

  async deleteProject(id: string) {
    await this.prisma.landingProject.delete({ where: { id } });
    return { deleted: true };
  }

  // ─── Bootstrap ─────────────────────────────────

  // Seeds default content (idempotent — only inserts if missing)
  async seedDefaults() {
    for (const key of KNOWN_KEYS) {
      const exists = await this.prisma.siteContent.findUnique({ where: { key } });
      if (!exists) {
        await this.prisma.siteContent.create({
          data: { key, value: DEFAULT_CONTENT[key] },
        });
      }
    }

    const projectsCount = await this.prisma.landingProject.count();
    if (projectsCount === 0) {
      await this.prisma.landingProject.createMany({
        data: [
          {
            slug: 'zorge9',
            tag: 'Приоритетный проект',
            name: 'Зорге',
            subtitle: '9',
            description:
              'Апартаменты бизнес-класса у метро Полежаевская. 3 корпуса, архитектура в стиле Арт-Москва. От 270 000 р/м2.',
            ctaText: 'Смотреть каталог',
            sortOrder: 0,
          },
          {
            slug: 'silver-bor',
            tag: 'Новый проект',
            name: 'Квартал',
            subtitle: 'Серебряный Бор',
            description:
              'Жилой комплекс премиум-класса рядом с Серебряным Бором. Уникальная локация и инфраструктура.',
            ctaText: 'Смотреть каталог',
            sortOrder: 1,
          },
        ],
      });
    }

    return { seeded: true };
  }
}
