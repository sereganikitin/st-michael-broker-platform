import { Inject, Injectable } from "@nestjs/common";
import { PrismaClient } from "@st-michael/database";
import { AmoCrmAdapter, AMO_SYSTEM_USER_IDS } from "@st-michael/integrations";
import {
  SALES_MEETING_EXCEPTION_PREFIX,
  salesMeetingConflictLeadId,
} from "../common/amo-uniqueness";

@Injectable()
export class AmoReviewTaskService {
  private readonly amo = new AmoCrmAdapter();
  constructor(@Inject("PrismaClient") private readonly prisma: PrismaClient) {}

  async ensureForLead(leadId: number) {
    const clients = await this.prisma.client.findMany({
      where: {
        amoLeadId: BigInt(leadId),
        uniquenessStatus: "UNDER_REVIEW",
        uniquenessReason: { startsWith: SALES_MEETING_EXCEPTION_PREFIX },
      },
    });
    if (!clients.length) return;
    const lead = await this.amo.getLead(leadId);
    if (!lead) throw new Error("REVIEW_TASK_LEAD_UNAVAILABLE");
    if (
      !Number.isSafeInteger(Number(lead.pipeline_id)) ||
      Number(lead.pipeline_id) <= 0 ||
      !Number.isSafeInteger(Number(lead.status_id)) ||
      Number(lead.status_id) <= 0
    ) {
      throw new Error("REVIEW_TASK_LEAD_INVALID");
    }
    if (Number(lead.pipeline_id) !== 7600542 || Number(lead.status_id) === 143)
      return;

    for (const client of clients) {
      const previousLeadId = salesMeetingConflictLeadId(
        client.uniquenessReason,
      );
      if (!previousLeadId || previousLeadId === leadId) continue;
      const marker = `[cabinet-review:${client.id}:${leadId}:${previousLeadId}]`;
      const key = `AMO_REVIEW_TASK_V1:${client.id}:${leadId}`;
      const receipt = await this.prisma.systemSetting.findUnique({
        where: { key },
      });
      if (receipt?.value === "confirmed") continue;
      // Include completed tasks; a completed review must never be recreated.
      const tasks =
        (
          await this.amo.getTasksForEntities("leads", [leadId], {
            limit: 250,
            maxPages: 5,
            requireComplete: true,
          })
        ).get(leadId) || [];
      if (tasks.some((task) => task.text?.includes(marker))) {
        await this.prisma.systemSetting.upsert({
          where: { key },
          create: { key, value: "confirmed" },
          update: { value: "confirmed" },
        });
        continue;
      }
      // Once POST may have run, only a GET can settle it. Never resend after
      // a timeout, a crash, or an acknowledgement that could not be persisted.
      if (receipt) throw new Error("REVIEW_TASK_RECONCILIATION_REQUIRED");
      const human = (id: number) =>
        Number.isSafeInteger(id) && id > 0 && !AMO_SYSTEM_USER_IDS.includes(id);
      const assignment = tasks
        .filter(
          (task) =>
            !task.is_completed && human(Number(task.responsible_user_id)),
        )
        .sort((a, b) => b.created_at - a.created_at || b.id - a.id)[0];
      const responsible = human(Number(lead.responsible_user_id))
        ? Number(lead.responsible_user_id)
        : Number(assignment?.responsible_user_id);
      if (!Number.isSafeInteger(responsible) || responsible <= 0)
        throw new Error("REVIEW_TASK_RESPONSIBLE_MISSING");
      try {
        await this.prisma.systemSetting.create({
          data: { key, value: "armed" },
        });
      } catch (error: any) {
        if (error?.code === "P2002")
          throw new Error("REVIEW_TASK_ALREADY_CLAIMED");
        throw error;
      }
      await this.amo.createTask(
        {
          text: `Проверить уникальность: клиент ранее посещал офис, есть действующая сделка. Предыдущая сделка: https://stmichael.amocrm.ru/leads/detail/${previousLeadId}. Новая заявка: https://stmichael.amocrm.ru/leads/detail/${leadId}. Уточнить право брокера на фиксацию. ${marker}`,
          entityType: "leads",
          entityId: leadId,
          responsibleUserId: responsible,
          taskTypeId: 1,
          completeTillSec: Math.floor(Date.now() / 1000) + 30 * 60,
        },
        { retryTransient: false },
      );
      await this.prisma.systemSetting.update({
        where: { key },
        data: { value: "confirmed" },
      });
    }
  }
}
