import { Injectable, Inject, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaClient, UserStatus } from '@st-michael/database';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import * as bcrypt from 'bcrypt';
import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { AmoCrmAdapter, AMO_CONTACT_FIELDS, brokerToAmoContactFields, mapMeetingStatus, leadToProject, BROKER_PIPELINE_ID } from '@st-michael/integrations';
import { CatalogService } from '../catalog/catalog.service';
import { levelForSqm, rateFor } from '../commission/commission.service';

const UPLOADS_ROOT = process.env.UPLOADS_DIR || '/app/uploads';
const AVATAR_PUBLIC_PREFIX = '/files';

@Injectable()
export class AuthService {
  private amo = new AmoCrmAdapter();
  static lastFeedSyncAt = 0;

  constructor(
    @Inject('PrismaClient') private prisma: PrismaClient,
    private jwtService: JwtService,
    @InjectQueue('notifications') private notificationQueue: Queue,
    private readonly catalogService: CatalogService,
  ) {}

  async register(data: { phone: string; fullName?: string; firstName?: string; lastName?: string; middleName?: string; email?: string; password: string; inn?: string; innType?: 'PERSONAL' | 'AGENCY'; agencyName?: string }) {
    // Normalize composite fullName from parts if provided
    if (!data.fullName && (data.firstName || data.lastName)) {
      data.fullName = [data.lastName, data.firstName, data.middleName].filter(Boolean).join(' ').trim();
    }
    if (!data.fullName) {
      throw new BadRequestException('ФИО обязательно');
    }
    const existing = await this.prisma.broker.findUnique({
      where: { phone: data.phone },
    });

    if (existing) {
      throw new BadRequestException('Broker with this phone already exists');
    }

    const passwordHash = await bcrypt.hash(data.password, 10);

    // Check amoCRM for existing contact by phone
    let amoContactId: bigint | undefined;
    let amoLeadsCount = 0;
    try {
      const brokerFields: any[] = [
        { field_id: AMO_CONTACT_FIELDS.PHONE, values: [{ value: data.phone, enum_code: 'WORK' }] },
        { field_id: AMO_CONTACT_FIELDS.IS_BROKER, values: [{ value: true }] },
      ];
      if (data.email) {
        brokerFields.push({ field_id: AMO_CONTACT_FIELDS.EMAIL, values: [{ value: data.email, enum_code: 'WORK' }] });
      }
      if (data.inn) {
        brokerFields.push({ field_id: AMO_CONTACT_FIELDS.INN, values: [{ value: data.inn }] });
      }
      if (data.agencyName) {
        brokerFields.push({ field_id: AMO_CONTACT_FIELDS.AGENCY_NAME, values: [{ value: data.agencyName }] });
      } else if (data.inn && data.innType === 'AGENCY') {
        brokerFields.push({ field_id: AMO_CONTACT_FIELDS.AGENCY_NAME, values: [{ value: `Агентство ${data.inn}` }] });
      }

      const amoContact = await this.amo.findBrokerContactByPhone(data.phone);
      if (amoContact) {
        amoContactId = BigInt(amoContact.id);
        // Update contact: set broker flag, INN, agency
        try {
          await this.amo.updateContact(amoContact.id, {
            custom_fields_values: brokerFields,
          } as any);
        } catch (e) {
          console.error('amoCRM updateContact failed:', e);
        }
        const fullContact = await this.amo.getContact(amoContact.id);
        amoLeadsCount = fullContact?._embedded?.leads?.length || 0;
      } else {
        // Create new contact as broker
        const newContact = await this.amo.createContact({
          name: data.fullName,
          custom_fields_values: brokerFields,
        });
        if (newContact?.id) amoContactId = BigInt(newContact.id);
      }
    } catch (e) {
      console.error('amoCRM sync failed during register:', e);
    }

    const broker = await this.prisma.broker.create({
      data: {
        phone: data.phone,
        fullName: data.fullName,
        email: data.email,
        passwordHash,
        status: UserStatus.ACTIVE,
        source: 'BROKER_CABINET',
        ...(amoContactId && { amoContactId }),
      },
    });

    // Create or link agency by INN
    if (data.inn) {
      const agencyName = data.agencyName || (data.innType === 'PERSONAL' ? `ИП ${data.fullName}` : `Агентство ${data.inn}`);
      let agency = await this.prisma.agency.findUnique({ where: { inn: data.inn } });
      if (!agency) {
        agency = await this.prisma.agency.create({
          data: { name: agencyName, inn: data.inn },
        });
      } else if (data.agencyName && agency.name !== data.agencyName) {
        agency = await this.prisma.agency.update({ where: { id: agency.id }, data: { name: data.agencyName } });
      }
      await this.prisma.brokerAgency.create({
        data: { brokerId: broker.id, agencyId: agency.id, isPrimary: true },
      });
    }

    // 2026-06-09: welcome-email брокеру при регистрации.
    // SMS отключены (нет провайдера), используем только почту.
    // Fire-and-forget — не валим регистрацию если SMTP лежит.
    if (data.email) {
      this.sendWelcomeEmail(data.email, data.fullName).catch((e) => {
        console.error('[register] sendWelcomeEmail failed:', e?.message || e);
      });
    }

    return {
      message: 'Registration successful',
      brokerId: broker.id,
      amoLinked: !!amoContactId,
      amoLeadsCount,
      autoSyncTip: amoContactId ? 'Use POST /api/amocrm/sync-my-deals to pull deals/clients' : undefined,
    };
  }

