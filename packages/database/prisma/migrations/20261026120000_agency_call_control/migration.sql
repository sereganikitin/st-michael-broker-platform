BEGIN;

ALTER TABLE "agencies"
  ADD COLUMN "do_not_call" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "call_control_version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "call_control_reason" TEXT,
  ADD COLUMN "call_control_updated_at" TIMESTAMP(3),
  ADD COLUMN "call_contacts" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "call_contacts_version" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "loyalty_call_assignments" ADD COLUMN "work_session_hash" VARCHAR(64);

-- Fail safely if legacy active duplicates exist. Resolve them explicitly before
-- migration; never silently discard assignments or their history.
CREATE UNIQUE INDEX "loyalty_one_open_assignment_per_agency"
ON "loyalty_call_assignments" ("our_agency_id")
WHERE "our_agency_id" IS NOT NULL AND "status" IN ('PENDING', 'IN_PROGRESS');

COMMIT;
