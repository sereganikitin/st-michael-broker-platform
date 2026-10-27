-- Only run in a disposable local database. TEMP objects disappear on disconnect.
\set ON_ERROR_STOP on
CREATE TEMP TABLE loyalty_call_assignments (
  id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL,
  our_agency_id TEXT, status TEXT NOT NULL
);
CREATE UNIQUE INDEX loyalty_call_assignments_campaign_our_agency_key
ON loyalty_call_assignments(campaign_id,our_agency_id) WHERE our_agency_id IS NOT NULL;
CREATE UNIQUE INDEX loyalty_one_open_assignment_per_agency
ON loyalty_call_assignments(our_agency_id) WHERE our_agency_id IS NOT NULL AND status IN ('PENDING','IN_PROGRESS');
INSERT INTO loyalty_call_assignments VALUES ('original','campaign','agency','CANCELLED');
\ir ../packages/database/prisma/migrations/20261027150000_agency_reassignment_history/migration.sql
DO $$ BEGIN
  IF (SELECT count(*) FROM loyalty_call_assignments) <> 1 OR
     (SELECT status FROM loyalty_call_assignments WHERE id='original') <> 'CANCELLED'
  THEN RAISE EXCEPTION 'Migration changed history'; END IF;
  INSERT INTO loyalty_call_assignments VALUES ('successor','campaign','agency','PENDING');
  BEGIN
    INSERT INTO loyalty_call_assignments VALUES ('duplicate','campaign','agency','COMPLETED');
    RAISE EXCEPTION 'Duplicate current campaign target accepted';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN
    INSERT INTO loyalty_call_assignments VALUES ('cross-campaign','other','agency','IN_PROGRESS');
    RAISE EXCEPTION 'Duplicate open target accepted';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  INSERT INTO loyalty_call_assignments VALUES ('older','campaign','agency','CANCELLED');
  IF (SELECT count(*) FROM loyalty_call_assignments) <> 3 THEN
    RAISE EXCEPTION 'History/successor count mismatch'; END IF;
END $$;
SELECT 'PASS reassignment migration preserves history and both uniqueness guards' AS result;
