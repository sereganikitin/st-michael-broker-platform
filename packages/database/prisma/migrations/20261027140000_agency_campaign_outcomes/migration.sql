-- Additive manual result history. No existing records or grants are modified.
CREATE TABLE "agency_campaign_outcomes" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "assignment_id" TEXT NOT NULL REFERENCES "loyalty_call_assignments"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "event_id" TEXT NOT NULL,
  "version" INTEGER NOT NULL CHECK ("version" > 0),
  "kind" VARCHAR(20) NOT NULL CHECK ("kind" IN ('MEETING', 'TOUR', 'REACTIVATION')),
  "status" VARCHAR(20) NOT NULL,
  "occurred_at" TIMESTAMP(3) NOT NULL,
  "basis" VARCHAR(1000) NOT NULL CHECK (length(trim("basis")) > 0),
  "comment" VARCHAR(2000) NOT NULL,
  "correction_reason" VARCHAR(1000),
  "actor_id" TEXT NOT NULL REFERENCES "brokers"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "submission_id" VARCHAR(80) NOT NULL,
  "request_hash" CHAR(64) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agency_campaign_outcomes_state_check" CHECK (
    ("kind" IN ('MEETING', 'TOUR') AND "status" IN ('PLANNED', 'HELD', 'CANCELLED')) OR
    ("kind" = 'REACTIVATION' AND "status" IN ('REACTIVATED', 'CANCELLED'))
  ),
  CONSTRAINT "agency_campaign_outcomes_correction_check" CHECK ("version" = 1 OR COALESCE(length(trim("correction_reason")), 0) > 0)
);
CREATE UNIQUE INDEX "agency_campaign_outcomes_event_id_version_key" ON "agency_campaign_outcomes"("event_id", "version");
CREATE UNIQUE INDEX "agency_campaign_outcomes_submission_id_key" ON "agency_campaign_outcomes"("submission_id");
CREATE INDEX "agency_campaign_outcomes_assignment_id_created_at_idx" ON "agency_campaign_outcomes"("assignment_id", "created_at");
