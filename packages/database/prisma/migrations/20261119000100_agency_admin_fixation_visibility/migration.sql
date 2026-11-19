ALTER TABLE "broker_agencies" ADD COLUMN "is_agency_admin" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "fixation_requests" ADD COLUMN "responsible_broker_id" TEXT;
ALTER TABLE "fixation_requests" ADD COLUMN "fixation_agency_id" TEXT;

-- Only an existing exact Client -> request relation proves the destination of
-- an old request. Unprocessed payloads are validated by the CHECKING worker.
UPDATE "fixation_requests" AS request
SET "responsible_broker_id" = COALESCE(client."responsible_broker_id", client."broker_id"),
    "fixation_agency_id" = (SELECT agency.id FROM agencies AS agency WHERE agency.id = client."fixation_agency_id")
FROM "clients" AS client
WHERE client."fixation_request_id" = request."id"
  AND client."broker_id" = request."actor_id"
  AND EXISTS (
    SELECT 1 FROM "brokers" AS broker
    WHERE broker."id" = COALESCE(client."responsible_broker_id", client."broker_id")
      AND broker."merged_into_id" IS NULL
  );

CREATE INDEX "fixation_requests_responsible_broker_id_state_created_at_idx"
ON "fixation_requests"("responsible_broker_id", "state", "created_at");
ALTER TABLE "fixation_requests" ADD CONSTRAINT "fixation_requests_responsible_broker_id_fkey"
FOREIGN KEY ("responsible_broker_id") REFERENCES "brokers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fixation_requests" ADD CONSTRAINT "fixation_requests_fixation_agency_id_fkey"
FOREIGN KEY ("fixation_agency_id") REFERENCES "agencies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
