-- Additive session-revocation counter. Existing version-zero sessions retain
-- compatibility until the account password is changed. No password rewrites.
ALTER TABLE "brokers" ADD COLUMN "auth_version" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "brokers" ADD CONSTRAINT "brokers_auth_version_nonnegative" CHECK ("auth_version" >= 0);
