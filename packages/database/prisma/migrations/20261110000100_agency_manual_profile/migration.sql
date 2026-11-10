ALTER TABLE "agencies"
  ADD COLUMN "manual_profile" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "manual_profile_field_sources" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "manual_profile_version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "manual_profile_updated_at" TIMESTAMP(3),
  ADD COLUMN "manual_profile_updated_by_id" TEXT;
ALTER TABLE "loyalty_call_attempts" ADD COLUMN "metadata" JSONB NOT NULL DEFAULT '{}';
