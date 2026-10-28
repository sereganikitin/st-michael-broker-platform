import React from 'react';
import type { ClientStatusEvidence } from '@/lib/client-status-display';

/** Transport evidence is independent of uniqueness and the inspection act. */
export function ClientAmoTransferStatus({ client }: { client: ClientStatusEvidence }) {
  if (client.amoSyncStatus !== 'SYNCED') return null;
  return (
    <span
      className="inline-block text-xs px-2 py-1 rounded bg-info/20 text-info"
      title="Передача заявки подтверждена. Эта отметка не означает подписание акта осмотра."
    >
      Передан в amoCRM
    </span>
  );
}
