import { Injectable, Inject, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaClient } from '@st-michael/database';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';

@Injectable()
export class MeetingsService {
  constructor(
    @Inject('PrismaClient') private prisma: PrismaClient,
    @InjectQueue('notifications') private notificationQueue: Queue,
  ) {}

  async getMeetings(
    brokerId: string,
    query: {
      page?: number;
      limit?: number;
      sortBy?: string;
      sortOrder?: 'asc' | 'desc';
      status?: string;
      type?: string;
    },
  ) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;
    const skip = (page - 1) * limit;

    const where: any = { brokerId };
    if (query.status) where.status = query.status;
    else where.status = { not: 'CANCELLED' };
    if (query.type) where.type = query.type;

    const orderBy: any = {};
    orderBy[query.sortBy || 'date'] = query.sortOrder || 'desc';

    const [meetings, total] = await Promise.all([
      this.prisma.meeting.findMany({
        where,
        include: {
          client: { select: { id: true, fullName: true, phone: true } },
        },
        skip,
        take: limit,
        orderBy,
      }),
      this.prisma.meeting.count({ where }),
    ]);

    return {
      meetings,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getMeeting(id: string, brokerId: string) {
    const meeting = await this.prisma.meeting.findUnique({
      where: { id },
      include: {
        client: true,
        broker: { select: { id: true, fullName: true, phone: true } },
      },
    });

    if (!meeting) throw new NotFoundException('Meeting not found');

    if (meeting.brokerId !== brokerId) {
      const requester = await this.prisma.broker.findUnique({ where: { id: brokerId } });
      if (requester?.role === 'BROKER') throw new NotFoundException('Meeting not found');
    }

    return meeting;
  }

  async createMeeting(
    brokerId: string,
    data: { clientId: string; type: string; date?: string; slotId?: string; comment?: string; extraPhone?: string; notifySms?: boolean; notifyEmail?: boolean; notifyReminder?: boolean },
  ) {
    const client = await this.prisma.client.findUnique({ where: { id: data.clientId } });
    if (!client) throw new NotFoundException('Client not found');
    if (client.brokerId !== brokerId) throw new BadRequestException('Client does not belong to you');

    let meetingDate: Date;
    let slotId: string | undefined;

    if (data.slotId) {
      const slot = await this.prisma.meetingSlot.findUnique({ where: { id: data.slotId } });
      if (!slot || !slot.isActive) throw new BadRequestException('Слот не существует или отключён');
      if (slot.type && slot.type !== data.type) {
        throw new BadRequestException('Тип встречи не соответствует слоту');
      }
      const booked = await this.prisma.meeting.count({
        where: { slotId: slot.id, status: { not: 'CANCELLED' } },
      });
      if (booked >= slot.capacity) {
        throw new BadRequestException('Слот полностью занят');
      }
      meetingDate = slot.startsAt;
      slotId = slot.id;
    } else if (data.date) {
      meetingDate = new Date(data.date);
      if (isNaN(meetingDate.getTime())) throw new BadRequestException('Invalid date');
    } else {
      throw new BadRequestException('Required: slotId or date');
    }

    const commentParts = [
      data.comment,
      data.extraPhone ? `Доп. телефон: ${data.extraPhone}` : '',
    ].filter(Boolean);

    const meeting = await this.prisma.meeting.create({
      data: {
        clientId: data.clientId,
        brokerId,
        type: data.type as any,
        date: meetingDate,
        slotId,
        comment: commentParts.join('. ') || null,
      },
      include: { client: { select: { id: true, fullName: true, phone: true, email: true } } },
    });

    const typeLabel = data.type === 'OFFICE_VISIT' ? 'в офисе' : data.type === 'ONLINE' ? 'онлайн' : 'брокер-тур';
    const dateStr = meetingDate.toLocaleString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const body = `Встреча ${typeLabel} с клиентом ${meeting.client.fullName} запланирована на ${dateStr}`;

    try {
      if (data.notifySms) {
        await this.notificationQueue.add('send', { brokerId, channel: 'SMS', body });
      }
      if (data.notifyEmail) {
        await this.notificationQueue.add('send', { brokerId, channel: 'EMAIL', subject: 'Встреча запланирована', body });
      }
      if (data.notifyReminder) {
        const reminderAt = new Date(meetingDate.getTime() - 2 * 60 * 60 * 1000);
        const delay = Math.max(0, reminderAt.getTime() - Date.now());
        await this.notificationQueue.add(
          'send',
          { brokerId, channel: 'SMS', body: `Напоминание: встреча с ${meeting.client.fullName} через 2 часа (${dateStr})` },
          { delay },
        );
      }
    } catch (e) {
      console.error('Notification queue failed:', e);
    }

    // Update broker funnel stage if needed
    const broker = await this.prisma.broker.findUnique({ where: { id: brokerId } });
    if (broker && ['NEW_BROKER', 'BROKER_TOUR', 'FIXATION'].includes(broker.funnelStage)) {
      await this.prisma.broker.update({
        where: { id: brokerId },
        data: { funnelStage: 'MEETING' },
      });
    }

    return meeting;
  }

  async updateMeeting(
    id: string,
    brokerId: string,
    data: { date?: string; comment?: string; status?: string; type?: string; extraPhone?: string },
  ) {
    const meeting = await this.prisma.meeting.findUnique({ where: { id } });
    if (!meeting) throw new NotFoundException('Meeting not found');
    if (meeting.brokerId !== brokerId) {
      const requester = await this.prisma.broker.findUnique({ where: { id: brokerId } });
      if (requester?.role === 'BROKER') throw new BadRequestException('Not your meeting');
    }

    const updateData: any = {};
    if (data.date) updateData.date = new Date(data.date);
    if (data.status) updateData.status = data.status;
    if (data.type) updateData.type = data.type;

    // Preserve/append "Доп. телефон" in comment
    if (data.comment !== undefined || data.extraPhone !== undefined) {
      const parts: string[] = [];
      const rawComment = data.comment !== undefined ? data.comment : (meeting.comment || '').replace(/\.?\s*Доп\. телефон:.*$/, '').trim();
      if (rawComment) parts.push(rawComment);
      if (data.extraPhone) parts.push(`Доп. телефон: ${data.extraPhone}`);
      updateData.comment = parts.join('. ') || null;
    }

    return this.prisma.meeting.update({
      where: { id },
      data: updateData,
      include: { client: { select: { id: true, fullName: true, phone: true } } },
    });
  }

  async cancelMeeting(id: string, brokerId: string) {
    return this.updateMeeting(id, brokerId, { status: 'CANCELLED' });
  }

  // ─── Slots ────────────────────────────────────────────────

  async getAvailableSlots(query: { date?: string; from?: string; to?: string; type?: string }) {
    let from: Date;
    let to: Date;

    if (query.date) {
      const d = new Date(query.date);
      if (isNaN(d.getTime())) throw new BadRequestException('Invalid date');
      from = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
      to = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
    } else if (query.from && query.to) {
      from = new Date(query.from);
      to = new Date(query.to);
    } else {
      const now = new Date();
      from = now;
      to = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    }

    const where: any = {
      isActive: true,
      startsAt: { gte: from, lte: to },
    };
    if (query.type) where.OR = [{ type: query.type as any }, { type: null }];

    const slots = await this.prisma.meetingSlot.findMany({
      where,
      orderBy: { startsAt: 'asc' },
    });

    // Compute booked counts in one query
    const slotIds = slots.map((s) => s.id);
    const booked = slotIds.length
      ? await this.prisma.meeting.groupBy({
          by: ['slotId'],
          where: { slotId: { in: slotIds }, status: { not: 'CANCELLED' } },
          _count: true,
        })
      : [];
    const bookedMap = new Map(booked.map((b) => [b.slotId, b._count]));

    return slots.map((s) => {
      const bookedCount = bookedMap.get(s.id) || 0;
      return {
        id: s.id,
        startsAt: s.startsAt,
        durationMin: s.durationMin,
        capacity: s.capacity,
        type: s.type,
        booked: bookedCount,
        available: Math.max(0, s.capacity - bookedCount),
      };
    });
  }

  async listSlotsAdmin(query: { from?: string; to?: string }) {
    const where: any = {};
    if (query.from || query.to) {
      where.startsAt = {};
      if (query.from) where.startsAt.gte = new Date(query.from);
      if (query.to) where.startsAt.lte = new Date(query.to);
    }
    const slots = await this.prisma.meetingSlot.findMany({
      where,
      orderBy: { startsAt: 'asc' },
      take: 500,
    });
    const slotIds = slots.map((s) => s.id);
    const booked = slotIds.length
      ? await this.prisma.meeting.groupBy({
          by: ['slotId'],
          where: { slotId: { in: slotIds }, status: { not: 'CANCELLED' } },
          _count: true,
        })
      : [];
    const bookedMap = new Map(booked.map((b) => [b.slotId, b._count]));
    return slots.map((s) => ({
      ...s,
      booked: bookedMap.get(s.id) || 0,
    }));
  }

  async createSlots(data: {
    startsAt?: string;
    durationMin?: number;
    capacity?: number;
    type?: string;
    // Bulk: generate range days × times
    days?: string[];          // ['2026-05-01', ...]
    times?: string[];         // ['10:00', '11:00', ...]
  }) {
    if (Array.isArray(data.days) && Array.isArray(data.times) && data.days.length && data.times.length) {
      const created: any[] = [];
      for (const day of data.days) {
        for (const time of data.times) {
          const [h, m] = time.split(':').map(Number);
          if (isNaN(h) || isNaN(m)) continue;
          const dt = new Date(`${day}T00:00:00`);
          if (isNaN(dt.getTime())) continue;
          dt.setHours(h, m, 0, 0);
          // Skip duplicates
          const exists = await this.prisma.meetingSlot.findFirst({
            where: { startsAt: dt, type: data.type as any || null },
          });
          if (exists) continue;
          const slot = await this.prisma.meetingSlot.create({
            data: {
              startsAt: dt,
              durationMin: data.durationMin || 60,
              capacity: data.capacity || 1,
              type: (data.type as any) || null,
            },
          });
          created.push(slot);
        }
      }
      return { created: created.length, slots: created };
    }

    if (!data.startsAt) throw new BadRequestException('startsAt or days+times required');
    const dt = new Date(data.startsAt);
    if (isNaN(dt.getTime())) throw new BadRequestException('Invalid startsAt');

    const slot = await this.prisma.meetingSlot.create({
      data: {
        startsAt: dt,
        durationMin: data.durationMin || 60,
        capacity: data.capacity || 1,
        type: (data.type as any) || null,
      },
    });
    return { created: 1, slots: [slot] };
  }

  async updateSlot(id: string, data: { capacity?: number; durationMin?: number; isActive?: boolean; startsAt?: string }) {
    const slot = await this.prisma.meetingSlot.findUnique({ where: { id } });
    if (!slot) throw new NotFoundException('Slot not found');

    const update: any = {};
    if (data.capacity !== undefined) update.capacity = data.capacity;
    if (data.durationMin !== undefined) update.durationMin = data.durationMin;
    if (data.isActive !== undefined) update.isActive = data.isActive;
    if (data.startsAt) {
      const dt = new Date(data.startsAt);
      if (!isNaN(dt.getTime())) update.startsAt = dt;
    }

    return this.prisma.meetingSlot.update({ where: { id }, data: update });
  }

  async deleteSlot(id: string) {
    // Block delete if there are active meetings booked into this slot
    const booked = await this.prisma.meeting.count({
      where: { slotId: id, status: { not: 'CANCELLED' } },
    });
    if (booked > 0) {
      throw new BadRequestException(`Слот используется в ${booked} активных встречах`);
    }
    await this.prisma.meetingSlot.delete({ where: { id } });
    return { ok: true };
  }

  async signAct(id: string, brokerId: string) {
    const meeting = await this.prisma.meeting.findUnique({
      where: { id },
      include: { client: true },
    });

    if (!meeting) throw new NotFoundException('Meeting not found');
    if (meeting.brokerId !== brokerId) throw new BadRequestException('Not your meeting');

    const updatedMeeting = await this.prisma.meeting.update({
      where: { id },
      data: { actSigned: true, status: 'COMPLETED' },
    });

    // Update client fixation status when act is signed
    await this.prisma.client.update({
      where: { id: meeting.clientId },
      data: {
        fixationStatus: 'FIXED',
        fixationExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        inspectionActSigned: true,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        userId: brokerId,
        action: 'ACT_SIGNED',
        entity: 'Meeting',
        entityId: id,
        payload: { clientId: meeting.clientId },
      },
    });

    return { meeting: updatedMeeting, message: 'Act signed. Client fixation updated.' };
  }
}
