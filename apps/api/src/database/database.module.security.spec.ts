import { Logger } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { PrismaClient } from '@st-michael/database';
import { DatabaseModule } from './database.module';

jest.mock('@st-michael/database', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({ $on: jest.fn() })),
}));

describe('Prisma logging privacy', () => {
  const savedNodeEnv = process.env.NODE_ENV;
  const savedPrismaLog = process.env.PRISMA_LOG;
  afterEach(() => {
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnv;
    if (savedPrismaLog === undefined) delete process.env.PRISMA_LOG;
    else process.env.PRISMA_LOG = savedPrismaLog;
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  it.each([
    ['production', 'verbose'], ['production', 'quiet'],
    ['development', 'verbose'], ['development', undefined],
    ['test', 'verbose'], [undefined, 'verbose'], [undefined, undefined],
  ])('uses only sanitized events in NODE_ENV=%s PRISMA_LOG=%s', (environment, logMode) => {
    if (environment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = environment;
    if (logMode === undefined) delete process.env.PRISMA_LOG;
    else process.env.PRISMA_LOG = logMode;

    const errorLog = jest.spyOn(Logger, 'error').mockImplementation(() => undefined);
    const warningLog = jest.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    const stdout = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const rawError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const rawWarning = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const provider = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, DatabaseModule)
      .find((candidate: any) => candidate.provide === 'PrismaClient');
    const client = provider.useFactory();

    expect(PrismaClient).toHaveBeenCalledWith({ log: [
      { emit: 'event', level: 'warn' }, { emit: 'event', level: 'error' },
    ] });
    expect(client.$on.mock.calls.map(([kind]: any[]) => kind)).toEqual(['warn', 'error']);
    const privateEvent = {
      message: 'update failed passwordHash=bcrypt-sha256-v1$SYNTHETIC_HASH',
      params: '["synthetic-password", "+79990000001"]',
      query: 'UPDATE brokers SET password_hash = synthetic_hash',
      target: 'synthetic-private-database',
    };
    for (const [, handler] of client.$on.mock.calls) handler(privateEvent);
    expect(errorLog.mock.calls).toEqual([['[database] request failed']]);
    expect(warningLog.mock.calls).toEqual([['[database] request warning']]);
    const output = JSON.stringify([...errorLog.mock.calls, ...warningLog.mock.calls]);
    for (const value of Object.values(privateEvent)) expect(output).not.toContain(value);
    expect(stdout).not.toHaveBeenCalled();
    expect(rawError).not.toHaveBeenCalled();
    expect(rawWarning).not.toHaveBeenCalled();
  });
});
