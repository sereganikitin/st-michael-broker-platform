-- Run only against a newly created disposable local database.
\set ON_ERROR_STOP on
BEGIN;
CREATE TYPE "LoyaltyPermission" AS ENUM ('READ_ALL');
CREATE TABLE brokers(id TEXT PRIMARY KEY);
CREATE TABLE loyalty_call_attempts(id TEXT PRIMARY KEY);
INSERT INTO brokers VALUES ('synthetic-reviewer');
INSERT INTO loyalty_call_attempts VALUES ('synthetic-attempt');
\ir ../packages/database/prisma/migrations/20261027120000_agency_manual_quality/migration.sql
INSERT INTO agency_call_reviews(id, call_attempt_id, reviewer_id, submission_id, request_hash, version, criteria, comment)
VALUES ('review-1', 'synthetic-attempt', 'synthetic-reviewer', 'submission-1', repeat('a',64), 1, '{}', 'synthetic');
DO $$ BEGIN
  BEGIN
    INSERT INTO agency_call_reviews(id, call_attempt_id, reviewer_id, submission_id, request_hash, version, criteria, comment)
    VALUES ('review-2', 'synthetic-attempt', 'synthetic-reviewer', 'submission-2', repeat('b',64), 1, '{}', 'duplicate version');
    RAISE EXCEPTION 'Duplicate review version was accepted';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN
    INSERT INTO agency_call_reviews(id, call_attempt_id, reviewer_id, submission_id, request_hash, version, criteria, comment)
    VALUES ('review-3', 'synthetic-attempt', 'synthetic-reviewer', 'submission-1', repeat('b',64), 2, '{}', 'duplicate submission');
    RAISE EXCEPTION 'Duplicate submission was accepted';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN
    DELETE FROM loyalty_call_attempts WHERE id='synthetic-attempt';
    RAISE EXCEPTION 'Reviewed attempt deletion was accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  IF (SELECT count(*) FROM loyalty_call_attempts) <> 1 THEN RAISE EXCEPTION 'Existing attempt changed'; END IF;
  IF (SELECT count(*) FROM brokers) <> 1 THEN RAISE EXCEPTION 'Existing reviewer changed'; END IF;
END $$;
ROLLBACK;
SELECT 'PASS additive QA migration, unique version/submission and restricted deletion' AS result;
