import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';

describe('aged case direct armed-lead follow-up is read-only', () => {
  const sourcePath = resolve(__dirname, '../../../../scripts/inspect-fixed-amo-fixation-case.js');
  const NodeModule = jest.requireActual('module') as any;
  const loaded = new NodeModule(sourcePath, module);
  loaded.filename = sourcePath; loaded.paths = NodeModule._nodeModulePaths(dirname(sourcePath));
  loaded._compile(readFileSync(sourcePath, 'utf8'), sourcePath);
  const inspector = loaded.exports;
  it('direct fixed-lead mode returns before the unused Redis connection; broad mode retains it', () => {
    const source = readFileSync(sourcePath, 'utf8');
    const main = source.slice(source.indexOf('async function main()'));
    const direct = main.indexOf('if (process.env.FIXED_CASE_NARROW_ARMED_ONLY === "true")');
    expect(direct).toBeGreaterThan(0);
    expect(main.slice(direct, main.indexOf('const phoneLockKey', direct))).toContain('return;');
    expect(main.indexOf('await redis.connect()')).toBeGreaterThan(direct);
    expect(main).toContain('collectReadOnlyRedisLease(redis, row, phoneLockKey)');
  });
  it('failure diagnostics never expose raw errors or metadata', () => {
    const error = Object.assign(new TypeError('private-note token secret'), { code: 'P2022', meta: { column: 'private-column' } });
    const result = inspector.safeInspectionFailure(error);
    expect(result.type).toBe('TypeError');
    expect(result.databaseCode).toBe('P2022');
    expect(JSON.stringify(result)).not.toMatch(/private|token|secret|column/);
    expect(inspector.safeInspectionFailure({ name: 'private-name', code: 'private-code' }).type).toBe('UnclassifiedError');
    expect(inspector.safeInspectionFailure({ code: 'private-code' }).databaseCode).toBeNull();
  });
  const armedAt = '2026-10-12T13:02:39.000Z', armed = Date.parse(armedAt) / 1000;
  const agency = { id: 'private-agency', name: 'private-agency-name', inn: '1234567890', updatedAt: new Date(armedAt) };
  const row = () => ({ id: inspector.CLIENT_ID, brokerId: inspector.EXPECTED_BROKER_ID, responsibleBrokerId: null, responsibleBroker: null,
    broker: { id: inspector.EXPECTED_BROKER_ID, fullName: 'private-broker', phone: '+79998887766', amoContactId: 900001n,
      role: 'BROKER', status: 'PENDING', mergedIntoId: null, brokerAgencies: [{ agencyId: agency.id, isPrimary: true }] },
    fullName: 'private-name', phone: '+79991234567', email: null, comment: null, clientRegion: null,
    project: 'ZORGE9', fixationAgencyId: agency.id, createdAt: new Date('2026-10-08T14:18:19.203Z'), updatedAt: new Date(armedAt),
    amoLeadId: null, amoCreatedAt: null, amoUpdatedAt: null, amoSyncStatus: 'FAILED', amoSyncAttempts: 10,
    amoSyncLastAttemptAt: new Date('2026-10-08T14:18:19.466Z'), amoSyncError: 'AMO_CREATE_RECONCILIATION_REQUIRED:fixture',
    status: 'NEW', fixationStatus: 'NOT_FIXED', fixationExpiresAt: null, uniquenessStatus: 'CONDITIONALLY_UNIQUE', uniquenessExpiresAt: null });
  const audit = () => ['CLAIMED', 'CONTACT_ARMED', 'CONTACT_RESOLVED', 'LEAD_ARMED', 'UNRESOLVED'].map((phase, index) => ({
    id: `audit${index}`, entity: 'AmoFixedCaseRecovery', entityId: inspector.CLIENT_ID,
    action: `AMO_FIXED_CASE_${phase}`, createdAt: new Date(armedAt), payload: {
      ...inspector.ARMED_RECOVERY_METADATA, phase, contactId: 800001, armedAt, reason: 'LEAD_UNCONFIRMED',
      operationKey: `fixed-amo-fixation-case:v1:${inspector.CLIENT_ID}`,
    },
  }));
  const environment = { FIXED_CASE_INSPECTOR_SHA256: 'a'.repeat(64), FIXED_CASE_DEPENDENCY_SHA256: 'b'.repeat(64),
    FIXED_CASE_DEPLOYED_GIT_SHA: 'c'.repeat(40), PRODUCTION_PG_SYSTEM_IDENTIFIER: '1234567', PRODUCTION_MIN_BROKER_ROWS: '10' };
  const response = (payload: any) => {
    let done = false;
    return { status: 200, ok: true, headers: { get: () => null }, body: { getReader: () => ({
      read: async () => done ? { done: true } : (done = true, { done: false, value: Buffer.from(JSON.stringify(payload)) }),
      cancel: async () => {}, releaseLock: () => {},
    }) } };
  };
  const project = (value: any, select: any): any => value === null ? null : Object.fromEntries(Object.entries(select).map(([key, field]: any) => [key,
    field === true ? value[key] ?? null : Array.isArray(value[key]) ? value[key].map((item: any) => project(item, field.select)) : project(value[key] ?? null, field.select)]));
  function fixture(changes: any = {}) {
    const current = row(), entries = audit();
    const lead = { id: 32377125, name: inspector.expectedGeneratedName(current), created_at: armed, updated_at: armed + 500,
      pipeline_id: 7600542, status_id: 62907350, _embedded: { contacts: [{ id: 800001 }, { id: 900001 }] },
      custom_fields_values: [{ field_id: 665195, values: [{ enum_id: 985337 }] }, { field_id: 839179, values: [{ value: 'Зорге 9' }] },
        { field_id: 833189, values: [{ value: Math.floor((armed + 10800) / 86400) * 86400 - 10800 }] },
        { field_id: 583155, values: [{ value: 'Себе' }] }, { field_id: 842273, values: [{ enum_id: 1028041 }] }], ...changes };
    const client = { id: 800001, name: current.fullName, custom_fields_values: [{ field_id: 557903, values: [{ value: current.phone }] }],
      _embedded: { leads: [{ id: 32377125 }] } };
    const broker = { id: 900001, name: 'private-broker', custom_fields_values: [
      { field_id: 557903, values: [{ value: current.broker.phone }] }, { field_id: 835415, values: [{ value: true }] }], _embedded: { leads: [{ id: 32377125 }] } };
    const notes = { _embedded: { notes: [{ id: 1, entity_id: 32377125, note_type: 'common',
      params: { text: inspector.armedRecoveryExpectedNote(current, agency) } }] } };
    const tx = {
      $queryRaw: jest.fn(async (strings: TemplateStringsArray) => strings.join('').includes('pg_control_system')
        ? [{ read_only: 'on', database_name: 'broker_platform', system_identifier: '1234567', broker_rows: '100' }] : [{ mode: 'on' }]),
      client: { findUnique: jest.fn(async (query: any) => project(current, query.select)), findMany: jest.fn(async () => []) },
      broker: { findMany: jest.fn(async () => []) }, agency: { findUnique: jest.fn(async () => agency) },
      auditLog: { findMany: jest.fn(async (query: any) => query.where.entity === 'AmoFixedCaseRecovery' ? entries : []) },
      systemSetting: { findUnique: jest.fn(async () => ({ value: 'private-token' })) },
    };
    const fetchImpl = jest.fn(async (url: URL, options: any) => {
      expect(options.method).toBe('GET'); expect(options.redirect).toBe('error');
      const pathname = new URL(url).pathname;
      if (pathname === '/api/v4/account') return response({ id: 28552900 });
      if (pathname === '/api/v4/leads/32377125') return response(lead);
      if (pathname === '/api/v4/contacts/800001') return response(client);
      if (pathname === '/api/v4/contacts/900001') return response(broker);
      if (pathname === '/api/v4/leads/32377125/notes') return response(notes);
      if (pathname === '/api/v4/leads/custom_fields/833189') return response({ id: 833189, entity_type: 'leads', type: 'date' });
      throw new Error('unapproved endpoint');
    });
    return { current, entries, lead, client, broker, notes, tx, fetchImpl,
      history: (table: string) => inspector.runHistoricalAgency({ prisma: { $transaction: async (fn: any) => fn(tx) }, table,
        environment: { ...environment, FIXED_CASE_HISTORICAL_BACKUP_SHA256: 'db170493aa746ad7ff8aa802edc99dd27aa255d41cd1cf48baaeac12eb527015' }, fetchImpl,
        now: () => new Date('2026-10-19T18:00:00Z') }),
      run: () => inspector.runArmedOnly({ prisma: { $transaction: async (fn: any) => fn(tx) }, environment, fetchImpl,
        now: () => new Date('2026-10-19T18:00:00Z') }) };
  }
  beforeEach(() => { let tick = Date.parse('2026-10-19T18:00:00Z'); jest.spyOn(Date, 'now').mockImplementation(() => tick += 1000); });
  afterEach(() => jest.restoreAllMocks());
  it('reads the existing lead after 7 days while preserving changed status and all write prohibitions', async () => {
    const f = fixture(), report = await f.run();
    expect(report).toMatchObject({ scope: 'literal_armed_lead_followup_only', leadId: 32377125, stableReadback: true,
      linkAuthorized: false, databaseMutationAuthorized: false, amoMutationAuthorized: false, retryAuthorized: false,
      proof: { currentStatusId: 62907350, originalStatusMatches: false, createdWithinOriginalArmedWindow: true,
        requestDateOnlyMoscowDayMatchesArmed: true, fullNoteExactMatch: true, leadUnoccupiedByOtherClient: true } });
    expect(JSON.stringify(report)).not.toMatch(/private|7999|800001|900001|1234567890|Recovery UUID/);
    expect(f.fetchImpl).toHaveBeenCalledTimes(11);
  });
  it('never relaxes creation freshness to the later inspection date', async () => {
    const report = await fixture({ created_at: Date.parse('2026-10-19T17:00:00Z') / 1000 }).run();
    expect(report.proof.createdWithinOriginalArmedWindow).toBe(false);
    expect(report.linkAuthorized).toBe(false);
  });
  it('does not accept a heading-only or agency-tag-only mismatch as an exact full note', async () => {
    const f = fixture(); f.notes._embedded.notes[0].params.text = f.notes._embedded.notes[0].params.text.replace(/^📝 /, '');
    expect((await f.run()).proof.fullNoteExactMatch).toBe(false);
  });
  it('refuses provenance changes before CRM requests', async () => {
    const f = fixture(); f.entries[0].payload.caseHash = '0'.repeat(64);
    await expect(f.run()).rejects.toMatchObject({ safeCode: 'RECOVERY_AUDIT_INVALID' }); expect(f.fetchImpl).not.toHaveBeenCalled();
  });
  it('refuses a provider readback change instead of issuing any write', async () => {
    const f = fixture(); let reads = 0;
    f.tx.client.findUnique.mockImplementation(async (query: any) => { reads++; return project({ ...f.current, updatedAt: new Date(Date.parse(armedAt) + (reads > 2 ? 1 : 0)) }, query.select); });
    await expect(f.run()).rejects.toMatchObject({ safeCode: 'CASE_CHANGED_DURING_SCAN' });
  });
  it('compares an authenticated historical agency without claiming an arbitrary fixture matches the real armed plan', async () => {
    const f = fixture();
    const table = 'COPY public.agencies (id, name, inn, updated_at) FROM stdin;\nprivate-agency\tprivate-agency-name\t1234567890\t2026-10-12 13:02:39\n\\.\n';
    const report = await f.history(table);
    expect(report).toMatchObject({ scope: 'fixed_case_archived_agency_provenance_only', backupAuthenticated: true,
      stableReadback: true, linkAuthorized: false, databaseMutationAuthorized: false,
      proof: { originalCaseHashMatchesArmedPlan: false, historicalAgencyTagExactMatch: true,
        fullHistoricalNoteExactMatch: true, headingVariantAuthorizesLink: false } });
    expect(JSON.stringify(report)).not.toMatch(/private|7999|1234567890|Recovery agency/);
    expect(f.fetchImpl).toHaveBeenCalledTimes(3);
  });
});
