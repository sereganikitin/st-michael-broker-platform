-- Word program 2026 overlay: partner name → Anna card. Call book, not «Сделки».
CREATE TABLE "loyalty_program_matches" (
    "id" TEXT NOT NULL,
    "partner_key" TEXT NOT NULL,
    "organization_id" TEXT,
    "person_id" TEXT,
    "status" TEXT NOT NULL,
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "loyalty_program_matches_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "loyalty_program_matches_partner_key_key" ON "loyalty_program_matches"("partner_key");
CREATE INDEX "loyalty_program_matches_status_idx" ON "loyalty_program_matches"("status");
