import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";
import { LoyaltyPermissionService } from "../loyalty-workflow/loyalty-permission.service";
import { LoyaltyBaseController } from "./loyalty-base.controller";
import { LoyaltyBaseService } from "./loyalty-base.service";
import { PartnerSheetService } from "./partner-sheet.service";

const periodFields = [
  "callPeriod",
  "activityPeriod",
  "fixationPeriod",
  "meetingPeriod",
  "dealPeriod",
];

describe("loyalty search HTTP open periods", () => {
  let app: INestApplication;
  const service = new LoyaltyBaseService({} as any);
  // Exercise the real controller, nested DTO validation and period normalization
  // without querying customer records or external integrations.
  const search = jest.fn(async (_base, _entity, body) => ({
    items: [],
    filter: (service as any).normalizeListFilter(body, body.filter),
  }));

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [LoyaltyBaseController],
      providers: [
        { provide: LoyaltyBaseService, useValue: { search } },
        { provide: LoyaltyPermissionService, useValue: { require: jest.fn() } },
        { provide: PartnerSheetService, useValue: {} },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  beforeEach(() => {
    search.mockClear();
    jest.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-08T21:30:00Z"));
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await app.close();
  });

  it.each(["ours/brokers", "ours/agencies", "anna/brokers", "anna/agencies"])(
    "loads %s with only a start date through Moscow today",
    async (route) => {
      const filter = Object.fromEntries(
        periodFields.map((field) => [field, { from: "2026-09-01" }]),
      );
      const { body } = await request(app.getHttpServer())
        .post(`/loyalty-base/${route}/search`)
        .send({ filter })
        .expect(201);
      for (const field of periodFields) {
        expect(body.filter[field]).toEqual({
          fromIso: "2026-09-01",
          toIso: "2026-11-09",
          from: "2026-08-31T21:00:00.000Z",
          to: "2026-11-09T20:59:59.999Z",
        });
      }
    },
  );

  it.each([
    [{ to: "2026-09-10" }, "2015-01-01", "2026-09-10"],
    [{ from: "2026-09-01", to: "2026-09-10" }, "2026-09-01", "2026-09-10"],
  ])(
    "preserves existing period semantics for %j",
    async (period, fromIso, toIso) => {
      const { body } = await request(app.getHttpServer())
        .post("/loyalty-base/ours/brokers/search")
        .send({ filter: { callPeriod: period } })
        .expect(201);
      expect(body.filter.callPeriod).toMatchObject({ fromIso, toIso });
    },
  );

  it.each([{}, { callPeriod: {} }])(
    "loads without a period for %j",
    async (filter) => {
      const { body } = await request(app.getHttpServer())
        .post("/loyalty-base/ours/brokers/search")
        .send({ filter })
        .expect(201);
      expect(body.filter.callPeriod).toBeUndefined();
    },
  );

  it.each([{ from: "09.11.2026" }, { to: "2026-02-30" }, { from: "invalid" }])(
    "rejects malformed dates before search for %j",
    async (period) => {
      await request(app.getHttpServer())
        .post("/loyalty-base/ours/brokers/search")
        .send({ filter: { callPeriod: period } })
        .expect(400);
      expect(search).not.toHaveBeenCalled();
    },
  );

  it.each([{ from: "2026-11-10" }, { from: "2026-09-10", to: "2026-09-01" }])(
    "rejects a start after the effective end for %j",
    async (period) => {
      await request(app.getHttpServer())
        .post("/loyalty-base/ours/brokers/search")
        .send({ filter: { callPeriod: period } })
        .expect(400);
    },
  );
});
