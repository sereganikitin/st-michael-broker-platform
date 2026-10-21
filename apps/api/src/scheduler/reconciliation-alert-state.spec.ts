import { claimReconciliationAlert, reconciliationFingerprint, RECONCILIATION_ALERT_STATE_KEY } from './reconciliation-alert-state';
describe('durable reconciliation alert state', () => {
  function db() {
    let stored: string | null = null;
    const tx = { $executeRaw: jest.fn(), systemSetting: {
      findUnique: jest.fn(async () => stored === null ? null : { value: stored }),
      upsert: jest.fn(async (q: any) => { expect(q.where.key).toBe(RECONCILIATION_ALERT_STATE_KEY); stored = q.update.value; }),
    }};
    return { tx, prisma: { $transaction: jest.fn(async fn => fn(tx)) } as any };
  }
  const row = { id: 'case-a', amoSyncStatus: 'FAILED', amoSyncError: 'ambiguous' };
  it('does not expire or repeat unchanged state, including a new caller', async () => {
    const { prisma } = db();
    expect(await claimReconciliationAlert(prisma, [row])).toBe(true);
    expect(await claimReconciliationAlert(prisma, [row])).toBe(false);
    expect(await claimReconciliationAlert(prisma, [row])).toBe(false);
  });
  it('alerts on changed state and rearms after an empty queue', async () => {
    const { prisma } = db();
    expect(await claimReconciliationAlert(prisma, [])).toBe(false);
    expect(await claimReconciliationAlert(prisma, [row])).toBe(true);
    expect(await claimReconciliationAlert(prisma, [{ ...row, amoSyncError: 'changed' }])).toBe(true);
    expect(await claimReconciliationAlert(prisma, [])).toBe(false);
    expect(await claimReconciliationAlert(prisma, [row])).toBe(true);
  });
  it('uses the whole unordered cohort and serializes the durable claim', async () => {
    expect(reconciliationFingerprint([row, {...row, id:'b'}])).toBe(reconciliationFingerprint([{...row, id:'b'}, row]));
    const { prisma, tx } = db(); await claimReconciliationAlert(prisma, [row]);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ isolationLevel:'Serializable' }));
  });
});
