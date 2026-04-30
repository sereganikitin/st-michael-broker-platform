import { Injectable, Inject, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@st-michael/database';

const OFFER_KEY = 'offer_terms';

interface OfferTerms {
  version: string;
  title: string;
  body: string;        // markdown / plain text
  updatedAt: string;
}

const DEFAULT_OFFER: OfferTerms = {
  version: '2026-04-30',
  title: 'Договор-оферта о сотрудничестве с партнёрами по продаже недвижимости',
  body: `1. ОБЩИЕ ПОЛОЖЕНИЯ

1.1. Настоящий Договор является публичной офертой ООО «ST Michael» (далее — Заказчик) на заключение договора с агентством недвижимости / частным брокером (далее — Партнёр) на оказание услуг по продаже объектов недвижимости в проектах Заказчика.

1.2. Полным и безоговорочным акцептом настоящей оферты в соответствии со ст. 438 ГК РФ является регистрация Партнёра в личном кабинете брокера на сайте Заказчика и нажатие кнопки «Принимаю условия».

2. ПРЕДМЕТ ДОГОВОРА

2.1. Партнёр обязуется привлекать клиентов и обеспечивать заключение сделок купли-продажи объектов недвижимости (квартир, апартаментов, коммерческих помещений) в проектах «Зорге 9» и «Квартал Серебряный Бор».

2.2. Заказчик обязуется выплачивать Партнёру комиссионное вознаграждение по прогрессивной шкале согласно Приложению № 1.

3. ПОРЯДОК ФИКСАЦИИ КЛИЕНТА

3.1. Клиент закрепляется за Партнёром на 30 (тридцать) календарных дней с момента подачи заявки на фиксацию через личный кабинет.

3.2. Если в течение срока фиксации клиент не выходит на сделку, фиксация автоматически прекращается.

4. КОМИССИОННОЕ ВОЗНАГРАЖДЕНИЕ

4.1. Размер комиссии: от 5% до 8% от стоимости объекта в зависимости от уровня Партнёра по прогрессивной шкале.

4.2. Выплата производится в течение 5 (пяти) рабочих дней с момента поступления Заказчику не менее 50% от суммы договора (для проекта «Зорге 9») или 30% (для проекта «Серебряный Бор»).

5. ПРАВА И ОБЯЗАННОСТИ СТОРОН

5.1. Партнёр обязуется соблюдать единые стандарты презентации объектов и не размещать недостоверную информацию.

5.2. Заказчик обязуется своевременно предоставлять Партнёру актуальные материалы и информацию о статусах сделок.

6. ОТВЕТСТВЕННОСТЬ СТОРОН

6.1. За нарушение условий настоящей оферты стороны несут ответственность в соответствии с действующим законодательством РФ.

7. СРОК ДЕЙСТВИЯ И ПОРЯДОК РАСТОРЖЕНИЯ

7.1. Договор действует бессрочно с момента акцепта.

7.2. Любая из сторон вправе расторгнуть Договор в одностороннем порядке, уведомив другую сторону не менее чем за 30 дней.

8. ЗАКЛЮЧИТЕЛЬНЫЕ ПОЛОЖЕНИЯ

8.1. Все споры разрешаются в порядке, установленном законодательством РФ.

8.2. Заказчик: ООО «ST Michael». ИНН/КПП — указано на сайте. Адрес: г. Москва, ул. Зорге, д. 9.`,
  updatedAt: '2026-04-30T00:00:00.000Z',
};

@Injectable()
export class OfferService {
  constructor(@Inject('PrismaClient') private prisma: PrismaClient) {}

  async getCurrent(): Promise<OfferTerms> {
    const row = await this.prisma.siteContent.findUnique({ where: { key: OFFER_KEY } });
    if (row && row.value && typeof row.value === 'object') {
      return row.value as unknown as OfferTerms;
    }
    return DEFAULT_OFFER;
  }

  async updateCurrent(data: { title?: string; body?: string; version?: string }, updatedBy: string) {
    const current = await this.getCurrent();
    const next: OfferTerms = {
      version: data.version || new Date().toISOString().slice(0, 10),
      title: data.title ?? current.title,
      body: data.body ?? current.body,
      updatedAt: new Date().toISOString(),
    };

    await this.prisma.siteContent.upsert({
      where: { key: OFFER_KEY },
      update: { value: next as any, updatedBy },
      create: { key: OFFER_KEY, value: next as any, updatedBy },
    });

    return next;
  }

  async getMyAcceptance(brokerId: string) {
    const offer = await this.getCurrent();
    const acceptance = await this.prisma.offerAcceptance.findFirst({
      where: { brokerId, offerVersion: offer.version },
      orderBy: { acceptedAt: 'desc' },
    });

    return {
      offer,
      accepted: !!acceptance,
      acceptance: acceptance
        ? {
            id: acceptance.id,
            offerVersion: acceptance.offerVersion,
            acceptedAt: acceptance.acceptedAt,
            signedPdfUrl: acceptance.signedPdfUrl,
          }
        : null,
    };
  }

  async accept(brokerId: string, ip: string | null, userAgent: string | null) {
    const offer = await this.getCurrent();

    const existing = await this.prisma.offerAcceptance.findFirst({
      where: { brokerId, offerVersion: offer.version },
    });
    if (existing) {
      return {
        message: 'Договор уже принят',
        acceptance: existing,
      };
    }

    const created = await this.prisma.offerAcceptance.create({
      data: {
        brokerId,
        offerVersion: offer.version,
        ip,
        userAgent,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        userId: brokerId,
        action: 'OFFER_ACCEPTED',
        entity: 'OfferAcceptance',
        entityId: created.id,
        payload: { offerVersion: offer.version },
        ip,
      },
    });

    return { message: 'Оферта принята', acceptance: created };
  }

  async getSignedDocumentHtml(brokerId: string): Promise<string> {
    const broker = await this.prisma.broker.findUnique({
      where: { id: brokerId },
      include: {
        brokerAgencies: { include: { agency: true }, where: { isPrimary: true }, take: 1 },
      },
    });
    if (!broker) throw new NotFoundException('Broker not found');

    const offer = await this.getCurrent();
    const acceptance = await this.prisma.offerAcceptance.findFirst({
      where: { brokerId, offerVersion: offer.version },
      orderBy: { acceptedAt: 'desc' },
    });
    if (!acceptance) {
      throw new BadRequestException('Текущая версия оферты не принята');
    }

    const agency = broker.brokerAgencies[0]?.agency;
    const acceptedFmt = new Date(acceptance.acceptedAt).toLocaleString('ru-RU');

    const escape = (s: string | null | undefined) =>
      String(s ?? '').replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c),
      );

    const bodyHtml = escape(offer.body).replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br/>');

    return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8" />
<title>Подписанный экземпляр оферты — ${escape(broker.fullName)}</title>
<style>
  @media print { @page { margin: 1.5cm; } body { font-size: 12pt; } }
  body { font-family: 'Times New Roman', serif; max-width: 760px; margin: 24px auto; padding: 0 24px; line-height: 1.5; color: #111; }
  h1 { font-size: 18pt; text-align: center; margin-bottom: 8px; }
  .sub { text-align: center; color: #555; margin-bottom: 24px; font-size: 11pt; }
  .meta { background: #f5f5f5; border: 1px solid #ddd; padding: 12px 16px; border-radius: 4px; margin-bottom: 20px; font-size: 11pt; }
  .meta div { margin: 3px 0; }
  .meta b { display: inline-block; min-width: 200px; }
  .body p { margin: 10px 0; text-align: justify; }
  .seal { margin-top: 32px; padding: 16px; border: 2px solid #B4936F; border-radius: 4px; text-align: center; font-size: 11pt; }
  .seal b { color: #B4936F; }
  .footer { margin-top: 24px; font-size: 9pt; color: #888; text-align: center; }
</style></head>
<body>
  <h1>${escape(offer.title)}</h1>
  <div class="sub">Версия ${escape(offer.version)} · Подписанный экземпляр</div>

  <div class="meta">
    <div><b>Партнёр (ФИО):</b> ${escape(broker.fullName)}</div>
    <div><b>Телефон:</b> ${escape(broker.phone)}</div>
    ${broker.email ? `<div><b>Email:</b> ${escape(broker.email)}</div>` : ''}
    ${agency ? `<div><b>Агентство:</b> ${escape(agency.name)} (ИНН ${escape(agency.inn)})</div>` : ''}
    ${agency?.legalAddress ? `<div><b>Юр. адрес:</b> ${escape(agency.legalAddress)}</div>` : ''}
    <div><b>Дата акцепта:</b> ${escape(acceptedFmt)}</div>
    ${acceptance.ip ? `<div><b>IP-адрес акцепта:</b> ${escape(acceptance.ip)}</div>` : ''}
  </div>

  <div class="body"><p>${bodyHtml}</p></div>

  <div class="seal">
    <div><b>АКЦЕПТ ПРИНЯТ</b></div>
    <div>Оферта принята партнёром ${escape(broker.fullName)} ${escape(acceptedFmt)} путём нажатия кнопки «Принимаю условия» в личном кабинете партнёра ST Michael в соответствии со ст. 438 ГК РФ.</div>
  </div>

  <div class="footer">
    Электронный экземпляр. ID акцепта: ${escape(acceptance.id)}.<br/>
    Сформировано системой ST Michael Broker Platform.
  </div>
</body></html>`;
  }
}
