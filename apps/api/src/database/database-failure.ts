import { Prisma } from '@st-michael/database';

const models = new Set<string>(Object.values(Prisma.ModelName));
const operations = new Set([
  'findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany',
  'create', 'createMany', 'createManyAndReturn', 'update', 'updateMany',
  'upsert', 'delete', 'deleteMany', 'count', 'aggregate', 'groupBy',
  '$queryRaw', '$queryRawUnsafe', '$executeRaw', '$executeRawUnsafe', '$runCommandRaw',
]);

// Only bounded technical classifications; never inspect/serialize message,
// stack, query, parameters, target or metadata. A hostile getter must not mask
// the original failure or interrupt a scheduler's existing error handling.
export function safeDatabaseFailureCode(error: unknown): string {
  try {
    if (!error || typeof error !== 'object') return 'UNKNOWN';
    const candidate = error as { code?: unknown; errorCode?: unknown; name?: unknown };
    const code = candidate.code ?? candidate.errorCode;
    if (typeof code === 'string' && /^P[0-9]{4}$/.test(code)) return code;
    if (candidate.name === 'PrismaClientValidationError') return 'VALIDATION';
    if (candidate.name === 'PrismaClientInitializationError') return 'INITIALIZATION';
  } catch { /* keep the original exception and reveal nothing */ }
  return 'UNKNOWN';
}

export function safeDatabaseFailure(error: unknown, model?: string, operation?: string): string {
  const safeModel = model === undefined ? 'RAW' : models.has(model) ? model : 'UNKNOWN';
  const safeOperation = typeof operation === 'string' && operations.has(operation) ? operation : 'UNKNOWN';
  return `code=${safeDatabaseFailureCode(error)} model=${safeModel} operation=${safeOperation}`;
}
