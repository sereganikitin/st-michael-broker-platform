import { getAmoTokens, setAmoTokens } from '@st-michael/integrations';
import { SchedulerService } from './scheduler.service';

describe('amo scheduler failure diagnostics', () => {
  const previousToken = process.env.AMO_ACCESS_TOKEN;
  const previousTokens = getAmoTokens();
  beforeEach(() => {
    process.env.AMO_ACCESS_TOKEN = 'synthetic-access-token';
    setAmoTokens('synthetic-access-token', 'synthetic-refresh-token');
  });
  afterEach(() => {
    if (previousToken === undefined) delete process.env.AMO_ACCESS_TOKEN;
    else process.env.AMO_ACCESS_TOKEN = previousToken;
    setAmoTokens(previousTokens.access, previousTokens.refresh);
  });

  const failure = { code: 'P2003', message: 'private-phone private-password', meta: { query: 'private-query' } };
  function fixture() {
    const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const prisma = {
      $executeRaw: jest.fn().mockResolvedValue(0),
      client: { findMany: jest.fn().mockResolvedValue([{ id: 'private-client', brokerId: 'private-broker', amoLeadId: 123n }]) },
      meeting: {
        findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockRejectedValue(failure), update: jest.fn().mockRejectedValue(failure),
      },
    };
    const amo = {
      getTasksByEntity: jest.fn().mockResolvedValue([{ task_type_id: 2, complete_till: 1790000000, text: 'private-text' }]),
      getLead: jest.fn().mockResolvedValue({ status_id: 142 }),
    };
    const adminService = { importBrokersFromAmo: jest.fn() };
    const service = Object.create(SchedulerService.prototype) as SchedulerService;
    Object.assign(service, { logger, prisma, amo, adminService });
    return { service, prisma, amo, logger, adminService };
  }
  function expectPrivateFieldsAbsent(logger: any) {
    expect(JSON.stringify(logger)).not.toMatch(/private-|synthetic-access-token|synthetic-refresh-token/);
  }

  it('records a meeting task write failure once without raw errors or retry', async () => {
    const { service, prisma, logger } = fixture();
    await service.handleAmoMeetingTasksSync();
    expect(prisma.meeting.create).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('[amo-meeting-tasks] failed code=P2003');
    expect(logger.log).toHaveBeenCalledWith('[amo-meeting-tasks] clients=1 created=0 skipped=0 errors=1');
    expectPrivateFieldsAbsent(logger);
  });

  it('classifies cleanup failures without leaking raw SQL or retrying cleanup', async () => {
    const { service, prisma, logger } = fixture();
    prisma.$executeRaw.mockRejectedValue({ ...failure, code: 'P2010' });
    await service.handleMeetingsStatusSync();
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
    expect(logger.error.mock.calls).toEqual([
      ['[meetings-status-sync] cleanup_meeting_comments failed code=P2010'],
      ['[meetings-status-sync] cleanup_client_comments failed code=P2010'],
    ]);
    expectPrivateFieldsAbsent(logger);
  });

  it('does not repeat a failed meeting status update', async () => {
    const { service, prisma, logger } = fixture();
    prisma.meeting.findMany.mockResolvedValue([{ id: 'private-meeting', status: 'PENDING', client: { amoLeadId: 123n } }] as any);
    await service.handleMeetingsStatusSync();
    expect(prisma.meeting.update).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('[meetings-status-sync] failed code=P2003');
    expectPrivateFieldsAbsent(logger);
  });

  it('records a failed meeting selection without leaking the driver error', async () => {
    const { service, prisma, logger } = fixture();
    prisma.meeting.findMany.mockRejectedValue(failure);
    await service.handleMeetingsStatusSync();
    expect(logger.error).toHaveBeenCalledWith('[meetings-status-sync] fatal code=P2003');
    expectPrivateFieldsAbsent(logger);
  });

  it('reports the actual importer count rather than its ten-item display cap', async () => {
    const { service, adminService, logger } = fixture();
    adminService.importBrokersFromAmo.mockResolvedValue({
      foundLeads: 100, uniqueContacts: 90, created: 0, updated: 68, skipped: 22,
      errorCount: 22, errors: Array(10).fill('AMO_IMPORT_CONTACT_OCCUPIED'),
    });
    await service.handleAmoBrokersSync();
    expect(logger.log).toHaveBeenCalledWith('[amo-brokers] OK: leads=100 contacts=90 created=0 updated=68 skipped=22 errors=22');
    expectPrivateFieldsAbsent(logger);
  });

  it('does not retry or expose a rejected importer exception', async () => {
    const { service, adminService, logger } = fixture();
    adminService.importBrokersFromAmo.mockRejectedValue(failure);
    await service.handleAmoBrokersSync();
    expect(adminService.importBrokersFromAmo).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith('[amo-brokers] FAILED code=P2003');
    expectPrivateFieldsAbsent(logger);
  });
});
