import { Logger } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { PrismaClient } from '@st-michael/database';
import { DatabaseModule } from './database.module';

jest.mock('@st-michael/database', () => ({
  Prisma: { ModelName: { Broker: 'Broker', Meeting: 'Meeting', Client: 'Client' } },
  PrismaClient: jest.fn().mockImplementation(() => {
    const client = { $on: jest.fn(), $extends: jest.fn() };
    client.$extends.mockReturnValue(client);
    return client;
  }),
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

  function queryHook() {
    const provider = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, DatabaseModule)
      .find((candidate: any) => candidate.provide === 'PrismaClient');
    const client = provider.useFactory();
    expect(client.$extends).toHaveBeenCalledTimes(1);
    return client.$extends.mock.calls[0][0].query.$allOperations;
  }

  it('preserves successful results and calls the query once with original arguments', async () => {
    const log = jest.spyOn(Logger, 'error').mockImplementation(() => undefined);
    const args = { data: { passwordHash: 'synthetic-private-hash' } };
    const result = { id: 'synthetic-id' };
    const query = jest.fn().mockResolvedValue(result);
    expect(await queryHook()({ model: 'Broker', operation: 'update', args, query })).toBe(result);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(args);
    expect(log).not.toHaveBeenCalled();
  });

  it.each([
    [{ code: 'P2002' }, 'Broker', 'update', 'code=P2002 model=Broker operation=update'],
    [{ code: 'P2003' }, 'Meeting', 'create', 'code=P2003 model=Meeting operation=create'],
    [{ code: 'P2010' }, undefined, '$executeRaw', 'code=P2010 model=RAW operation=$executeRaw'],
    [{ name: 'PrismaClientValidationError' }, 'Client', 'create', 'code=VALIDATION model=Client operation=create'],
    [{ errorCode: 'P1001' }, 'Broker', 'findMany', 'code=P1001 model=Broker operation=findMany'],
    [{ code: 'private-phone', name: 'private-name' }, 'private-model', 'private-operation', 'code=UNKNOWN model=UNKNOWN operation=UNKNOWN'],
  ])('projects technical metadata only and rethrows the exact error', async (metadata, model, operation, expected) => {
    const log = jest.spyOn(Logger, 'error').mockImplementation(() => undefined);
    const failure = {
      ...metadata, message: 'synthetic-password +79990000001',
      stack: 'private-stack', meta: { target: 'private-email', query: 'private-query' },
    };
    const query = jest.fn().mockRejectedValue(failure);
    await expect(queryHook()({ model, operation, args: { private: 'argument' }, query })).rejects.toBe(failure);
    expect(query).toHaveBeenCalledTimes(1);
    expect(log.mock.calls).toEqual([[`[database] request rejected ${expected}`]]);
  });

  it('does not inspect error messages or leak hostile getters', async () => {
    const log = jest.spyOn(Logger, 'error').mockImplementation(() => undefined);
    const failure = Object.defineProperties({}, {
      code: { get: () => { throw new Error('private-code'); } },
      message: { get: () => { throw new Error('must-not-read'); } },
    });
    const query = jest.fn().mockRejectedValue(failure);
    await expect(queryHook()({ model: 'Broker', operation: 'update', args: {}, query })).rejects.toBe(failure);
    expect(log.mock.calls).toEqual([['[database] request rejected code=UNKNOWN model=Broker operation=update']]);
  });

  it('preserves the original query failure even if the logging transport throws', async () => {
    jest.spyOn(Logger, 'error').mockImplementation(() => { throw new Error('private-logger-failure'); });
    const failure = { code: 'P2002', message: 'private-database-failure' };
    const query = jest.fn().mockRejectedValue(failure);
    await expect(queryHook()({ model: 'Broker', operation: 'update', args: {}, query })).rejects.toBe(failure);
    expect(query).toHaveBeenCalledTimes(1);
  });
});
