-- 2026-09-09 (владелец): канал продажи строки реестра — DIRECT (прямая продажа,
-- без брокера; 709 договоров подтверждены владельцем 09.09), BROKER (есть
-- брокер), NULL — не определён. Заполняется скриптом apply-registry-sale-channel.
ALTER TABLE "registry_deals" ADD COLUMN IF NOT EXISTS "sale_channel" TEXT;
CREATE INDEX IF NOT EXISTS "registry_deals_sale_channel_idx" ON "registry_deals"("sale_channel");
