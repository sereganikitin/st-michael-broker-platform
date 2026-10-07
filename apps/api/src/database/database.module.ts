import { Global, Logger, Module } from '@nestjs/common';
import { PrismaClient } from '@st-michael/database';

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
    return prisma;
  },
};

@Global()
@Module({
  providers: [prismaProvider],
  exports: ['PrismaClient'],
})
export class DatabaseModule {}
