import { AMO_CONTACT_FIELDS, AMO_PIPELINES, getAmoTokens, setAmoTokens } from '@st-michael/integrations';
import { notHistoricalClientWhere } from '../common/historical-client';
import { SchedulerService } from './scheduler.service';

// Evaluate the emitted Prisma predicates, not an independently rebuilt filter.
// The previous two OR object spreads lost the ownership OR entirely.
function matches(row: Record<string, any>, where: Record<string, any>): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'AND') return value.every((part: any) => matches(row, part));
    if (key === 'OR') return value.some((part: any) => matches(row, part));
    if (key === 'NOT') return !matches(row, value);
    if (value && typeof value === 'object' && 'startsWith' in value) {
      return typeof row[key] === 'string' && row[key].startsWith(value.startsWith);
    }
    return row[key] === value;
  });
}

describe('amo sync effective broker and historical-row isolation', () => {
  const savedToken = process.env.AMO_ACCESS_TOKEN;
  const savedTokens = getAmoTokens();
  beforeEach(() => {
    process.env.AMO_ACCESS_TOKEN = 'synthetic-token';
    setAmoTokens('synthetic-token', 'synthetic-refresh');
  });
  afterEach(() => {
    if (savedToken === undefined) delete process.env.AMO_ACCESS_TOKEN;
    else process.env.AMO_ACCESS_TOKEN = savedToken;
    setAmoTokens(savedTokens.access, savedTokens.refresh);
  });

  function fixture(row: any) {
    const broker = { id: 'current-broker', amoContactId: 123n, phone: '+79990000001', fullName: 'private-broker' };
    const prisma = {
      broker: { findMany: jest.fn().mockResolvedValue([broker]) },
      meeting: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      deal: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      client: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        findFirst: jest.fn().mockImplementation(async ({ where }) => matches(row, where) ? row : null),
        update: jest.fn().mockImplementation(async ({ data }) => ({ ...row, ...data })),
        // Stop before unrelated commission/meeting logic. No external writes.
        create: jest.fn().mockRejectedValue({ code: 'P2002', message: 'private-query' }),
      },
      brokerAgency: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const amo = {
      findBrokerContactByPhone: jest.fn().mockResolvedValue({ id: 123 }),
      getContact: jest.fn().mockImplementation(async (id) => id === 123
        ? { _embedded: { leads: [{ id: 456 }] } }
        : { name: 'private-client', custom_fields_values: [{ field_id: AMO_CONTACT_FIELDS.PHONE, values: [{ value: '+79990000002' }] }] }),
      getLead: jest.fn().mockResolvedValue({
        id: 456, pipeline_id: AMO_PIPELINES.KC, status_id: 142,
        _embedded: { contacts: [{ id: 123 }, { id: 789 }] },
      }),
    };
    const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const service = Object.create(SchedulerService.prototype) as SchedulerService;
    Object.assign(service, { prisma, amo, logger });
    return { service, prisma, logger };
  }
  const candidate = (changes: Record<string, unknown> = {}) => ({
    id: 'candidate', phone: '+79990000002', brokerId: 'other-owner', responsibleBrokerId: 'other-responsible',
    amoLeadId: null, comment: null, ...changes,
  });

  it.each([null, 456n])('never reuses another effective broker\'s same-phone row with amoLeadId=%s', async (amoLeadId) => {
    const { service, prisma, logger } = fixture(candidate({ amoLeadId }));
    await service.handleAmoCrmSync();
    expect(prisma.client.update).not.toHaveBeenCalled();
    expect(prisma.client.create).toHaveBeenCalledTimes(1);
    expect(prisma.client.findFirst.mock.calls[1][0].where).toEqual({
      phone: '+79990000002', amoLeadId: 456n,
      AND: [{ OR: [{ responsibleBrokerId: 'current-broker' }, { responsibleBrokerId: null, brokerId: 'current-broker' }] }, notHistoricalClientWhere],
    });
    expect(JSON.stringify(logger)).not.toContain('private-');
  });

  it.each([
    { brokerId: 'other-owner', responsibleBrokerId: 'current-broker' },
    { brokerId: 'current-broker', responsibleBrokerId: null },
  ])('still reuses a nonhistorical row belonging to the effective broker %s', async (ownership) => {
    const { service, prisma } = fixture(candidate(ownership));
    await service.handleAmoCrmSync();
    expect(prisma.client.update).toHaveBeenCalledTimes(1);
    expect(prisma.client.update).toHaveBeenCalledWith({ where: { id: 'candidate' }, data: { amoLeadId: 456n } });
    expect(prisma.client.create).not.toHaveBeenCalled();
  });

  it.each([
    { responsibleBrokerId: 'current-broker', comment: '[old-cabinet:123]' },
    { brokerId: 'current-broker', responsibleBrokerId: null, comment: '[old-cabinet:123]' },
  ])('continues excluding historical rows even when ownership matches %s', async (changes) => {
    const { service, prisma } = fixture(candidate(changes));
    await service.handleAmoCrmSync();
    expect(prisma.client.update).not.toHaveBeenCalled();
    expect(prisma.client.create).toHaveBeenCalledTimes(1);
  });

  it('does not fall back to owner while a different responsible broker is stored', async () => {
    const { service, prisma } = fixture(candidate({ brokerId: 'current-broker' }));
    await service.handleAmoCrmSync();
    expect(prisma.client.update).not.toHaveBeenCalled();
    expect(prisma.client.create).toHaveBeenCalledTimes(1);
  });

  it('preserves the existing exact brokerId+amoLead lookup priority', async () => {
    const { service, prisma } = fixture(candidate({ brokerId: 'current-broker', amoLeadId: 456n }));
    await service.handleAmoCrmSync();
    expect(prisma.client.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.client.update).not.toHaveBeenCalled();
    expect(prisma.client.create).not.toHaveBeenCalled();
  });
});
