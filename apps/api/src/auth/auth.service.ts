import { Injectable, Inject, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaClient, UserStatus } from '@st-michael/database';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import * as bcrypt from 'bcrypt';
import { AmoCrmAdapter, AMO_CONTACT_FIELDS, mapMeetingStatus } from '@st-michael/integrations';
import { CatalogService } from '../catalog/catalog.service';

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

  async register(data: { phone: string; fullName: string; email?: string; password: string; inn?: string; innType?: 'PERSONAL' | 'AGENCY'; agencyName?: string }) {
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

    return {
      message: 'Registration successful',
      brokerId: broker.id,
      amoLinked: !!amoContactId,
      amoLeadsCount,
      autoSyncTip: amoContactId ? 'Use POST /api/amocrm/sync-my-deals to pull deals/clients' : undefined,
    };
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
    const { AMO_CONTACT_FIELDS: fields, pipelineToProject, statusToDealStatus, isDealStage } = require('@st-michael/integrations');

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
        if (!lead || lead.status_id === 143) continue;
        if (!isDealStage(lead.status_id)) continue;

        const project = pipelineToProject(lead.pipeline_id);
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

        // Calculate commission
        const amount = Number(lead.price || 0);
        const brokerAgency = await this.prisma.brokerAgency.findFirst({
          where: { brokerId, isPrimary: true },
          include: { agency: true },
        });
        const level = brokerAgency?.agency?.commissionLevel || 'START';
        const rates: Record<string, Record<string, number>> = {
          ZORGE9: { START: 5.0, BASIC: 5.5, STRONG: 6.0, PREMIUM: 6.5, ELITE: 7.0, CHAMPION: 7.5, LEGEND: 8.0 },
          SILVER_BOR: { START: 4.5, BASIC: 5.0, STRONG: 5.5, PREMIUM: 6.0, ELITE: 6.5, CHAMPION: 7.0, LEGEND: 7.5 },
        };
        const rate = rates[project]?.[level] || 5.0;
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
      })),
      createdAt: broker.createdAt,
    };
  }

  async updateProfile(brokerId: string, data: { fullName?: string; email?: string; phone?: string }) {
    const broker = await this.prisma.broker.findUnique({ where: { id: brokerId } });
    if (!broker) throw new UnauthorizedException('Broker not found');

    if (data.phone && data.phone !== broker.phone) {
      const existing = await this.prisma.broker.findUnique({ where: { phone: data.phone } });
      if (existing) throw new BadRequestException('Phone already in use');
    }

    const updated = await this.prisma.broker.update({
      where: { id: brokerId },
      data: {
        ...(data.fullName && { fullName: data.fullName }),
        ...(data.email !== undefined && { email: data.email || null }),
        ...(data.phone && { phone: data.phone }),
      },
    });

    return {
      id: updated.id,
      fullName: updated.fullName,
      phone: updated.phone,
      email: updated.email,
    };
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
