import { createHash } from 'node:crypto';
import type { PrismaClient } from '@st-michael/database';

export const RECONCILIATION_ALERT_STATE_KEY = 'OPS_AMO_RECONCILIATION_ALERT_STATE_V1';
type AlertRow = { id: string; amoSyncStatus?: string | null; amoSyncError?: string | null };

export function reconciliationFingerprint(rows: AlertRow[]): string {
  const state = rows.map(row => [row.id, row.amoSyncStatus ?? null, row.amoSyncError ?? null])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return createHash('sha256').update(JSON.stringify(state)).digest('hex');
}

/** Claim before delivery: a lost Telegram reply must not cause hourly duplicates.
 * Only this dedicated setting is changed; client, CRM and queue state are untouched.
 * Empty state resets the family so a later recurrence can notify again. */
export async function claimReconciliationAlert(prisma: PrismaClient, rows: AlertRow[]): Promise<boolean> {
  const value = reconciliationFingerprint(rows);
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('OPS_AMO_RECONCILIATION_ALERT_STATE_V1'))`;
    const previous = await tx.systemSetting.findUnique({
      where: { key: RECONCILIATION_ALERT_STATE_KEY }, select: { value: true },
    });
    if (previous?.value === value) return false;
    await tx.systemSetting.upsert({
      where: { key: RECONCILIATION_ALERT_STATE_KEY },
      create: { key: RECONCILIATION_ALERT_STATE_KEY, value, updatedBy: 'scheduler-alert-state' },
      update: { value, updatedBy: 'scheduler-alert-state' },
    });
    return rows.length > 0;
  }, { isolationLevel: 'Serializable', maxWait: 5000, timeout: 10000 });
}
