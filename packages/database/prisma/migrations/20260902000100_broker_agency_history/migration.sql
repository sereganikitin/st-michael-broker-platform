BEGIN;

ALTER TABLE "broker_agencies"
  ADD COLUMN "ended_at" TIMESTAMP(3),
  ADD COLUMN "linked_source" TEXT NOT NULL DEFAULT 'LEGACY',
  ADD COLUMN "last_confirmed_at" TIMESTAMP(3),
  ADD COLUMN "last_confirmation_source" TEXT;

UPDATE "broker_agencies"
SET
  "linked_source" = 'LEGACY_BACKFILL',
  "last_confirmed_at" = "joined_at",
  "last_confirmation_source" = 'LEGACY_BACKFILL';

-- Production historically did not enforce one primary row per broker. Keep
-- the oldest primary deterministically and demote accidental extras before
-- adding the invariant.
WITH ranked_primary AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "broker_id"
      ORDER BY "joined_at" ASC, "id" ASC
    ) AS position
  FROM "broker_agencies"
  WHERE "is_primary" = true AND "ended_at" IS NULL
)
UPDATE "broker_agencies" AS ba
SET "is_primary" = false
FROM ranked_primary AS ranked
WHERE ba."id" = ranked."id" AND ranked.position > 1;

CREATE INDEX "broker_agencies_broker_id_ended_at_idx"
  ON "broker_agencies"("broker_id", "ended_at");

CREATE UNIQUE INDEX "broker_agencies_one_active_primary_per_broker_idx"
  ON "broker_agencies"("broker_id")
  WHERE "is_primary" = true AND "ended_at" IS NULL;

ALTER TABLE "broker_agencies"
  ADD CONSTRAINT "broker_agencies_ended_not_primary_check"
  CHECK ("ended_at" IS NULL OR "is_primary" = false);

ALTER TABLE "broker_agencies"
  ADD CONSTRAINT "broker_agencies_valid_period_check"
  CHECK ("ended_at" IS NULL OR "ended_at" >= "joined_at");

