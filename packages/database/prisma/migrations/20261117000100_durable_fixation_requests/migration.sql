CREATE TABLE "fixation_requests" (
 "id" TEXT PRIMARY KEY,
 "actor_id" TEXT NOT NULL,
 "fingerprint" TEXT NOT NULL,
 "phone_key" TEXT NOT NULL,
 "payload" JSONB NOT NULL,
 "state" TEXT NOT NULL DEFAULT 'PENDING',
 "phase" TEXT NOT NULL DEFAULT 'CHECKING',
 "attempts" INTEGER NOT NULL DEFAULT 0,
 "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "lease_token" TEXT,
 "lease_until" TIMESTAMP(3),
 "result" JSONB,
 "error_code" TEXT,
 "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updated_at" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "fixation_requests_state_next_attempt_at_idx" ON "fixation_requests"("state", "next_attempt_at");
CREATE INDEX "fixation_requests_actor_id_fingerprint_idx" ON "fixation_requests"("actor_id", "fingerprint");
CREATE INDEX "fixation_requests_actor_id_created_at_idx" ON "fixation_requests"("actor_id", "created_at");
CREATE TABLE "fixation_request_keys" (
 "actor_id" TEXT NOT NULL,
 "key" TEXT NOT NULL,
 "request_id" TEXT NOT NULL REFERENCES "fixation_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 PRIMARY KEY ("actor_id", "key")
);
CREATE INDEX "fixation_request_keys_request_id_idx" ON "fixation_request_keys"("request_id");
ALTER TABLE "clients" ADD COLUMN "fixation_request_id" TEXT;
CREATE UNIQUE INDEX "clients_fixation_request_id_key" ON "clients"("fixation_request_id");
ALTER TABLE "clients" ADD CONSTRAINT "clients_fixation_request_id_fkey" FOREIGN KEY ("fixation_request_id") REFERENCES "fixation_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
