-- Additive: no grants, business records or existing attempts are changed.
ALTER TYPE "LoyaltyPermission" ADD VALUE IF NOT EXISTS 'CALL_REVIEW';
CREATE TABLE "agency_call_reviews" (
  "id" TEXT NOT NULL,
  "call_attempt_id" TEXT NOT NULL,
  "reviewer_id" TEXT NOT NULL,
  "submission_id" VARCHAR(80) NOT NULL,
  "request_hash" CHAR(64) NOT NULL,
  "version" INTEGER NOT NULL CHECK ("version" > 0),
  "criteria" JSONB NOT NULL,
  "comment" TEXT NOT NULL,
  "correction_reason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agency_call_reviews_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "agency_call_reviews_call_attempt_id_fkey" FOREIGN KEY ("call_attempt_id") REFERENCES "loyalty_call_attempts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "agency_call_reviews_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "brokers"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "agency_call_reviews_submission_id_key" ON "agency_call_reviews"("submission_id");
CREATE UNIQUE INDEX "agency_call_reviews_call_attempt_id_version_key" ON "agency_call_reviews"("call_attempt_id", "version");
CREATE INDEX "agency_call_reviews_reviewer_id_created_at_idx" ON "agency_call_reviews"("reviewer_id", "created_at");
