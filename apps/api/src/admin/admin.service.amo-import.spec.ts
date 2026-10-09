import { AMO_CONTACT_FIELDS } from '@st-michael/integrations';
import { AdminService } from './admin.service';

describe('nightly amo broker import identity safety', () => {
  const previousToken = process.env.AMO_ACCESS_TOKEN;
  beforeEach(() => { process.env.AMO_ACCESS_TOKEN = 'synthetic-token'; });
  afterEach(() => {
    if (previousToken === undefined) delete process.env.AMO_ACCESS_TOKEN;
    else process.env.AMO_ACCESS_TOKEN = previousToken;
  });

  const broker = (changes: Record<string, unknown> = {}) => ({
    id: 'broker-a', phone: '+79990000001', fullName: 'Local Name', email: 'local@example.invalid',
    role: 'BROKER', status: 'ACTIVE', mergedIntoId: null, amoContactId: null,
    passwordHash: 'private-hash', authVersion: 7, updatedAt: new Date('2026-10-01T00:00:00Z'), ...changes,
  });
  function fixture(existing: any = broker(), contactOwner: any = null, ids = [123]) {
    const prisma = {
      broker: {
        findUnique: jest.fn().mockImplementation(async ({ where }) =>
          where.phone ? existing : contactOwner),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn().mockResolvedValue({ id: 'new-broker' }),
      },
      agency: { findUnique: jest.fn(), create: jest.fn() },
      brokerAgency: { create: jest.fn() },
    };
    const amo = {
      getLeadsByPipeline: jest.fn().mockResolvedValue(ids.map((id) => ({
        status_id: 1, _embedded: { contacts: [{ id, is_main: true }] },
      }))),
      getContact: jest.fn().mockImplementation(async (id) => ({
        id, name: 'CRM Name', custom_fields_values: [
          { field_id: AMO_CONTACT_FIELDS.IS_BROKER, values: [{ value: true }] },
          { field_id: AMO_CONTACT_FIELDS.PHONE, values: [{ value: '8 (999) 000-00-01' }] },
          { field_id: AMO_CONTACT_FIELDS.EMAIL, values: [{ value: 'crm@example.invalid' }] },
        ],
      })),
      findCompanyByInn: jest.fn(), createCompany: jest.fn(), linkContactToCompany: jest.fn(),
    };
    const service = Object.create(AdminService.prototype) as AdminService;
    Object.assign(service, { prisma, amo });
    return { service, prisma, amo };
  }
  function expectNoWrites(prisma: any, amo: any) {
    for (const fn of [prisma.broker.updateMany, prisma.broker.create, prisma.agency.create,
      prisma.brokerAgency.create, amo.createCompany, amo.linkContactToCompany]) {
      expect(fn).not.toHaveBeenCalled();
    }
  }

  it.each([broker(), null])('refuses an occupied contact rather than triggering repeated unique violations', async (existing) => {
    const { service, prisma, amo } = fixture(existing, { id: 'different-owner' });
    expect(await service.importBrokersFromAmo()).toMatchObject({
      created: 0, updated: 0, skipped: 1, errorCount: 1, errors: ['AMO_IMPORT_CONTACT_OCCUPIED'],
    });
    expectNoWrites(prisma, amo);
  });

  it('never replaces an existing nonmatching contact mapping', async () => {
    const { service, prisma, amo } = fixture(broker({ amoContactId: 456n }));
    expect(await service.importBrokersFromAmo()).toMatchObject({ errors: ['AMO_IMPORT_RELINK_UNSAFE'] });
    expectNoWrites(prisma, amo);
  });

  it.each([{ role: 'ADMIN' }, { role: 'MANAGER' }, { mergedIntoId: 'survivor' }])('does not mutate staff or merged accounts %s', async (changes) => {
    const { service, prisma, amo } = fixture(broker(changes));
    expect(await service.importBrokersFromAmo()).toMatchObject({ errors: ['AMO_IMPORT_ACCOUNT_INELIGIBLE'] });
    expectNoWrites(prisma, amo);
  });

  it.each([null, 123n])('preserves account/password/profile fields and CAS-binds a compatible mapping %s', async (amoContactId) => {
    const existing = broker({ amoContactId });
    const { service, prisma } = fixture(existing, amoContactId ? { id: existing.id } : null);
    expect(await service.importBrokersFromAmo()).toMatchObject({ updated: 1, skipped: 0, errorCount: 0 });
    expect(prisma.broker.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.broker.updateMany).toHaveBeenCalledWith({
      where: {
        id: existing.id, phone: existing.phone, role: 'BROKER', mergedIntoId: null,
        amoContactId, updatedAt: existing.updatedAt,
      }, data: { amoContactId: 123n },
    });
  });

  it('fills only previously empty profile fields without changing account eligibility', async () => {
    const { service, prisma } = fixture(broker({ fullName: '', email: null }));
    await service.importBrokersFromAmo();
    expect(prisma.broker.updateMany.mock.calls[0][0].data).toEqual({
      fullName: 'CRM Name', email: 'crm@example.invalid', amoContactId: 123n,
    });
  });

  it('does not proceed to provider mutations or retry when the account changes concurrently', async () => {
    const { service, prisma, amo } = fixture();
    prisma.broker.updateMany.mockResolvedValue({ count: 0 });
    expect(await service.importBrokersFromAmo()).toMatchObject({ updated: 0, errors: ['AMO_IMPORT_ACCOUNT_CHANGED'] });
    expect(prisma.broker.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.broker.create).not.toHaveBeenCalled();
    expect(amo.createCompany).not.toHaveBeenCalled();
  });

  it('keeps imported new accounts pending and passwordless', async () => {
    const { service, prisma } = fixture(null);
    expect(await service.importBrokersFromAmo()).toMatchObject({ created: 1, errorCount: 0 });
    expect(prisma.broker.create.mock.calls[0][0].data).toEqual({
      phone: '+79990000001', fullName: 'CRM Name', email: 'crm@example.invalid',
      amoContactId: 123n, role: 'BROKER', status: 'PENDING', source: 'CRM_MANUAL',
    });
  });

  it('retains a safe true failure count above the ten-item display cap, without retrying writes or leaking errors', async () => {
    const { service, prisma } = fixture(broker(), null, Array.from({ length: 22 }, (_, i) => 123 + i));
    prisma.broker.updateMany.mockRejectedValue({
      code: 'P2002', message: 'private-phone private-name', meta: { target: 'private-key' },
    });
    const result = await service.importBrokersFromAmo();
    expect(result).toMatchObject({ errorCount: 22, skipped: 22, updated: 0 });
    expect(result.errors).toEqual(Array(10).fill('AMO_IMPORT_BROKER_UPDATE_P2002'));
    expect(prisma.broker.updateMany).toHaveBeenCalledTimes(22);
    expect(JSON.stringify(result)).not.toMatch(/private-/);
  });

  it('rejects an invalid contact id without fetching or writing', async () => {
    const { service, prisma, amo } = fixture(broker(), null, [Infinity]);
    expect(await service.importBrokersFromAmo()).toMatchObject({ errors: ['AMO_IMPORT_INVALID_CONTACT_ID'] });
    expect(amo.getContact).not.toHaveBeenCalled();
    expectNoWrites(prisma, amo);
  });

  it('rejects a mismatched provider contact without local or remote writes', async () => {
    const { service, prisma, amo } = fixture();
    amo.getContact.mockResolvedValue({ id: 456 });
    expect(await service.importBrokersFromAmo()).toMatchObject({ errors: ['AMO_IMPORT_CONTACT_ID_MISMATCH'] });
    expectNoWrites(prisma, amo);
  });
});
