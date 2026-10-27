-- Reassignment keeps the cancelled assignment for audit and creates a successor.
-- Install the replacement guard before removing the legacy all-status index.
-- No business rows are updated/deleted; any duplicate live/completed targets
-- make CREATE UNIQUE INDEX fail and roll back the entire migration.
BEGIN;
CREATE UNIQUE INDEX "loyalty_call_assignments_campaign_our_agency_live_key"
ON "loyalty_call_assignments" ("campaign_id", "our_agency_id")
WHERE "our_agency_id" IS NOT NULL AND "status" <> 'CANCELLED';
DROP INDEX "loyalty_call_assignments_campaign_our_agency_key";
ALTER INDEX "loyalty_call_assignments_campaign_our_agency_live_key"
RENAME TO "loyalty_call_assignments_campaign_our_agency_key";
COMMIT;
