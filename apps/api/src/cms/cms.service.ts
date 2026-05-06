import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@st-michael/database';

const KNOWN_KEYS = ['hero', 'advantages', 'commission', 'contact'] as const;

const DEFAULT_CONTENT: Record<string, any> = {
  hero: {
    tag: 'Партнёрская программа',
    title: 'Доход растёт вместе с объёмом продаж агентства',
    titleAccent: 'продаж агентства',
    description:
      'Суммируем сделки по Зорге 9 и Кварталу Серебряный Бор — вы быстрее выходите на более высокий уровень комиссии. До 8% по Зорге 9 и до 6,25% по Серебряному Бору.',
    stats: [
      { number: 'до 8%', label: 'Максимальная ставка по Зорге 9' },
      { number: '7 дней', label: 'Выплата вознаграждения' },
      { number: '30 дней', label: 'Срок уникальности клиента' },
      { number: '2', label: 'Активных проекта' },
    ],
  },
  advantages: {
    tag: 'Преимущества',
    title: 'Почему брокеры выбирают нас',
    titleAccent: 'выбирают нас',
    items: [
      { title: 'Выделенный отдел партнёров', description: 'Сопровождение на всех этапах сделки.' },
      { title: 'Выделенная линия', description: 'Ответ без ожидания с 9:00 до 21:00.' },
      { title: 'Быстрые выплаты', description: 'Вознаграждение — до 7 рабочих дней.' },
      { title: 'Высокая комиссия', description: 'До 8% — одна из лучших на рынке.' },
      { title: 'Партнёрство', description: 'Работаем на общий результат.' },
      { title: 'Обучение', description: 'Брокер-туры для быстрого старта продаж.' },
    ],
  },
  commission: {
    tag: 'Комиссия и условия выплаты',
    title: 'Прогрессивная шкала вознаграждения',
    titleAccent: 'шкала',
    subtitle: 'Метраж суммируется по обоим проектам в рамках одного агентства. Действует с 1 января по 30 июня 2026 года.',
    levelsByProject: {
      ZORGE9: [
        { name: 'Start', range: '0–59 м²', rate: '5,0%', active: false },
        { name: 'Basic', range: '60–119 м²', rate: '5,5%', active: false },
        { name: 'Strong', range: '120–199 м²', rate: '6,0%', active: true },
        { name: 'Premium', range: '200–319 м²', rate: '6,5%', active: false },
        { name: 'Elite', range: '320–499 м²', rate: '7,0%', active: false },
        { name: 'Champion', range: '500–699 м²', rate: '7,5%', active: false },
        { name: 'Legend', range: '700+ м²', rate: '8,0%', active: false },
      ],
      SILVER_BOR: [
        { name: 'Start', range: '0–47 м²', rate: '5,0%', active: false },
        { name: 'Basic', range: '48–95 м²', rate: '5,25%', active: false },
        { name: 'Strong', range: '96–170 м²', rate: '5,5%', active: true },
        { name: 'Premium', range: '171–279 м²', rate: '5,75%', active: false },
        { name: 'Elite', range: '280–399 м²', rate: '6,0%', active: false },
        { name: 'Champion', range: '400+ м²', rate: '6,25%', active: false },
      ],
    },
    levels: [
      { name: 'Start', range: '0–59 м²', rate: '5,0%', active: false },
      { name: 'Basic', range: '60–119 м²', rate: '5,5%', active: false },
      { name: 'Strong', range: '120–199 м²', rate: '6,0%', active: true },
      { name: 'Premium', range: '200–319 м²', rate: '6,5%', active: false },
      { name: 'Elite', range: '320–499 м²', rate: '7,0%', active: false },
      { name: 'Champion', range: '500–699 м²', rate: '7,5%', active: false },
      { name: 'Legend', range: '700+ м²', rate: '8,0%', active: false },
    ],
    cards: [
      { title: 'Условия выплаты', text: 'Вознаграждение выплачивается в течение 7 рабочих дней после оплаты клиентом. ПВ ≥ 50% (Зорге 9) или ≥ 30% (Серебряный Бор) — единовременно.' },
      { title: 'Квартальный бонус', text: 'При уровне Strong+ несколько кварталов подряд: +0,1% → +0,15% → +0,2% → +0,25% (максимум). Обнуляется при отсутствии продаж в квартале.' },
      { title: 'Бонус за скорость', text: '+0,1% к ставке, если от заявки клиента до платной брони проходит не более 10 рабочих дней. Действует на оба проекта.' },
      { title: 'Годовой бонус', text: '100 000 ₽ + памятный кубок за минимум одну сделку раз в 2 месяца в течение года.' },
      { title: 'Рассрочка и ипотека', text: 'При рассрочке —0,5% от базовой ставки. Субсидированная ипотека — 4% (м² идут в общий зачёт).' },
      { title: 'Коммерческие помещения', text: 'Продажа: помещения и фитнес — 3%, отдельно стоящие здания — 2%. Аренда: ритейл — 100% мес. платежа, фитнес/офис — 50%.' },
      { title: 'Реферальная программа', text: 'Дополнительное вознаграждение за привлечение новых партнёров в программу.' },
    ],
  },
  contact: {
    tag: 'Команда',
    title: 'Всегда на связи',
    titleAccent: 'на связи',
    description: 'В наши бизнес-процессы заложена тесная коммуникация с партнёрами. Горячая линия по работе с партнёрами работает каждый день с 9:00 до 21:00.',
    blockTitle: 'Горячая линия по работе с партнёрами',
    phone: '+7 (499) 226-22-49',
    phoneHours: 'Ежедневно с 9:00 до 21:00',
    email: 'broker@stmichael.ru',
    telegram: 'https://t.me/stmichaelBroker',
    manager: {
      name: 'Ксения Цепляева',
      role: 'Руководитель отдела по работе с партнёрами',
      phone: '+7 (906) 061-78-00',
    },
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

  async getProjectBySlug(slug: string) {
    return this.prisma.landingProject.findUnique({ where: { slug } });
  }

  async updateProject(id: string, data: any) {
    const patch: any = {};
    for (const k of ['slug', 'tag', 'name', 'subtitle', 'description', 'ctaText', 'ctaHref',
                     'imageUrl', 'classType', 'address', 'district'] as const) {
      if (data[k] !== undefined) patch[k] = data[k] || null;
    }
    if (patch.name === null) delete patch.name;
    if (patch.description === null) delete patch.description;
    for (const k of ['totalUnits', 'floorsTotal', 'buildingsCount', 'readyQuarter', 'readyYear'] as const) {
      if (data[k] !== undefined) patch[k] = data[k] === null ? null : Number(data[k]);
    }
    for (const k of ['pricePerSqmFrom', 'commissionFrom', 'commissionTo'] as const) {
      if (data[k] !== undefined) patch[k] = data[k] === null ? null : Number(data[k]);
    }
    if (data.gallery !== undefined) patch.gallery = data.gallery;
    if (data.characteristics !== undefined) patch.characteristics = data.characteristics;
    if (data.sortOrder !== undefined) patch.sortOrder = Number(data.sortOrder) || 0;
    if (data.isActive !== undefined) patch.isActive = !!data.isActive;
    return this.prisma.landingProject.update({ where: { id }, data: patch });
  }

  async deleteProject(id: string) {
    await this.prisma.landingProject.delete({ where: { id } });
    return { deleted: true };
  }

  // ─── Promos (slider — block 3) ──────────────────

  async listPromos(onlyActive = false) {
    const where: any = {};
    if (onlyActive) {
      where.isActive = true;
      where.OR = [{ expiresAt: null }, { expiresAt: { gt: new Date() } }];
    }
    return this.prisma.landingPromo.findMany({
      where,
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
    });
  }

  async createPromo(data: any) {
    return this.prisma.landingPromo.create({
      data: {
        title: data.title,
        subtitle: data.subtitle || null,
        description: data.description || null,
        tag: data.tag || null,
        imageUrl: data.imageUrl || null,
        ctaText: data.ctaText || null,
        ctaHref: data.ctaHref || null,
        project: data.project || null,
        sortOrder: Number(data.sortOrder) || 0,
        isActive: data.isActive !== false,
        expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
      },
    });
  }

  async updatePromo(id: string, data: any) {
    const patch: any = {};
    for (const k of ['title', 'subtitle', 'description', 'tag', 'imageUrl', 'ctaText', 'ctaHref', 'project'] as const) {
      if (data[k] !== undefined) patch[k] = data[k] || null;
    }
    if (data.sortOrder !== undefined) patch.sortOrder = Number(data.sortOrder) || 0;
    if (data.isActive !== undefined) patch.isActive = !!data.isActive;
    if (data.expiresAt !== undefined) patch.expiresAt = data.expiresAt ? new Date(data.expiresAt) : null;
    return this.prisma.landingPromo.update({ where: { id }, data: patch });
  }

  async deletePromo(id: string) {
    await this.prisma.landingPromo.delete({ where: { id } });
    return { deleted: true };
  }

  // ─── Contact requests / event signups ────────────

  async createContactRequest(
    data: { name: string; phone: string; email?: string; message?: string; source?: string; eventId?: string },
    ip: string | null,
    userAgent: string | null,
  ) {
    if (!data.name || data.name.trim().length < 2) throw new NotFoundException('name required');
    if (!data.phone || data.phone.trim().length < 5) throw new NotFoundException('phone required');

    return this.prisma.contactRequest.create({
      data: {
        name: data.name.trim(),
        phone: data.phone.trim(),
        email: data.email?.trim() || null,
        message: data.message?.trim() || null,
        source: data.source || 'landing-contact',
        eventId: data.eventId || null,
        ip,
        userAgent,
      },
    });
  }

  async listContactRequests(query: { page?: number; limit?: number; source?: string; processed?: string }) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (query.source) where.source = query.source;
    if (query.processed === 'true') where.processedAt = { not: null };
    else if (query.processed === 'false') where.processedAt = null;

    const [items, total] = await Promise.all([
      this.prisma.contactRequest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.contactRequest.count({ where }),
    ]);

    return { items, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async markContactProcessed(id: string, userId: string) {
    return this.prisma.contactRequest.update({
      where: { id },
      data: { processedAt: new Date(), processedBy: userId },
    });
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
