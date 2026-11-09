import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AmocrmController } from './amocrm.controller';
import { AmocrmService } from './amocrm.service';
import { AgencyCompanySyncService } from './agency-company-sync.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { SchedulerService } from '../scheduler/scheduler.service';

describe('agency company sync entry points', () => {
  const agencyId = 'f4a98dd0-c5e6-4ed4-bdde-f9708cf6ac3e';
  const run = jest.fn().mockResolvedValue({ status: 'SUCCEEDED' });
  let app: any;
  let role = 'ADMIN';

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [AmocrmController],
      providers: [
        { provide: AmocrmService, useValue: {} },
        { provide: AgencyCompanySyncService, useValue: { run } },
        RolesGuard,
      ],
    }).overrideGuard(JwtAuthGuard).useValue({ canActivate(context: any) {
      context.switchToHttp().getRequest().user = { role };
      return true;
    } }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    await app.init();
  });
  afterAll(async () => app.close());
  beforeEach(() => { run.mockClear(); role = 'ADMIN'; });

  it('accepts only a targeted refresh with a validated mode and UUID', async () => {
    await request(app.getHttpServer()).post('/amocrm/agency-profiles/sync').send({ mode: 'dry-run', agencyId }).expect(201);
    expect(run).toHaveBeenCalledWith({ mode: 'dry-run', agencyIds: [agencyId] });
    for (const body of [{ mode: 'apply' }, { mode: 'apply', agencyId: 'bad' }, { mode: 'other', agencyId }, { mode: 'apply', agencyId, maxAgencies: 9999 }]) {
      await request(app.getHttpServer()).post('/amocrm/agency-profiles/sync').send(body).expect(400);
    }
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('denies operators and brokers without changing their rights', async () => {
    for (role of ['CALL_CENTER', 'BROKER']) {
      await request(app.getHttpServer()).post('/amocrm/agency-profiles/sync').send({ mode: 'apply', agencyId }).expect(403);
    }
    expect(run).not.toHaveBeenCalled();
  });

  it('runs the nightly service and respects its emergency switch', async () => {
    const previous = process.env.AMO_AGENCY_COMPANY_SYNC_ENABLED;
    const scheduler = new SchedulerService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, undefined, undefined, undefined, undefined, { run } as any);
    try {
      delete process.env.AMO_AGENCY_COMPANY_SYNC_ENABLED;
      await scheduler.handleAgencyCompanySync();
      expect(run).toHaveBeenCalledWith({ mode: 'apply' });
      run.mockClear();
      process.env.AMO_AGENCY_COMPANY_SYNC_ENABLED = 'false';
      await scheduler.handleAgencyCompanySync();
      expect(run).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.AMO_AGENCY_COMPANY_SYNC_ENABLED;
      else process.env.AMO_AGENCY_COMPANY_SYNC_ENABLED = previous;
    }
  });
});
