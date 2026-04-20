import { Injectable, Inject, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaClient } from '@st-michael/database';

@Injectable()
export class MeetingsService {
  constructor(@Inject('PrismaClient') private prisma: PrismaClient) {}

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

    const where: any = {
      brokerId,
      client: { deals: { some: { status: { in: ['SIGNED', 'PAID', 'COMMISSION_PAID'] } } } },
    };
    if (query.status) where.status = query.status;
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
    data: { clientId: string; type: string; date: string; comment?: string; extraPhone?: string; notifySms?: boolean; notifyEmail?: boolean; notifyReminder?: boolean },
  ) {
    const client = await this.prisma.client.findUnique({ where: { id: data.clientId } });
    if (!client) throw new NotFoundException('Client not found');
    if (client.brokerId !== brokerId) throw new BadRequestException('Client does not belong to you');

    const commentParts = [
      data.comment,
      data.extraPhone ? `Доп. телефон: ${data.extraPhone}` : '',
    ].filter(Boolean);

    const meetingDate = new Date(data.date);

    const meeting = await this.prisma.meeting.create({
      data: {
        clientId: data.clientId,
        brokerId,
        type: data.type as any,
        date: meetingDate,
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
    data: { date?: string; comment?: string; status?: string },
  ) {
    const meeting = await this.prisma.meeting.findUnique({ where: { id } });
    if (!meeting) throw new NotFoundException('Meeting not found');
    if (meeting.brokerId !== brokerId) {
      const requester = await this.prisma.broker.findUnique({ where: { id: brokerId } });
      if (requester?.role === 'BROKER') throw new BadRequestException('Not your meeting');
    }

    const updateData: any = {};
    if (data.date) updateData.date = new Date(data.date);
    if (data.comment !== undefined) updateData.comment = data.comment;
    if (data.status) updateData.status = data.status;

    return this.prisma.meeting.update({
      where: { id },
      data: updateData,
      include: { client: { select: { id: true, fullName: true, phone: true } } },
    });
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
