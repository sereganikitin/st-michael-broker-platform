#!/usr/bin/env node
/**
 * Перезаписывает (UPSERT) блоки SiteContent в БД новыми дефолтами по ТЗ 2026-05-04.
 *
 * Зачем нужен: cms.seedDefaults создаёт записи только если их нет. После
 * редактирования DEFAULT_CONTENT в коде старые записи в БД остаются
 * неизменными и затирают новые дефолты при рендере лендинга.
 *
 * Запуск (на сервере где есть доступ к БД):
 *   cd packages/database && npm install
 *   node ../../scripts/refresh-cms-content.js
 *
 * Безопасно — только перезаписывает 4 ключа (hero, advantages, commission, contact).
 * Записи projects/promos/events не трогает.
 */

let PrismaClient;
try {
  ({ PrismaClient } = require('@prisma/client'));
} catch (_) {
  try {
    ({ PrismaClient } = require('../packages/database/node_modules/@prisma/client'));
  } catch (e) {
    console.error('Cannot find @prisma/client. Run `npm install` in packages/database first.');
    process.exit(1);
  }
}

const HERO = {
  tag: 'Партнёрская программа',
  // \n даёт жёсткие переносы → форма "треугольник" (строки растут по длине).
  // По правке заказчика 2026-05-07.
  title: 'Доход растёт\nвместе с объёмом\nпродаж агентства',
  titleAccent: 'продаж агентства',
  description:
    'Суммируем сделки по Зорге 9 и Кварталу Серебряный Бор — вы быстрее выходите на более высокий уровень комиссии. До 8% по Зорге 9 и до 6,25% по Серебряному Бору.',
  stats: [
    { number: 'до 8%', label: 'Максимальная ставка по Зорге 9' },
    { number: '7 дней', label: 'Выплата вознаграждения' },
    { number: '30 дней', label: 'Срок уникальности клиента' },
    { number: '2', label: 'Активных проекта' },
  ],
};

const ADVANTAGES = {
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
};

const COMMISSION = {
  tag: 'Комиссия и условия выплаты',
  title: 'Прогрессивная шкала вознаграждения',
  titleAccent: 'шкала',
  // По правке заказчика "Корректировка 16:06" 2026-05-07: метраж суммируется
  // в рамках ОДНОГО проекта, не по обоим. Текст про мотивацию: "больше
  // продаёте — выше комиссия".
  subtitle: 'Чем больше квадратных метров продаёте в рамках одного проекта — тем выше ваша ставка комиссии. Действует с 1 января по 30 июня 2026 года.',
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
  // Карточки — точно по docx "Условия вознаграждения" от заказчика.
  // 3 пункта, никаких лишних.
  cards: [
    { title: 'Условия выплаты', text: 'Вознаграждение выплачивается в течение 7 рабочих дней после оплаты клиентом.' },
    { title: 'Квартальный бонус', text: 'Дополнительный рост ставки при уровне Strong+: +0,1% → +0,15% → +0,2% → +0,25%. Ставка увеличивается при стабильных продажах.' },
    { title: 'Годовой бонус', text: 'За продуктивную работу в течение года: 100 000 ₽ + памятный кубок.' },
  ],
};

const CONTACT = {
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
};

const BLOCKS = { hero: HERO, advantages: ADVANTAGES, commission: COMMISSION, contact: CONTACT };

(async () => {
  const prisma = new PrismaClient();
  console.log('Refreshing CMS content blocks (hero, advantages, commission, contact)...\n');

  for (const [key, value] of Object.entries(BLOCKS)) {
    const before = await prisma.siteContent.findUnique({ where: { key } });
    await prisma.siteContent.upsert({
      where: { key },
      update: { value, updatedBy: 'refresh-cms-content-script' },
      create: { key, value, updatedBy: 'refresh-cms-content-script' },
    });
    console.log(`✓ ${key.padEnd(12)} ${before ? '(updated)' : '(created)'}`);
  }

  console.log('\nDone. Перезагрузи лендинг — должен показать новый текст.');
  await prisma.$disconnect();
})().catch((e) => {
  console.error('Error:', e);
  process.exit(1);
});