CREATE TABLE "broker_agency_events" (
  "id" TEXT NOT NULL,
  "broker_agency_id" TEXT,
  "broker_id" TEXT NOT NULL,
  "agency_id" TEXT NOT NULL,
  "client_id" TEXT,
  "actor_broker_id" TEXT,
  "event_type" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "metadata" JSONB,
  "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "broker_agency_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "broker_agency_events_client_id_key"
  ON "broker_agency_events"("client_id");
CREATE INDEX "broker_agency_events_broker_id_occurred_at_idx"
  ON "broker_agency_events"("broker_id", "occurred_at");
CREATE INDEX "broker_agency_events_agency_id_occurred_at_idx"
  ON "broker_agency_events"("agency_id", "occurred_at");
CREATE INDEX "broker_agency_events_broker_agency_id_occurred_at_idx"
  ON "broker_agency_events"("broker_agency_id", "occurred_at");

-- Existing current links become the first known fact. We deliberately do not
-- invent an end date for any historical row.
INSERT INTO "broker_agency_events" (
  "id", "broker_agency_id", "broker_id", "agency_id", "event_type",
  "source", "metadata", "occurred_at"
)
SELECT
  md5('broker-agency-backfill:' || ba."id")::uuid::text,
  ba."id",
  ba."broker_id",
  ba."agency_id",
  'LINK_CREATED',
  'LEGACY_BACKFILL',
  jsonb_build_object('isPrimary', ba."is_primary"),
  ba."joined_at"
FROM "broker_agencies" AS ba
ON CONFLICT DO NOTHING;

-- Every already stored fixation is also an immutable historical attribution.
-- This backfill does not claim that its agency is still a current workplace.
INSERT INTO "broker_agency_events" (
  "id", "broker_agency_id", "broker_id", "agency_id", "client_id",
  "actor_broker_id", "event_type", "source", "occurred_at"
)
SELECT
  md5('client-fixation-agency:' || c."id")::uuid::text,
  ba."id",
  COALESCE(c."responsible_broker_id", c."broker_id"),
  c."fixation_agency_id",
  c."id",
  c."broker_id",
  'FIXATION_ATTRIBUTED',
  'CLIENT_BACKFILL',
  c."created_at"
FROM "clients" AS c
LEFT JOIN "broker_agencies" AS ba
  ON ba."broker_id" = COALESCE(c."responsible_broker_id", c."broker_id")
 AND ba."agency_id" = c."fixation_agency_id"
WHERE c."fixation_agency_id" IS NOT NULL
ON CONFLICT ("client_id") DO NOTHING;

-- Central audit for every application path that creates or changes a current
-- membership. Keeping it in PostgreSQL prevents an import/admin path from
-- silently bypassing history.
CREATE OR REPLACE FUNCTION log_broker_agency_change()
RETURNS trigger AS $$
DECLARE
  event_name TEXT;
  event_source TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    event_name := 'LINK_CREATED';
    event_source := NEW."linked_source";
  ELSIF OLD."ended_at" IS NULL AND NEW."ended_at" IS NOT NULL THEN
    event_name := 'LINK_ENDED';
    event_source := COALESCE(NEW."last_confirmation_source", 'EXPLICIT_END');
  ELSIF OLD."ended_at" IS NOT NULL AND NEW."ended_at" IS NULL THEN
    event_name := 'LINK_REACTIVATED';
    event_source := COALESCE(NEW."last_confirmation_source", 'REACTIVATION');
  ELSIF OLD."is_primary" IS DISTINCT FROM NEW."is_primary" THEN
    event_name := 'PRIMARY_CHANGED';
    event_source := COALESCE(NEW."last_confirmation_source", 'PRIMARY_CHANGE');
  ELSIF OLD."last_confirmed_at" IS DISTINCT FROM NEW."last_confirmed_at"
     OR OLD."last_confirmation_source" IS DISTINCT FROM NEW."last_confirmation_source" THEN
    event_name := 'LINK_CONFIRMED';
    event_source := COALESCE(NEW."last_confirmation_source", 'CONFIRMATION');
  ELSE
    RETURN NEW;
  END IF;

  INSERT INTO "broker_agency_events" (
    "id", "broker_agency_id", "broker_id", "agency_id", "event_type",
    "source", "metadata", "occurred_at"
  ) VALUES (
    md5(NEW."id" || ':' || event_name || ':' || clock_timestamp()::text || ':' || random()::text)::uuid::text,
    NEW."id",
    NEW."broker_id",
    NEW."agency_id",
    event_name,
    event_source,
    jsonb_build_object(
      'isPrimary', NEW."is_primary",
      'joinedAt', NEW."joined_at",
      'endedAt', NEW."ended_at"
    ),
    clock_timestamp()
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "broker_agency_change_audit"
AFTER INSERT OR UPDATE ON "broker_agencies"
FOR EACH ROW EXECUTE FUNCTION log_broker_agency_change();

-- New Client rows are the canonical source for fixation counts. In the same
-- transaction, confirm the responsible broker's additional agency link and
-- record who submitted the fixation. No other active link is ended here.
CREATE OR REPLACE FUNCTION attribute_client_fixation_agency()
RETURNS trigger AS $$
DECLARE
  subject_broker_id TEXT;
  membership_id TEXT;
  membership_was_ended BOOLEAN;
  attribution_source TEXT;
BEGIN
  IF NEW."fixation_agency_id" IS NULL THEN
    RETURN NEW;
  END IF;

  subject_broker_id := COALESCE(NEW."responsible_broker_id", NEW."broker_id");
  attribution_source := CASE
    WHEN subject_broker_id = NEW."broker_id" THEN 'SELF_FIXATION'
    ELSE 'DELEGATED_FIXATION'
  END;

  -- Serialize first-primary selection for the same responsible broker.
  PERFORM pg_advisory_xact_lock(hashtext('broker-agency:' || subject_broker_id));

  SELECT ba."id", ba."ended_at" IS NOT NULL
  INTO membership_id, membership_was_ended
  FROM "broker_agencies" AS ba
  WHERE ba."broker_id" = subject_broker_id
    AND ba."agency_id" = NEW."fixation_agency_id"
  FOR UPDATE;

  IF membership_id IS NULL THEN
    membership_id := md5(NEW."id" || ':responsible-agency-membership')::uuid::text;
    INSERT INTO "broker_agencies" (
      "id", "broker_id", "agency_id", "is_primary", "joined_at",
      "linked_source", "last_confirmed_at", "last_confirmation_source"
    ) VALUES (
      membership_id,
      subject_broker_id,
      NEW."fixation_agency_id",
      NOT EXISTS (
        SELECT 1 FROM "broker_agencies"
        WHERE "broker_id" = subject_broker_id
          AND "is_primary" = true
          AND "ended_at" IS NULL
      ),
      NEW."created_at",
      attribution_source,
      NEW."created_at",
      attribution_source
    );
  ELSE
    UPDATE "broker_agencies"
    SET
      "ended_at" = NULL,
      "joined_at" = CASE WHEN membership_was_ended THEN NEW."created_at" ELSE "joined_at" END,
      "last_confirmed_at" = NEW."created_at",
      "last_confirmation_source" = attribution_source
    WHERE "id" = membership_id;
  END IF;

  INSERT INTO "broker_agency_events" (
    "id", "broker_agency_id", "broker_id", "agency_id", "client_id",
    "actor_broker_id", "event_type", "source", "metadata", "occurred_at"
  ) VALUES (
    md5(NEW."id" || ':fixation-attribution')::uuid::text,
    membership_id,
    subject_broker_id,
    NEW."fixation_agency_id",
    NEW."id",
    NEW."broker_id",
    'FIXATION_ATTRIBUTED',
    attribution_source,
    jsonb_build_object('project', NEW."project"::text),
    NEW."created_at"
  )
  ON CONFLICT ("client_id") DO NOTHING;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "client_fixation_agency_attribution"
AFTER INSERT ON "clients"
FOR EACH ROW EXECUTE FUNCTION attribute_client_fixation_agency();

COMMIT;
