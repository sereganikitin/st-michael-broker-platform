import { Inject, Injectable } from "@nestjs/common";
import { InjectQueue, Process, Processor } from "@nestjs/bull";
import { PrismaClient } from "@st-michael/database";
import type { Job, Queue } from "bull";
import {
  AMO_UNIQUENESS_QUEUE,
  AMO_UNIQUENESS_JOB_OPTIONS,
} from "../common/amo-uniqueness";
import { notHistoricalClientWhere } from "../common/historical-client";
import { WebhooksService } from "./webhooks.service";
import { AmoReviewTaskService } from "./amo-review-task.service";

@Processor(AMO_UNIQUENESS_QUEUE)
export class AmoUniquenessProcessor {
  constructor(
    private readonly webhooks: WebhooksService,
    private readonly reviewTasks: AmoReviewTaskService,
  ) {}

  @Process({ name: "reconcile", concurrency: 1 })
  async process(job: Job<{ leadId: number }>) {
    const id = Number(job.data.leadId);
    if (!Number.isSafeInteger(id) || id <= 0)
      throw new Error("INVALID_UNIQUENESS_LEAD_ID");
    await this.webhooks.reconcileLeadUniqueness(id);
    await this.reviewTasks.ensureForLead(id);
  }
}

@Injectable()
export class AmoUniquenessRecoveryService {
  constructor(
    @Inject("PrismaClient") private readonly prisma: PrismaClient,
    @InjectQueue(AMO_UNIQUENESS_QUEUE) private readonly queue: Queue,
  ) {}

  async runBatch() {
    // Independent cursors prevent a large active population from starving reviews.
    for (const status of ["UNDER_REVIEW", "CONDITIONALLY_UNIQUE"] as const) {
      const key = `AMO_UNIQUENESS_CURSOR_V1:${status}`;
      const cursor = await this.prisma.systemSetting.findUnique({
        where: { key },
      });
      const rows = await this.prisma.client.findMany({
        where: {
          ...notHistoricalClientWhere,
          uniquenessStatus: status,
          amoLeadId: { not: null },
          ...(cursor?.value ? { id: { gt: cursor.value } } : {}),
          deals: { none: { status: { in: ["PAID", "COMMISSION_PAID"] } } },
        },
        select: { id: true, amoLeadId: true },
        orderBy: { id: "asc" },
        take: 50,
      });
      for (const id of new Set(rows.map((row) => Number(row.amoLeadId)))) {
        if (Number.isSafeInteger(id) && id > 0)
          await this.queue.add(
            "reconcile",
            { leadId: id },
            AMO_UNIQUENESS_JOB_OPTIONS,
          );
      }
      // Do not advance the cursor if queue submission failed.
      const value = rows.length === 50 ? rows[rows.length - 1].id : "";
      await this.prisma.systemSetting.upsert({
        where: { key },
        create: { key, value },
        update: { value },
      });
    }
  }
}
