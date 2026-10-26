BEGIN;
ALTER TABLE "loyalty_call_attempts" ADD COLUMN "next_action_kind" VARCHAR(32);
ALTER TABLE "loyalty_tasks" ADD COLUMN "kind" VARCHAR(32) NOT NULL DEFAULT 'OTHER';
COMMIT;
