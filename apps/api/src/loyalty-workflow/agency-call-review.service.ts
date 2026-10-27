import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { PrismaClient } from "@st-michael/database";
import { createHash } from "node:crypto";
import { CurrentUserPayload } from "../auth/current-user.decorator";
import { LoyaltyPermissionService } from "./loyalty-permission.service";
import { AgencyCallReviewDto } from "./agency-call-review.dto";

const includeReviewer = { reviewer: { select: { id: true, fullName: true } } };
const publicReview = (row: any) => {
  const { requestHash, submissionId, ...review } = row;
  return review;
};

@Injectable()
export class AgencyCallReviewService {
  private get db() {
    return this.prisma as any;
  }
  constructor(
    @Inject("PrismaClient") private readonly prisma: PrismaClient,
    private readonly permissions: LoyaltyPermissionService,
  ) {}

  private async requireAttempt(db: any, agencyId: string, attemptId: string) {
    const attempt = await db.loyaltyCallAttempt.findFirst({
      where: { id: attemptId, assignment: { ourAgencyId: agencyId } },
      select: { id: true },
    });
    if (!attempt)
      throw new NotFoundException("Попытка не найдена в этом агентстве");
  }

  async list(agencyId: string, attemptId: string, user: CurrentUserPayload) {
    await this.permissions.require(user, "READ_ALL");
    await this.requireAttempt(this.db, agencyId, attemptId);
    const reviews = await this.db.agencyCallReview.findMany({
      where: { callAttemptId: attemptId },
      orderBy: { version: "desc" },
      include: includeReviewer,
    });
    return { reviews: reviews.map(publicReview) };
  }

  async save(
    agencyId: string,
    attemptId: string,
    body: AgencyCallReviewDto,
    user: CurrentUserPayload,
  ) {
    await this.permissions.requireAll(user, ["READ_ALL", "CALL_REVIEW"]);
    const comment = body.comment.trim();
    const correctionReason = body.correctionReason?.trim() || null;
    if (!comment)
      throw new BadRequestException("Укажите обоснование ручной проверки");
    if (body.expectedVersion > 0 && !correctionReason)
      throw new BadRequestException("Укажите причину исправления проверки");
    const criteria = {
      offerCurrent: body.criteria.offerCurrent,
      needsClarified: body.criteria.needsClarified,
      agreementRecorded: body.criteria.agreementRecorded,
      nextStepCorrect: body.criteria.nextStepCorrect,
    };
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify({
          agencyId,
          attemptId,
          reviewerId: user.id,
          expectedVersion: body.expectedVersion,
          criteria,
          comment,
          correctionReason,
        }),
      )
      .digest("hex");
    return this.db.$transaction(async (tx: any) => {
      // Lock the immutable attempt so concurrent reviewers serialize. Re-read
      // latest review after waiting; never overwrite another reviewer's work.
      await tx.$queryRawUnsafe(
        "SELECT id FROM loyalty_call_attempts WHERE id=$1 FOR UPDATE",
        attemptId,
      );
      await this.requireAttempt(tx, agencyId, attemptId);
      const retry = await tx.agencyCallReview.findUnique({
        where: { submissionId: body.submissionId },
        include: includeReviewer,
      });
      if (retry) {
        if (retry.requestHash !== requestHash)
          throw new ConflictException(
            "Идентификатор отправки уже использован для другой проверки",
          );
        return publicReview(retry);
      }
      const previous = await tx.agencyCallReview.findFirst({
        where: { callAttemptId: attemptId },
        orderBy: { version: "desc" },
      });
      if ((previous?.version ?? 0) !== body.expectedVersion)
        throw new ConflictException(
          "Проверку уже изменили. Обновите историю перед сохранением",
        );
      const review = await tx.agencyCallReview.create({
        data: {
          callAttemptId: attemptId,
          reviewerId: user.id,
          submissionId: body.submissionId,
          requestHash,
          version: body.expectedVersion + 1,
          criteria,
          comment,
          correctionReason,
        },
        include: includeReviewer,
      });
      await tx.loyaltyWorkflowAudit.create({
        data: {
          actorId: user.id,
          action: "AGENCY_CALL_REVIEW_ADDED",
          entityType: "AGENCY",
          entityId: agencyId,
          before: {
            reviewId: previous?.id ?? null,
            version: body.expectedVersion,
          },
          after: {
            reviewId: review.id,
            callAttemptId: attemptId,
            version: review.version,
          },
        },
      });
      return publicReview(review);
    });
  }
}
