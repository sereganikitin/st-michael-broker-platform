/** Local integration runner. No AppModule, production configuration or external network. */
import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { Test } from "@nestjs/testing";
import { Controller, Get, Req, UseGuards, Logger } from "@nestjs/common";
import { PassportModule } from "@nestjs/passport";
import { ThrottlerModule } from "@nestjs/throttler";
import { sign } from "jsonwebtoken";
import { ClientFixationController } from "../../src/client-fixation/client-fixation.controller";
import { ClientFixationService } from "../../src/client-fixation/client-fixation.service";
import { ClientFixationSafetyService } from "../../src/client-fixation/client-fixation-safety.service";
import { FixationRequestService } from "../../src/client-fixation/fixation-request.service";
import { FixationFailureInterceptor } from "../../src/client-fixation/fixation-failure.interceptor";
import { OpsAlertService } from "../../src/ops-alert/ops-alert.service";
import { WebhooksController } from "../../src/webhooks/webhooks.controller";
import { WebhooksService } from "../../src/webhooks/webhooks.service";
import { JwtStrategy } from "../../src/auth/jwt.strategy";
import { JwtAuthGuard } from "../../src/auth/jwt-auth.guard";
import { AuthService } from "../../src/auth/auth.service";
import { AdminController } from "../../src/admin/admin.controller";
import { AdminService } from "../../src/admin/admin.service";
import { GoogleSheetsSyncService } from "../../src/admin/google-sheets-sync.service";
import { SmsService } from "../../src/sms/sms.service";
import {
  configureLocal,
  fakeCrm,
  services,
  seedBroker,
  until,
  blockedExternal,
} from "./harness";

Logger.overrideLogger(false);
(BigInt.prototype as any).toJSON = function () { return this.toString(); };
@Controller("auth")
@UseGuards(JwtAuthGuard)
class LocalProfileController {
  constructor(private readonly auth: AuthService) {}
  @Get("me") me(@Req() req: any) {
    return this.auth.getProfile(req.user.id);
  }
}