  /**
   * 2026-06-09: приветственное письмо после регистрации.
   * Текст содержит ссылку на кабинет, краткую инструкцию по первым шагам
   * и контакты КЦ для вопросов. Шлётся через SMTP_*, если они настроены.
   * При SMTP-ошибке только логируется — не валим регистрацию.
   */
  private async sendWelcomeEmail(email: string, fullName: string): Promise<void> {
    if (!process.env.SMTP_HOST || !process.env.SMTP_USER) {
      console.warn('[welcome-email] SMTP не настроен, skip');
      return;
    }
    const webUrl = process.env.WEB_URL || 'https://broker.stmichael.ru';
    const loginUrl = `${webUrl}/login`;
    const html = `
      <p>Здравствуйте, ${fullName}!</p>
      <p>Вы успешно зарегистрировались в личном кабинете брокера <strong>ST Michael Broker Platform</strong>.</p>
      <p><strong>Что делать дальше:</strong></p>
      <ol>
        <li>Войти в кабинет по ссылке: <a href="${loginUrl}">${loginUrl}</a> (используйте телефон, под которым регистрировались, и ваш пароль).</li>
        <li>В разделе <em>«Профиль»</em> заполните данные: ФИО, должность, регион, дата рождения, Telegram. Эти данные нужны для оформления сделок и комиссий.</li>
        <li>В разделе <em>«Подбор квартир»</em> можно сразу посмотреть каталог объектов.</li>
        <li>Чтобы зафиксировать первого клиента — раздел <em>«Фиксация»</em>. После фиксации клиент закрепляется за вами на 30 дней.</li>
      </ol>
      <p><strong>Контакты КЦ для вопросов:</strong></p>
      <ul>
        <li>Telegram: <a href="https://t.me/stmichael_broker">@stmichael_broker</a></li>
        <li>Почта: <a href="mailto:broker@stmichael.ru">broker@stmichael.ru</a></li>
      </ul>
      <p>Будем рады долгому и продуктивному сотрудничеству!</p>
      <p>—<br>Команда ST Michael</p>
    `;
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 465),
      secure: process.env.SMTP_SECURE !== 'false',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: email,
      subject: 'Добро пожаловать в ST Michael Broker Platform',
      html,
    });
    console.log(`[welcome-email] отправлено ${email}`);
  }

  async forgotPassword(email: string) {
    const broker = await this.prisma.broker.findFirst({ where: { email } });
    if (!broker) return { message: 'Если email зарегистрирован, на него отправлена ссылка' };

    const token = require('crypto').randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000);

    await this.prisma.broker.update({
      where: { id: broker.id },
      data: { passwordResetToken: token, passwordResetExpiresAt: expires },
    });

    const resetUrl = `${process.env.WEB_URL || 'https://72.56.241.199'}/reset-password?token=${token}`;

    if (process.env.SMTP_HOST && process.env.SMTP_USER) {
      try {
        const nodemailer = require('nodemailer');
        const transporter = nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: Number(process.env.SMTP_PORT || 465),
          secure: process.env.SMTP_SECURE !== 'false',
          auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
        });
        await transporter.sendMail({
          from: process.env.SMTP_FROM || process.env.SMTP_USER,
          to: email,
          subject: 'Восстановление пароля — ST Michael',
          html: `<p>Для сброса пароля перейдите по ссылке:</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>Ссылка действует 1 час.</p>`,
        });
      } catch (e) {
        console.error('SMTP send failed:', e);
      }
    } else {
      console.log(`[FORGOT-PASSWORD] Reset link for ${email}: ${resetUrl}`);
    }

    return { message: 'Если email зарегистрирован, на него отправлена ссылка' };
  }

  async resetPassword(token: string, newPassword: string) {
    const broker = await this.prisma.broker.findUnique({ where: { passwordResetToken: token } });
    if (!broker || !broker.passwordResetExpiresAt || broker.passwordResetExpiresAt < new Date()) {
      throw new BadRequestException('Ссылка недействительна или истекла');
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await this.prisma.broker.update({
      where: { id: broker.id },
      data: { passwordHash, passwordResetToken: null, passwordResetExpiresAt: null },
    });

    return { message: 'Пароль успешно изменён' };
  }

  async sendOtp(phone: string) {
    // OTP disabled — kept for API compatibility
    return { message: 'OTP not required' };
  }

  async login(data: { phone: string; password: string }) {
    const broker = await this.prisma.broker.findUnique({
      where: { phone: data.phone },
      include: {
        brokerAgencies: {
          include: { agency: true },
          where: { isPrimary: true },
          take: 1,
        },
      },
    });

    if (!broker || !broker.passwordHash) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (broker.status === 'BLOCKED') {
      throw new UnauthorizedException('Account is blocked');
    }

    const isValid = await bcrypt.compare(data.password, broker.passwordHash);
    if (!isValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const payload = { sub: broker.id, phone: broker.phone, role: broker.role };
    const accessToken = this.jwtService.sign(payload);
    const refreshToken = this.jwtService.sign(payload, {
      expiresIn: process.env.JWT_REFRESH_TTL || '7d',
    });

    // Trigger background amoCRM sync on login (fire-and-forget) — lookup by broker's phone
    if (process.env.AMO_ACCESS_TOKEN && broker.phone) {
      this.syncBrokerFromAmo(broker.id, broker.phone, broker.amoContactId ? Number(broker.amoContactId) : null)
        .catch((e) => console.error('Background amo sync on login failed:', e));
    }

    // Trigger background catalog feed sync on login (rate-limited to once per 10 minutes)
    const FEED_COOLDOWN_MS = 10 * 60 * 1000;
    const now = Date.now();
    if (!AuthService.lastFeedSyncAt || now - AuthService.lastFeedSyncAt > FEED_COOLDOWN_MS) {
      AuthService.lastFeedSyncAt = now;
      this.catalogService.syncFromFeed()
        .then((r) => console.log(`[Login] Feed sync: +${r.created}, ~${r.updated}, total ${r.total}`))
        .catch((e) => console.error('Login feed sync failed:', e));
    }

    return {
      accessToken,
      refreshToken,
      broker: {
        id: broker.id,
        fullName: broker.fullName,
        phone: broker.phone,
        role: broker.role,
        status: broker.status,
        funnelStage: broker.funnelStage,
        agency: broker.brokerAgencies[0]?.agency ?? null,
      },
    };
  }

  private async syncBrokerFromAmo(brokerId: string, phone: string, currentAmoContactId: number | null) {
    const { statusToDealStatus } = require('@st-michael/integrations');

    // Find correct broker contact
    const brokerContact = await this.amo.findBrokerContactByPhone(phone);
    if (!brokerContact) return;

    const contactId = brokerContact.id;
    if (!currentAmoContactId || currentAmoContactId !== contactId) {
      await this.prisma.broker.update({
        where: { id: brokerId },
        data: { amoContactId: BigInt(contactId) },
      });
    }

    const fullContact = await this.amo.getContact(contactId);
    const leads = fullContact?._embedded?.leads || [];

    for (const leadRef of leads) {
      try {
        const lead: any = await this.amo.getLead(leadRef.id);
        if (!lead) continue;
        // Skip broker pipeline (это про самого брокера) and closed-not-realized
        if (lead.pipeline_id === BROKER_PIPELINE_ID) continue;
        if (lead.status_id === 143) continue;

        const project = leadToProject(lead);
        const status = statusToDealStatus(lead.status_id);

        const leadContacts = lead?._embedded?.contacts || [];
        const clientRef = leadContacts.find((c: any) => c.id !== contactId) || leadContacts[0];

        let fullName = lead.name || 'Без имени';
        let clientPhone = `+70000${leadRef.id}`;
        let email: string | null = null;

        if (clientRef) {
          const cc: any = await this.amo.getContact(clientRef.id);
          if (cc) {
            fullName = cc.name || fullName;
            const pf = (cc.custom_fields_values || []).find((f: any) => f.field_code === 'PHONE');
            let p = String(pf?.values?.[0]?.value || '').replace(/[\s\-()'"]/g, '');
            if (p.startsWith('8') && p.length === 11) p = '+7' + p.slice(1);
            if (p && !p.startsWith('+')) p = '+' + p;
            if (p) clientPhone = p;
            const ef = (cc.custom_fields_values || []).find((f: any) => f.field_code === 'EMAIL');
            email = ef?.values?.[0]?.value || null;
          }
        }

        let client = await this.prisma.client.findFirst({ where: { phone: clientPhone, brokerId } });
        if (!client) {
          client = await this.prisma.client.create({
            data: {
              brokerId, fullName, phone: clientPhone, email,
              project: project as any,
              amoLeadId: BigInt(lead.id),
              uniquenessStatus: 'CONDITIONALLY_UNIQUE' as any,
              uniquenessExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
            },
          });
        }

        // Calculate commission — use new project-specific scales (ТЗ §"Объединённая шкала")
        const amount = Number(lead.price || 0);
        const brokerAgency = await this.prisma.brokerAgency.findFirst({
          where: { brokerId, isPrimary: true },
          include: { agency: true },
        });
        const totalSqm = Number(brokerAgency?.agency?.totalSqmSold || 0);
        const level = levelForSqm(project, totalSqm);
        const rate = rateFor(project, level);
        const commissionAmount = Math.round(amount * rate / 100);

        const existingDeal = await this.prisma.deal.findFirst({ where: { amoDealId: BigInt(lead.id) } });
        const dealData = {
          clientId: client.id, brokerId, project: project as any,
          amount, sqm: 0,
          commissionRate: rate, commissionAmount,
          status: status as any, amoDealId: BigInt(lead.id),
        };
        if (existingDeal) {
          await this.prisma.deal.update({ where: { id: existingDeal.id }, data: dealData });
        } else {
          await this.prisma.deal.create({ data: dealData });
        }

        // Sync meeting from lead custom fields
        try {
          const cf = lead?.custom_fields_values || [];
          const dateField = cf.find((f: any) => f.field_name === 'Дата и время встречи');
          const typeField = cf.find((f: any) => f.field_name === 'Встреча');
          const rawDate = dateField?.values?.[0]?.value;
          if (rawDate) {
            const meetingDate = new Date(Number(rawDate) * 1000);
            if (!isNaN(meetingDate.getTime())) {
              const rawType = typeField?.values?.[0]?.value || '';
              const v = rawType.toLowerCase();
              const meetingType = v.includes('онлайн') ? 'ONLINE' : v.includes('тур') ? 'BROKER_TOUR' : 'OFFICE_VISIT';
              const meetingStatus = mapMeetingStatus(lead.status_id);
              const existing = await this.prisma.meeting.findFirst({ where: { clientId: client.id, brokerId, date: meetingDate } });
              if (existing) {
                await this.prisma.meeting.update({ where: { id: existing.id }, data: { type: meetingType as any, status: meetingStatus as any } });
              } else {
                await this.prisma.meeting.create({
                  data: {
                    brokerId, clientId: client.id,
                    type: meetingType as any, status: meetingStatus as any,
                    date: meetingDate,
                    comment: rawType ? `Тип из amoCRM: ${rawType}` : null,
                  },
                });
              }
            }
          }
        } catch {}
      } catch {}
    }
  }

  async refreshToken(refreshToken: string) {
    try {
      const payload = this.jwtService.verify(refreshToken);
      const broker = await this.prisma.broker.findUnique({
        where: { id: payload.sub },
      });

      if (!broker || broker.status === 'BLOCKED') {
        throw new UnauthorizedException('Invalid refresh token');
      }

      const newPayload = { sub: broker.id, phone: broker.phone, role: broker.role };
      const accessToken = this.jwtService.sign(newPayload);

      return { accessToken };
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
  }

  async getProfile(brokerId: string) {
    const broker = await this.prisma.broker.findUnique({
      where: { id: brokerId },
      include: {
        brokerAgencies: {
          include: { agency: true },
        },
      },
    });

    if (!broker) {
      throw new UnauthorizedException('Broker not found');
    }

    return {
      id: broker.id,
      fullName: broker.fullName,
      phone: broker.phone,
      email: broker.email,
      avatarUrl: broker.avatarUrl,
      birthDate: broker.birthDate,
      position: broker.position,
      region: broker.region,
      telegramUsername: broker.telegramUsername,
      telegramId: broker.telegramId,
      whatsappUsername: broker.whatsappUsername,
      presentationSent: broker.presentationSent,
      role: broker.role,
      status: broker.status,
      funnelStage: broker.funnelStage,
      source: broker.source,
      brokerTourVisited: broker.brokerTourVisited,
      brokerTourDate: broker.brokerTourDate,
      telegramChatId: broker.telegramChatId ? broker.telegramChatId.toString() : null,
      agencies: broker.brokerAgencies.map((ba) => ({
        id: ba.agency.id,
        name: ba.agency.name,
        inn: ba.agency.inn,
        isPrimary: ba.isPrimary,
        commissionLevel: ba.agency.commissionLevel,
        legalAddress: ba.agency.legalAddress,
        bankName: ba.agency.bankName,
        bankBik: ba.agency.bankBik,
        bankAccount: ba.agency.bankAccount,
        correspondentAccount: ba.agency.correspondentAccount,
      })),
      createdAt: broker.createdAt,
    };
  }

  async updateProfile(
    brokerId: string,
    data: {
      fullName?: string;
      email?: string;
      phone?: string;
      birthDate?: string | null;
      position?: string | null;
      telegramUsername?: string | null;
      telegramId?: string | null;
      whatsappUsername?: string | null;
      presentationSent?: boolean;
      region?: string | null;
      agency?: {
        id?: string;
        legalAddress?: string | null;
        bankName?: string | null;
        bankBik?: string | null;
        bankAccount?: string | null;
        correspondentAccount?: string | null;
      };
    },
  ) {
    const broker = await this.prisma.broker.findUnique({ where: { id: brokerId } });
    if (!broker) throw new UnauthorizedException('Broker not found');

    if (data.phone && data.phone !== broker.phone) {
      const existing = await this.prisma.broker.findUnique({ where: { phone: data.phone } });
      if (existing) throw new BadRequestException('Phone already in use');
    }

    let birthDate: Date | null | undefined;
    if (data.birthDate === null) {
      birthDate = null;
    } else if (typeof data.birthDate === 'string' && data.birthDate.trim()) {
      const d = new Date(data.birthDate);
      if (isNaN(d.getTime())) throw new BadRequestException('Invalid birthDate');
      birthDate = d;
    }

    const updated = await this.prisma.broker.update({
      where: { id: brokerId },
      data: {
        ...(data.fullName && { fullName: data.fullName }),
        ...(data.email !== undefined && { email: data.email || null }),
        ...(data.phone && { phone: data.phone }),
        ...(birthDate !== undefined && { birthDate }),
        ...(data.position !== undefined && { position: data.position || null }),
        ...(data.telegramUsername !== undefined && { telegramUsername: data.telegramUsername || null }),
        ...(data.telegramId !== undefined && { telegramId: data.telegramId || null }),
        ...(data.whatsappUsername !== undefined && { whatsappUsername: data.whatsappUsername || null }),
        ...(data.presentationSent !== undefined && { presentationSent: !!data.presentationSent }),
        ...(data.region !== undefined && { region: data.region || null }),
      },
    });

    if (data.agency) {
      // Resolve target agency: explicit id (must belong to broker) or primary agency
      let agencyId = data.agency.id;
      if (!agencyId) {
        const primary = await this.prisma.brokerAgency.findFirst({
          where: { brokerId, isPrimary: true },
        });
        agencyId = primary?.agencyId;
      } else {
        const link = await this.prisma.brokerAgency.findFirst({
          where: { brokerId, agencyId },
        });
        if (!link) throw new BadRequestException('Agency not linked to this broker');
      }

      if (agencyId) {
        const a = data.agency;
        await this.prisma.agency.update({
          where: { id: agencyId },
          data: {
            ...(a.legalAddress !== undefined && { legalAddress: a.legalAddress || null }),
            ...(a.bankName !== undefined && { bankName: a.bankName || null }),
            ...(a.bankBik !== undefined && { bankBik: a.bankBik || null }),
            ...(a.bankAccount !== undefined && { bankAccount: a.bankAccount || null }),
            ...(a.correspondentAccount !== undefined && {
              correspondentAccount: a.correspondentAccount || null,
            }),
          },
        });
      }
    }

    // Sync в amoCRM. БД — источник истины: при любом изменении профиля
    // подтягиваем актуальные данные брокера + primary-агентства и обновляем
    // контакт в амо. Без try/catch sync-ошибки повалили бы запрос пользователя.
    await this.syncBrokerProfileToAmo(brokerId).catch((e) => {
      console.error('amoCRM profile sync failed:', e);
    });

    return {
      id: updated.id,
      fullName: updated.fullName,
      phone: updated.phone,
      email: updated.email,
      avatarUrl: updated.avatarUrl,
      birthDate: updated.birthDate,
    };
  }

  /**
   * Полная синхронизация профиля брокера в amoCRM. Источник истины — наша БД.
   * Вызывается при любом изменении: PATCH /auth/me, изменении агентства,
   * привязке/смене primary, изменении из админки.
   *
   * Если у брокера есть amoContactId — обновляем контакт. Если нет —
   * пробуем найти контакт по телефону (с флагом IS_BROKER=true), и если
   * нашли — линкуем + обновляем. Если не нашли — создаём новый.
   */
  async syncBrokerProfileToAmo(brokerId: string) {
    const broker = await this.prisma.broker.findUnique({
      where: { id: brokerId },
      include: {
        brokerAgencies: {
          where: { isPrimary: true },
          include: { agency: true },
          take: 1,
        },
      },
    });
    if (!broker) return;

    const primaryAgency = broker.brokerAgencies[0]?.agency || null;
    const customFields = brokerToAmoContactFields(broker, primaryAgency);
    const payload = {
      name: broker.fullName,
      custom_fields_values: customFields,
    } as any;

    let amoContactId: bigint | null = broker.amoContactId ?? null;

    if (amoContactId) {
      await this.amo.updateContact(Number(amoContactId), payload);
      return;
    }

    // Нет линка — пробуем найти контакт по телефону среди БРОКЕРОВ (IS_BROKER=true)
    if (broker.phone) {
      const existing = await this.amo.findBrokerContactByPhone(broker.phone);
      if (existing) {
        amoContactId = BigInt(existing.id);
        await this.amo.updateContact(existing.id, payload);
      } else {
        // Создаём новый контакт
        const created = await this.amo.createContact(payload);
        if (created?.id) amoContactId = BigInt(created.id);
      }
      if (amoContactId) {
        await this.prisma.broker.update({
          where: { id: brokerId },
          data: { amoContactId },
        });
      }
    }
  }

  /**
   * Привязать агентство к текущему брокеру по ИНН. Если агентства с таким ИНН ещё
   * нет в нашей БД — ищем в amoCRM (или создаём там), затем создаём локально.
   * Создаёт BrokerAgency-связь (isPrimary если у брокера ещё нет primary).
   * Правка 2026-05-15.
   */
  async attachAgencyByInn(brokerId: string, inn: string) {
    const cleanInn = String(inn || '').replace(/\D/g, '');
    if (cleanInn.length < 10 || cleanInn.length > 12) {
      throw new BadRequestException('ИНН должен быть 10 или 12 цифр');
    }

    // Найти/создать локальное Agency.
    let agency = await this.prisma.agency.findUnique({ where: { inn: cleanInn } });
    if (!agency) {
      // Попробовать найти компанию в amoCRM.
      let amoName: string | null = null;
      try {
        const amoCompany = await this.amo.findCompanyByInn(cleanInn);
        if (amoCompany) {
          amoName = amoCompany.name;
        } else {
          // Создать в amoCRM.
          const created = await this.amo.createCompany({ name: `Агентство ${cleanInn}` });
          amoName = created?.name || `Агентство ${cleanInn}`;
        }
      } catch {
        // amoCRM может быть недоступен — создаём только локально.
        amoName = `Агентство ${cleanInn}`;
      }
      agency = await this.prisma.agency.create({
        data: { name: amoName!, inn: cleanInn },
      });
    }

    // Линковка broker↔agency.
    const existingLink = await this.prisma.brokerAgency.findFirst({
      where: { brokerId, agencyId: agency.id },
    });
    if (!existingLink) {
      const hasPrimary = await this.prisma.brokerAgency.findFirst({
        where: { brokerId, isPrimary: true },
      });
      await this.prisma.brokerAgency.create({
        data: {
          brokerId,
          agencyId: agency.id,
          isPrimary: !hasPrimary, // первое агентство = primary
        },
      });
    }

    // Sync в amoCRM: подтянем актуальный ИНН/название агентства в карточку.
    await this.syncBrokerProfileToAmo(brokerId).catch((e) => {
      console.error('amoCRM sync after attachAgency failed:', e);
    });

    return { agency: { id: agency.id, name: agency.name, inn: agency.inn } };
  }

  async changePassword(brokerId: string, currentPassword: string, newPassword: string) {
    if (!newPassword || newPassword.length < 8) {
      throw new BadRequestException('Новый пароль должен быть не менее 8 символов');
    }

    const broker = await this.prisma.broker.findUnique({ where: { id: brokerId } });
    if (!broker || !broker.passwordHash) {
      throw new UnauthorizedException('Broker not found');
    }

    const valid = await bcrypt.compare(currentPassword, broker.passwordHash);
    if (!valid) {
      throw new BadRequestException('Текущий пароль введён неверно');
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await this.prisma.broker.update({
      where: { id: brokerId },
      data: { passwordHash },
    });

    return { ok: true, message: 'Пароль изменён' };
  }

  async uploadAvatar(brokerId: string, file: Express.Multer.File) {
    if (!file) throw new BadRequestException('File required');
    if (file.size > 5 * 1024 * 1024) {
      throw new BadRequestException('Avatar must be ≤ 5 MB');
    }
    const mime = (file.mimetype || '').toLowerCase();
    if (!mime.startsWith('image/')) {
      throw new BadRequestException('Avatar must be an image');
    }

    const ext = (path.extname(file.originalname) || '.png').toLowerCase();
    const fileName = `${randomUUID()}${ext}`;
    const targetDir = path.join(UPLOADS_ROOT, 'avatars');
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(path.join(targetDir, fileName), file.buffer);

    const fileUrl = `${AVATAR_PUBLIC_PREFIX}/avatars/${fileName}`;

    // Best-effort cleanup of old avatar
    const broker = await this.prisma.broker.findUnique({
      where: { id: brokerId },
      select: { avatarUrl: true },
    });
    if (broker?.avatarUrl?.startsWith(`${AVATAR_PUBLIC_PREFIX}/avatars/`)) {
      const oldName = broker.avatarUrl.replace(`${AVATAR_PUBLIC_PREFIX}/avatars/`, '');
      await fs.unlink(path.join(targetDir, oldName)).catch(() => {});
    }

    await this.prisma.broker.update({
      where: { id: brokerId },
      data: { avatarUrl: fileUrl },
    });

    return { avatarUrl: fileUrl };
  }

  async validateBroker(brokerId: string) {
    const broker = await this.prisma.broker.findUnique({
      where: { id: brokerId },
    });

    if (!broker || broker.status === 'BLOCKED') {
      return null;
    }

    return broker;
  }
}
