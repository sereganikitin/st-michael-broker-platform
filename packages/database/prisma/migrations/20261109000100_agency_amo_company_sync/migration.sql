CREATE TABLE "agency_amo_company_sync" (
    "agency_id" TEXT NOT NULL,
    "link_status" TEXT NOT NULL DEFAULT 'NOT_FOUND',
    "company_ids" JSONB NOT NULL DEFAULT '[]',
    "profile" JSONB NOT NULL DEFAULT '{}',
    "field_sources" JSONB NOT NULL DEFAULT '{}',
    "conflicts" JSONB NOT NULL DEFAULT '{}',
    "contracts" JSONB NOT NULL DEFAULT '[]',
    "source_updated_at" TIMESTAMP(3),
    "last_attempt_at" TIMESTAMP(3) NOT NULL,
    "last_success_at" TIMESTAMP(3),
    "error_code" TEXT,
    "content_hash" VARCHAR(64),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "agency_amo_company_sync_pkey" PRIMARY KEY ("agency_id"),
    CONSTRAINT "agency_amo_company_sync_link_status_check" CHECK ("link_status" IN ('LINKED', 'NOT_FOUND', 'CONFLICT')),
    CONSTRAINT "agency_amo_company_sync_json_shapes_check" CHECK (
      jsonb_typeof("company_ids") = 'array' AND jsonb_typeof("profile") = 'object'
      AND jsonb_typeof("field_sources") = 'object' AND jsonb_typeof("conflicts") = 'object'
      AND jsonb_typeof("contracts") = 'array'
    ),
    CONSTRAINT "agency_amo_company_sync_agency_id_fkey" FOREIGN KEY ("agency_id") REFERENCES "agencies"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "agency_amo_company_sync_last_success_at_idx" ON "agency_amo_company_sync"("last_success_at");