async function main() {
  if (process.argv[2] === "worker") {
    configureLocal(process.env.LOCAL_CRM_ORIGIN!);
    const context = services(process.env.LOCAL_RUN_ID!);
    try {
      await context.outbox.process(process.argv[3]);
    } finally {
      await context.close();
    }
    return;
  }
  const runId = randomUUID();
  const browserOnly = process.argv.includes("--serve");
  const agencyOnly = process.argv.includes("--agency-only");
  const crm = await fakeCrm();
  configureLocal(crm.origin);
  const context = services(runId);
  const { db, outbox, safety, fixation } = context;
  let app: any;
  const results: Array<{
    name: string;
    passed: boolean;
    ms: number;
    error?: string;
  }> = [];
  const test = async (name: string, action: () => Promise<void>) => {
    if (browserOnly || (agencyOnly && !name.startsWith('agency admin:') && !name.startsWith('delegation:'))) return;
    const started = Date.now();
    try {
      await action();
      results.push({ name, passed: true, ms: Date.now() - started });
      console.log(`PASS ${name}`);
    } catch (error: any) {
      results.push({
        name,
        passed: false,
        ms: Date.now() - started,
        error: String(error?.message || error).slice(0, 1500),
      });
      console.error(`FAIL ${name}: ${error.message}`);
      throw error;
    }
  };
  const compose = (...args: string[]) =>
    execFileSync(
      "docker",
      ["compose", "-f", "docker/compose.fixation-test.yml", ...args],
      { cwd: process.cwd(), stdio: "pipe", timeout: 60_000, windowsHide: true },
    );
  const children = new Set<ReturnType<typeof spawn>>();
  const child = (id: string) => {
    const p = spawn(
      process.execPath,
      [
        "-r",
        "ts-node/register/transpile-only",
        resolve(__filename),
        "worker",
        id,
      ],
      {
        cwd: process.cwd(),
        windowsHide: true,
        stdio: "pipe",
        env: {
          ...process.env,
          LOCAL_CRM_ORIGIN: crm.origin,
          LOCAL_RUN_ID: runId,
          TS_NODE_PROJECT: resolve("apps/api/tsconfig.json"),
        },
      },
    );
    children.add(p);
    p.stdout.on("data", () => {});
    p.stderr.on("data", () => {});
    p.on("exit", () => children.delete(p));
    return p;
  };
  const crash = async (p: ReturnType<typeof spawn>) => {
    p.kill();
    await new Promise<void>((resolve) => p.once("exit", () => resolve()));
  };
  let phone = 70001000000 + Math.floor(Math.random() * 100000);
  const payload = () => ({
    phone: `+${phone++}`,
    fullName: "Synthetic local client",
    project: "SILVER_BOR",
    agencyInn: "7700000000",
  });
  try {
    await db.$connect();
    await context.redis.ping();
    const database: any[] =
      await db.$queryRaw`SELECT current_database() AS name`;
    assert.equal(database[0].name, "fixation_local_test");
    // This named database is created solely by compose.fixation-test.yml.
    await db.$executeRawUnsafe(
      'TRUNCATE TABLE "brokers", "agencies", "system_settings", "fixation_requests" CASCADE',
    );
    const broker = await seedBroker(db),
      otherBroker = await seedBroker(db),
      manager = await seedBroker(db, "MANAGER"),
      systemAdmin = await seedBroker(db, "ADMIN");
    const agency = await db.agency.upsert({
      where: { inn: "7700000000" },
      create: { inn: "7700000000", name: "Local test agency" },
      update: {},
    });
    await db.brokerAgency.create({ data: { brokerId: broker.id, agencyId: agency.id, isPrimary: true } });
    const adminService = Object.create(AdminService.prototype) as AdminService;
    (adminService as any).prisma = db;
    const authProfile = Object.create(AuthService.prototype) as AuthService;
    (authProfile as any).prisma = db;
    const module = await Test.createTestingModule({
      imports: [PassportModule, ThrottlerModule.forRoot([{ ttl: 60_000, limit: 1000 }])],
      controllers: [
        ClientFixationController,
        WebhooksController,
        LocalProfileController,
        AdminController,
      ],
      providers: [
        JwtStrategy,
        FixationFailureInterceptor,
        { provide: "PrismaClient", useValue: db },
        { provide: AdminService, useValue: adminService },
        { provide: GoogleSheetsSyncService, useValue: {} },
        { provide: SmsService, useValue: {} },
        {
          provide: AuthService,
          useValue: {
            getProfile: (id: string) => authProfile.getProfile(id),
            validateBroker: (id: string) =>
              db.broker.findUnique({ where: { id } }),
          },
        },
        {
          provide: OpsAlertService,
          useValue: { sendSafely: async () => true },
        },
        { provide: ClientFixationService, useValue: fixation },
        { provide: ClientFixationSafetyService, useValue: safety },
        { provide: FixationRequestService, useValue: outbox },
        { provide: WebhooksService, useValue: context.webhooks },
      ],
    }).compile();
    app = module.createNestApplication({ logger: false });
    if (browserOnly) {
      await adminService.setAgencyAdmin(systemAdmin.id, broker.id, agency.id, true);
      app
        .getHttpAdapter()
        .get("/local-test/drain", async (_req: any, res: any) => {
          await outbox.drain();
          res.json({ ok: true });
        });
      app
        .getHttpAdapter()
        .get("/local-test/close-latest", async (req: any, res: any) => {
          const lead = crm.posts.find((row) => row.phone === req.query.phone);
          if (!lead) return res.status(404).json({ ok: false });
          lead.status_id = 143;
          await context.webhooks.reconcileLeadUniqueness(lead.id);
          res.json({ ok: true });
        });
      app
        .getHttpAdapter()
        .get("/local-test/count", async (_req: any, res: any) => {
          res.json({
            requests: await db.fixationRequest.count(),
            clients: await db.client.count(),
            leadPosts: crm.posts.length,
          });
        });
    }
    await app.listen(0, "127.0.0.1");
    const origin = await app.getUrl();
    const token = (actor = broker) =>
      sign(
        { sub: actor.id, authVersion: 0, type: "access" },
        process.env.JWT_SECRET!,
        { expiresIn: "2h" },
      );
    const api = async (path: string, body?: any, actor = broker, method?: string) => {
      const response = await fetch(`${origin}${path}`, {
        method: method || (body === undefined ? "GET" : "POST"),
        headers: {
          Authorization: `Bearer ${token(actor)}`,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: (await response.json()) as any };
    };

    await test("migration: complete chain, ledger indexes and foreign keys", async () => {
      const applied: any[] =
        await db.$queryRaw`SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL`;
      assert(
        applied.some(
          (r) =>
            r.migration_name === "20261117000100_durable_fixation_requests",
        ),
      );
      const indexes: any[] =
        await db.$queryRaw`SELECT indexname FROM pg_indexes WHERE tablename IN ('fixation_requests', 'fixation_request_keys', 'clients')`;
      assert(
        indexes.some((r) => r.indexname === "clients_fixation_request_id_key"),
      );
      assert(indexes.some((r) => r.indexname === "fixation_request_keys_pkey"));
      const foreignKeys: any[] =
        await db.$queryRaw`SELECT conname FROM pg_constraint WHERE conname IN ('clients_fixation_request_id_fkey', 'fixation_request_keys_request_id_fkey')`;
      assert.equal(foreignKeys.length, 2);
    });

    await test("HTTP: unauthenticated and broker access to staff operations is denied", async () => {
      assert.equal(
        (await fetch(`${origin}/clients/fixation-requests`)).status,
        401,
      );
      assert.equal(
        (await api("/clients/fixation-requests/admin/queue")).status,
        403,
      );
      assert.equal(
        (
          await api(
            "/clients/fixation-requests/admin/queue",
            undefined,
            manager,
          )
        ).status,
        200,
      );
    });

    await test("PostgreSQL: 20 simultaneous submissions produce one request and one CRM lead", async () => {
      const data = payload(),
        key = randomUUID();
      const responses = await Promise.all(
        Array.from({ length: 20 }, () =>
          api("/clients/fix", { ...data, idempotencyKey: key }),
        ),
      );
      assert(
        responses.every((r) => r.status === 201),
        JSON.stringify(responses.filter((r) => r.status !== 201)),
      );
      const id = responses[0].body.requestId;
      assert.equal(new Set(responses.map((r) => r.body.requestId)).size, 1);
      assert.equal(
        (await api(`/clients/fixation-requests/${id}`, undefined, otherBroker))
          .status,
        404,
      );
      const workers = Array.from({ length: 8 }, () => services(runId));
      try {
        await Promise.all(workers.map((w) => w.outbox.process(id)));
      } finally {
        await Promise.all(workers.map((w) => w.close()));
      }
      assert.equal(crm.posts.filter((p) => p.phone === data.phone).length, 1);
      assert.equal(
        await db.client.count({ where: { fixationRequestId: id } }),
        1,
      );
      assert.equal((await outbox.get(broker.id, id)).requestState, "COMPLETED");
      assert.equal(
        (await api("/clients/fix", { ...data, idempotencyKey: key })).body
          .requestId,
        id,
      );
      assert.equal(
        (
          await api("/clients/fix", {
            ...data,
            fullName: "Changed",
            idempotencyKey: key,
          })
        ).status,
        400,
      );
    });

    await test("PostgreSQL: racing tab aliases remain bound after processing and restart", async () => {
      const data = payload();
      const keys = Array.from({ length: 12 }, () => randomUUID());
      const rows = await Promise.all(
        keys.map((key) => outbox.submit(broker.id, data, key)),
      );
      const id = rows[0].requestId;
      assert.equal(new Set(rows.map((r) => r.requestId)).size, 1);
      await outbox.process(id);
      const restarted = services(runId);
      try {
        assert(
          (
            await Promise.all(
              keys.map((key) => restarted.outbox.submit(broker.id, data, key)),
            )
          ).every((r) => r.requestId === id),
        );
      } finally {
        await restarted.close();
      }
      assert.equal(crm.posts.filter((p) => p.phone === data.phone).length, 1);
    });

    await test("CRM outage before creation: persisted retry succeeds after recovery", async () => {
      const data = payload();
      crm.scenarios.set(data.phone, { mode: "temporary" });
      const request = await outbox.submit(broker.id, data, randomUUID());
      await outbox.process(request.requestId);
      assert.equal(
        (await outbox.get(broker.id, request.requestId)).requestState,
        "RETRY",
      );
      assert.equal(crm.posts.filter((p) => p.phone === data.phone).length, 0);
      crm.scenarios.set(data.phone, {});
      await db.fixationRequest.update({
        where: { id: request.requestId },
        data: { nextAttemptAt: new Date(0) },
      });
      await outbox.process(request.requestId);
      assert.equal(
        (await outbox.get(broker.id, request.requestId)).requestState,
        "COMPLETED",
      );
      assert.equal(crm.posts.filter((p) => p.phone === data.phone).length, 1);
    });

    await test("Lost CRM response after POST: durable marker prevents repeat creation", async () => {
      const data = payload();
      crm.scenarios.set(data.phone, { mode: "lose-post" });
      const request = await outbox.submit(broker.id, data, randomUUID());
      await outbox.process(request.requestId);
      assert.equal(
        (await outbox.get(broker.id, request.requestId)).requestState,
        "DELIVERY_PENDING",
      );
      assert.equal(crm.posts.filter((p) => p.phone === data.phone).length, 1);
      const local = await db.client.findUniqueOrThrow({
        where: { fixationRequestId: request.requestId },
      });
      assert(local.amoSyncError?.startsWith("AMO_CREATE_"));
      assert.equal(local.amoLeadId, null);
      await outbox.process(request.requestId);
      await outbox.drain();
      assert.equal(crm.posts.filter((p) => p.phone === data.phone).length, 1);
      assert.equal(
        (
          await api(
            `/clients/fixation-requests/${request.requestId}/retry-check`,
            {},
            manager,
          )
        ).status,
        400,
      );
    });

    await test("Hard process stop during CHECKING: lease expiry safely resumes once", async () => {
      const data = payload();
      crm.scenarios.set(data.phone, { mode: "hold-check" });
      const request = await outbox.submit(broker.id, data, randomUUID());
      const p = child(request.requestId);
      await until(() => !!crm.scenarios.get(data.phone)?.checks);
      await crash(p);
      assert.equal(crm.posts.filter((p) => p.phone === data.phone).length, 0);
      // Local fixture time travel only: expire this test's own two leases.
      await db.fixationRequest.update({
        where: { id: request.requestId },
        data: { leaseUntil: new Date(0) },
      });
      await context.redis.pexpire(context.phoneLock.key(data.phone), 1);
      await context.redis.pexpire(
        `client-fixation:idempotency:${broker.id}:${request.requestId}`,
        1,
      );
      crm.scenarios.set(data.phone, {});
      await new Promise((r) => setTimeout(r, 20));
      await outbox.drain();
      assert.equal(
        (await outbox.get(broker.id, request.requestId)).requestState,
        "COMPLETED",
      );
      assert.equal(crm.posts.filter((p) => p.phone === data.phone).length, 1);
    });

    await test("Hard process stop after CRM acceptance: expired lease never repeats POST", async () => {
      const data = payload();
      crm.scenarios.set(data.phone, { mode: "hold-post" });
      const request = await outbox.submit(broker.id, data, randomUUID());
      const p = child(request.requestId);
      await until(() => crm.posts.some((row) => row.phone === data.phone));
      await crash(p);
      await db.fixationRequest.update({
        where: { id: request.requestId },
        data: { leaseUntil: new Date(0) },
      });
      await outbox.drain();
      await outbox.process(request.requestId);
      assert.equal(
        (await outbox.get(broker.id, request.requestId)).requestState,
        "NEEDS_REVIEW",
      );
      assert.equal(crm.posts.filter((p) => p.phone === data.phone).length, 1);
      // A known fixture receipt stands in for the separately reviewed GET-only link operation.
      const lead = crm.posts.find((p) => p.phone === data.phone)!;
      await db.client.update({
        where: { fixationRequestId: request.requestId },
        data: { amoLeadId: BigInt(lead.id), amoSyncStatus: "SYNCED" },
      });
      await db.fixationRequest.update({
        where: { id: request.requestId },
        data: { nextAttemptAt: new Date(0) },
      });
      await outbox.drain();
      assert.equal(
        (await outbox.get(broker.id, request.requestId)).requestState,
        "COMPLETED",
      );
      assert.equal(crm.posts.filter((p) => p.phone === data.phone).length, 1);
    });

    await test("Real task receipt uniqueness: racing workers and lost task response create one task", async () => {
      const data = payload(),
        oldId = 710001;
      crm.leads.set(oldId, {
        id: oldId,
        pipeline_id: 7600546,
        status_id: 62907338,
        _embedded: { contacts: [{ id: 701 }] },
      });
      crm.scenarios.set(data.phone, { exceptionLead: oldId });
      const request = await outbox.submit(broker.id, data, randomUUID());
      await outbox.process(request.requestId);
      const row = await db.client.findUniqueOrThrow({
        where: { fixationRequestId: request.requestId },
      });
      assert.equal(row.uniquenessStatus, "UNDER_REVIEW");
      assert(row.amoLeadId);
      crm.loseNextTaskResponse();
      await Promise.allSettled([
        context.reviewTasks.ensureForLead(Number(row.amoLeadId)),
        context.reviewTasks.ensureForLead(Number(row.amoLeadId)),
      ]);
      await context.reviewTasks.ensureForLead(Number(row.amoLeadId));
      assert.equal(
        crm.tasks.filter((t) => t.entity_id === Number(row.amoLeadId)).length,
        1,
      );
      assert.equal(
        (
          await db.systemSetting.findUniqueOrThrow({
            where: { key: `AMO_REVIEW_TASK_V1:${row.id}:${row.amoLeadId}` },
          })
        ).value,
        "confirmed",
      );
      assert(crm.tasks.at(-1).text.includes(`/${oldId}`));
      crm.leads.get(Number(row.amoLeadId)).status_id = 143;
      const update = {
        leads: { status: [{ id: String(row.amoLeadId), status_id: "143" }] },
      };
      await api("/webhooks/amo/lead-update", update);
      await api("/webhooks/amo/lead-update", update);
      assert.equal(
        (await outbox.get(broker.id, request.requestId)).status,
        "REJECTED",
      );
      assert.equal(
        crm.tasks.filter((t) => t.entity_id === Number(row.amoLeadId)).length,
        1,
      );
    });

    await test("Lost webhook: persistent sweep and real Bull worker restore the current status", async () => {
      const data = payload();
      const request = await outbox.submit(broker.id, data, randomUUID());
      await outbox.process(request.requestId);
      const row = await db.client.findUniqueOrThrow({
        where: { fixationRequestId: request.requestId },
      });
      crm.leads.get(Number(row.amoLeadId)).status_id = 143;
      await context.recovery.runBatch();
      context.queue.process("reconcile", 1, (job) =>
        context.worker.process(job),
      );
      await until(
        async () =>
          (await db.client.findUniqueOrThrow({ where: { id: row.id } }))
            .uniquenessStatus === "REJECTED",
        30_000,
      );
      assert.equal(
        (await outbox.get(broker.id, request.requestId)).status,
        "REJECTED",
      );
      await context.queue.pause(true);
    });

    await test("Redis stopped: intake survives, processing waits, recovery creates only one lead", async () => {
      const data = payload();
      compose("stop", "redis");
      try {
        const request = await outbox.submit(broker.id, data, randomUUID());
        await outbox.process(request.requestId);
        assert.equal(
          (await outbox.get(broker.id, request.requestId)).requestState,
          "RETRY",
        );
        assert.equal(crm.posts.filter((p) => p.phone === data.phone).length, 0);
        compose("up", "-d", "--wait", "--pull", "never", "redis");
        const recovered = services(runId);
        try {
          await recovered.db.fixationRequest.update({
            where: { id: request.requestId },
            data: { nextAttemptAt: new Date(0) },
          });
          await recovered.outbox.process(request.requestId);
          assert.equal(
            (await recovered.outbox.get(broker.id, request.requestId))
              .requestState,
            "COMPLETED",
          );
          assert.equal(
            crm.posts.filter((p) => p.phone === data.phone).length,
            1,
          );
        } finally {
          await recovered.close();
        }
      } finally {
        compose("up", "-d", "--wait", "--pull", "never", "redis");
      }
    });

    await test("PostgreSQL stopped: no CRM request is issued; retry after restart persists once", async () => {
      const data = payload(),
        key = randomUUID();
      const before = crm.posts.length;
      compose("stop", "postgres");
      try {
        await assert.rejects(
          outbox.submit(broker.id, data, key),
          /Не удалось подтвердить сохранение/,
        );
        assert.equal(crm.posts.length, before);
      } finally {
        compose("up", "-d", "--wait", "--pull", "never", "postgres");
      }
      const recovered = services(runId);
      try {
        const a = await recovered.outbox.submit(broker.id, data, key),
          b = await recovered.outbox.submit(broker.id, data, key);
        assert.equal(a.requestId, b.requestId);
        await recovered.outbox.process(a.requestId);
        assert.equal(crm.posts.filter((p) => p.phone === data.phone).length, 1);
      } finally {
        await recovered.close();
      }
    });

    await test("agency admin: system-only assignment, membership scope, audit and revocation", async () => {
      // The preceding outage test intentionally invalidates this fixture's pool.
      await db.$disconnect();
      await db.$connect();
      const path = `/admin/brokers/${broker.id}/agencies/${agency.id}/admin`;
      assert.equal((await api(path, { isAgencyAdmin: true }, broker, 'PATCH')).status, 403);
      assert.equal((await api(path, { isAgencyAdmin: true }, manager, 'PATCH')).status, 403);
      assert.equal((await api(path, { isAgencyAdmin: 'true' }, systemAdmin, 'PATCH')).status, 400);
      assert.equal((await api(path, { isAgencyAdmin: true }, systemAdmin, 'PATCH')).status, 200);
      const me = (await api('/auth/me')).body;
      assert.equal(me.role, 'BROKER');
      assert.equal(me.agencies[0].isAgencyAdmin, true);
      assert.equal((await api('/clients/fixation-requests/admin/queue')).status, 403);
      const otherAgency = await db.agency.create({ data: { inn: '7800000000', name: 'Other synthetic agency' } });
      assert.equal((await api(`/admin/brokers/${broker.id}/agencies/${otherAgency.id}/admin`, { isAgencyAdmin: true }, systemAdmin, 'PATCH')).status, 404);
      assert.equal(await db.brokerAgency.count({ where: { brokerId: broker.id, agencyId: otherAgency.id } }), 0);
      await Promise.all(Array.from({ length: 4 }, () => api(path, { isAgencyAdmin: true }, systemAdmin, 'PATCH')));
      const membership = await db.brokerAgency.findUniqueOrThrow({ where: { brokerId_agencyId: { brokerId: broker.id, agencyId: agency.id } } });
      assert.equal(await db.auditLog.count({ where: { entityId: membership.id, action: 'AGENCY_ADMIN_GRANTED' } }), 1);
      assert.equal((await api(path, { isAgencyAdmin: false }, systemAdmin, 'PATCH')).status, 200);
      assert.equal((await api('/auth/me')).body.agencies[0].isAgencyAdmin, false);
      assert.equal(await db.auditLog.count({ where: { entityId: membership.id, action: 'AGENCY_ADMIN_REVOKED' } }), 1);
    });

    await test("delegation: immediate two-party visibility, one Client, selected amo broker and live status", async () => {
      const outsider = await seedBroker(db);
      await db.brokerAgency.create({ data: { brokerId: outsider.id, agencyId: agency.id } });
      const data = { ...payload(), responsibleBrokerId: otherBroker.id };
      const accepted = await api('/clients/fix', { ...data, idempotencyKey: randomUUID() });
      const id = accepted.body.requestId;
      assert.equal(accepted.status, 201);
      assert.equal((await api(`/clients/fixation-requests/${id}`, undefined, otherBroker)).status, 200);
      assert.equal((await api(`/clients/fixation-requests/${id}`, undefined, outsider)).status, 404);
      assert((await api('/clients/fixation-requests?submittedForOthers=true')).body.some((row: any) => row.requestId === id));
      assert(!(await api('/clients/fixation-requests?submittedForOthers=true', undefined, otherBroker)).body.some((row: any) => row.requestId === id));
      const resumed = services(runId);
      try { await resumed.outbox.process(id); } finally { await resumed.close(); }
      const row = await db.client.findUniqueOrThrow({ where: { fixationRequestId: id } });
      assert.equal(row.brokerId, broker.id);
      assert.equal(row.responsibleBrokerId, otherBroker.id);
      assert((await fixation.getClients(otherBroker.id, {})).clients.some((client: any) => client.id === row.id));
      assert(!(await fixation.getClients(outsider.id, {})).clients.some((client: any) => client.id === row.id));
      const post = crm.payloads.find((input: any) => input.clientPhone === data.phone);
      assert.equal(post.brokerAmoContactId, Number(otherBroker.amoContactId));
      assert.equal(post.brokerPhone, otherBroker.phone);
      assert.equal(post.filedByPhone, broker.phone);
      assert.equal(crm.posts.filter((lead: any) => lead.phone === data.phone).length, 1);
      await db.client.update({ where: { id: row.id }, data: { uniquenessStatus: 'REJECTED' } });
      assert.equal((await outbox.get(broker.id, id)).status, 'REJECTED');
      assert.equal((await outbox.get(otherBroker.id, id)).status, 'REJECTED');
    });

    assert.equal(
      blockedExternal.length,
      0,
      "Unexpected external request attempt",
    );
    if (process.argv.includes("--serve")) {
      mkdirSync("tmp/fixation-local", { recursive: true });
      writeFileSync(
        "tmp/fixation-local/browser-context.json",
        JSON.stringify({
          origin,
          token: token(),
          brokerId: broker.id,
          managerToken: token(manager),
          adminToken: token(systemAdmin),
          otherBrokerToken: token(otherBroker),
          otherBrokerId: otherBroker.id,
          agencyId: agency.id,
          crmOrigin: crm.origin,
        }),
      );
      console.log(`LOCAL_BROWSER_API_READY ${origin}`);
      // Explicit browser-only harness: no cron is registered. Process requests on demand.
      await new Promise<void>((resolve) => {
        process.once("SIGINT", resolve);
        process.once("SIGTERM", resolve);
      });
    }
  } finally {
    for (const p of children) p.kill();
    mkdirSync("tmp/fixation-local", { recursive: true });
    if (!browserOnly)
      writeFileSync(
        "tmp/fixation-local/results.json",
        JSON.stringify(
          {
            createdAt: new Date().toISOString(),
            runId,
            externalRequests: blockedExternal.length,
            results,
          },
          null,
          2,
        ),
      );
    await app?.close();
    await context.close();
    await crm.close();
    console.log(
      `LOCAL_RESULTS ${results.filter((r) => r.passed).length}/${results.length}`,
    );
  }
}
main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
