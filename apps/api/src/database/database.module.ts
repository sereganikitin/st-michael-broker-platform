import { Global, Logger, Module } from '@nestjs/common';
import { PrismaClient } from '@st-michael/database';
import { safeDatabaseFailure } from './database-failure';

// Never send Prisma query/parameters or raw engine errors to stdout, even in
// development or with PRISMA_LOG=verbose: mutations can contain password hashes
// and PII. Event callbacks deliberately ignore every field of the engine event.
const prismaProvider = {
  provide: 'PrismaClient',
  useFactory: () => {
    const prisma = new PrismaClient({
      log: [
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ],
    });
    prisma.$on('warn', () => Logger.warn('[database] request warning'));
    prisma.$on('error', () => Logger.error('[database] request failed'));
    // The engine event cannot safely identify the rejected operation. Query
    // extensions also cover raw queries and interactive transaction delegates,
    // including failures swallowed by older sync jobs. Execute once and rethrow
    // the exact exception; logging must never retry a possibly committed write.
    return prisma.$extends({
      name: 'safe-database-failure-context',
      query: {
        async $allOperations({ model, operation, args, query }) {
          try {
            return await query(args);
          } catch (error) {
            try {
              Logger.error(`[database] request rejected ${safeDatabaseFailure(error, model, operation)}`);
            } catch { /* a logger failure must not replace the original query failure */ }
            throw error;
          }
        },
      },
    });
  },
};

@Global()
@Module({
  providers: [prismaProvider],
  exports: ['PrismaClient'],
})
export class DatabaseModule {}
