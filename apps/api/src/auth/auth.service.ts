import { Injectable, Inject, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaClient, UserStatus } from '@st-michael/database';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';

const OTP_TTL_SECONDS = 300; // 5 minutes
const OTP_LENGTH = 4;

@Injectable()
export class AuthService {
  // In-memory OTP store (use Redis in production via BullMQ or ioredis)
  private otpStore = new Map<string, { code: string; expiresAt: number }>();

  constructor(
    @Inject('PrismaClient') private prisma: PrismaClient,
    private jwtService: JwtService,
    @InjectQueue('notifications') private notificationQueue: Queue,
  ) {}

  private generateOtp(): string {
    return Math.floor(Math.pow(10, OTP_LENGTH - 1) + Math.random() * 9 * Math.pow(10, OTP_LENGTH - 1))
      .toString()
      .slice(0, OTP_LENGTH);
  }

  private storeOtp(phone: string, code: string): void {
    this.otpStore.set(phone, {
      code,
      expiresAt: Date.now() + OTP_TTL_SECONDS * 1000,
    });
  }

  private verifyOtp(phone: string, code: string): boolean {
    const stored = this.otpStore.get(phone);
    if (!stored) return false;
    if (Date.now() > stored.expiresAt) {
      this.otpStore.delete(phone);
      return false;
    }
    if (stored.code !== code) return false;
    this.otpStore.delete(phone);
    return true;
  }

  async register(data: { phone: string; fullName: string }) {
    const existingBroker = await this.prisma.broker.findUnique({
      where: { phone: data.phone },
    });

    if (existingBroker) {
      throw new BadRequestException('Broker with this phone already exists');
    }

    const broker = await this.prisma.broker.create({
      data: {
        phone: data.phone,
        fullName: data.fullName,
        status: UserStatus.PENDING,
        source: 'BROKER_CABINET',
      },
    });

    // Generate and send OTP
    const otp = this.generateOtp();
    this.storeOtp(data.phone, otp);

    // Queue SMS notification
    await this.notificationQueue.add('send', {
      brokerId: broker.id,
      channel: 'SMS',
      body: `Ваш код подтверждения: ${otp}`,
    });

    console.log(`[Auth] OTP for ${data.phone}: ${otp}`); // Dev logging

    return {
      message: 'Registration initiated. Please check SMS for OTP.',
      brokerId: broker.id,
    };
  }

  async sendOtp(phone: string) {
    const broker = await this.prisma.broker.findUnique({
      where: { phone },
    });

    if (!broker) {
      throw new BadRequestException('Broker not found. Please register first.');
    }

    if (broker.status === 'BLOCKED') {
      throw new UnauthorizedException('Account is blocked');
    }

    const otp = this.generateOtp();
    this.storeOtp(phone, otp);

    await this.notificationQueue.add('send', {
      brokerId: broker.id,
      channel: 'SMS',
      body: `Ваш код входа: ${otp}`,
    });

    console.log(`[Auth] OTP for ${phone}: ${otp}`); // Dev logging

    return { message: 'OTP sent successfully' };
  }

  async login(data: { phone: string; otp: string }) {
    const isValid = this.verifyOtp(data.phone, data.otp);
    if (!isValid) {
      throw new UnauthorizedException('Invalid or expired OTP');
    }

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

    if (!broker) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (broker.status === 'BLOCKED') {
      throw new UnauthorizedException('Account is blocked');
    }

    // Activate on first login
    if (broker.status === 'PENDING') {
      await this.prisma.broker.update({
        where: { id: broker.id },
        data: { status: 'ACTIVE' },
      });
    }

    const payload = { sub: broker.id, phone: broker.phone, role: broker.role };
    const accessToken = this.jwtService.sign(payload);
    const refreshToken = this.jwtService.sign(payload, {
      expiresIn: process.env.JWT_REFRESH_TTL || '7d',
    });

    return {
      accessToken,
      refreshToken,
      broker: {
        id: broker.id,
        fullName: broker.fullName,
        phone: broker.phone,
        role: broker.role,
        status: broker.status === 'PENDING' ? 'ACTIVE' : broker.status,
        funnelStage: broker.funnelStage,
        agency: broker.brokerAgencies[0]?.agency ?? null,
      },
    };
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
