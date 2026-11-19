import "reflect-metadata";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import Bull from "bull";
import { AmoCrmAdapter, setAmoTokens } from "@st-michael/integrations";
import { ClientFixationService } from "../../src/client-fixation/client-fixation.service";
import { ClientFixationSafetyService } from "../../src/client-fixation/client-fixation-safety.service";
import { AmoFixationPhoneLockService } from "../../src/common/amo-fixation-phone-lock.service";
import { FixationRequestService } from "../../src/client-fixation/fixation-request.service";
import { WebhooksService } from "../../src/webhooks/webhooks.service";
import { AmoReviewTaskService } from "../../src/webhooks/amo-review-task.service";
import {
  AmoUniquenessProcessor,
  AmoUniquenessRecoveryService,
} from "../../src/webhooks/amo-uniqueness-recovery.service";

export const DATABASE_URL =
  "postgresql://fixation_test:local-test-only@127.0.0.1:55441/fixation_local_test?connection_limit=12&pool_timeout=10";
export const redisOptions = {
  host: "127.0.0.1",
  port: 56381,
  db: 0,
  maxRetriesPerRequest: 1,
  retryStrategy: () => null,
};
export const originalFetch = globalThis.fetch.bind(globalThis);
export const blockedExternal: string[] = [];

export function configureLocal(crmOrigin: string) {
  const url = new URL(crmOrigin);
  if (url.hostname !== "127.0.0.1" || url.protocol !== "http:")
    throw Error("LOCAL_CRM_REQUIRED");
  // No dotenv, AppModule, cron bootstrap, external credentials or notifications.
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.JWT_SECRET = "fixation-local-integration-only";
  process.env.AMO_API_DOMAIN = "fixation-test.invalid";
  process.env.AMO_BG_MIN_GAP_MS = "0";
  process.env.AMO_BG_HOLD_AFTER_INTERACTIVE_MS = "0";
  process.env.BROKER_CONTACT_GATE_HMAC_KEY =
    "local-fixation-test-gate-key-32-bytes";
  for (const key of [
    "MOREKIT_WEBHOOK_URL",
    "DADATA_API_KEY",
    "AMO_REFRESH_TOKEN",
    "AMO_CLIENT_SECRET",
    "AMO_CLIENT_ID",
  ])
    delete process.env[key];
  setAmoTokens("local-test-token", "");
  globalThis.fetch = (async (input: any, init?: any) => {
    const target = new URL(
      typeof input === "string" ? input : input.url || String(input),
    );
    if (target.hostname === "fixation-test.invalid")
      return originalFetch(
        `${crmOrigin}${target.pathname}${target.search}`,
        init,
      );
    if (target.hostname === "127.0.0.1" || target.hostname === "localhost")
      return originalFetch(input, init);
    blockedExternal.push(target.hostname);
    throw Error("EXTERNAL_NETWORK_FORBIDDEN_IN_LOCAL_TEST");
  }) as any;
}

export type Scenario = {
  mode?: "temporary" | "hold-check" | "hold-post" | "lose-post";
  exceptionLead?: number;
  checks?: number;
};
export async function fakeCrm() {
  const scenarios = new Map<string, Scenario>();
  const leads = new Map<number, any>();
  const tasks: any[] = [];
  const posts: any[] = [];
  const payloads: any[] = [];
  let loseTaskResponse = false;
  let failLeadReads = false;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const path = new URL(req.url!, "http://127.0.0.1");
    const reply = (status: number, body?: any) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    if (path.pathname === "/api/v4/local-uniqueness") {
      const phone = path.searchParams.get("phone")!;
      const scenario = scenarios.get(phone) || {};
      scenario.checks = (scenario.checks || 0) + 1;
      scenarios.set(phone, scenario);
      if (scenario.mode === "hold-check") return;
      if (scenario.mode === "temporary") return reply(503, {});
      return reply(
        200,
        scenario.exceptionLead
          ? {
              rule: "RULE_EXCEPTION_AFTER_SALES_MEETING",
              verdict: "ALARM",
              reason: "Local sales meeting",
              triggerLeadId: scenario.exceptionLead,
              leads: [leads.get(scenario.exceptionLead)],
            }
          : {
              rule: "NO_CONFLICT",
              verdict: "UNIQUE",
              reason: "Local synthetic evidence",
              leads: [],
            },
      );
    }
    if (path.pathname === "/api/v4/leads" && req.method === "POST") {
      const input = JSON.parse(raw)[0];
      payloads.push(input);
      const id = 900000 + posts.length + 1;
      const row = {
        id,
        name: input.clientName,
        phone: input.clientPhone,
        pipeline_id: 7600542,
        status_id: 62907118,
        responsible_user_id: 765,
        _embedded: { contacts: [{ id: input.brokerAmoContactId }] },
      };
      posts.push(row);
      leads.set(id, row);
      const mode = scenarios.get(input.clientPhone)?.mode;
      if (mode === "hold-post") return;
      if (mode === "lose-post") {
        req.socket.destroy();
        return;
      }
      return reply(200, { _embedded: { leads: [row] } });
    }
    const leadMatch = /^\/api\/v4\/leads\/(\d+)$/.exec(path.pathname);
    if (leadMatch)
      return failLeadReads
        ? reply(503, {})
        : reply(
            leads.has(Number(leadMatch[1])) ? 200 : 404,
            leads.get(Number(leadMatch[1])) || {},
          );
    if (path.pathname === "/api/v4/tasks" && req.method === "GET") {
      const ids = [...path.searchParams]
        .filter(([key]) => key.startsWith("filter[entity_id]"))
        .map(([, val]) => Number(val));
      const selected = tasks.filter(
        (t) => !ids.length || ids.includes(t.entity_id),
      );
      return selected.length
        ? reply(200, { _embedded: { tasks: selected } })
        : reply(204);
    }
    if (path.pathname === "/api/v4/tasks" && req.method === "POST") {
      for (const row of JSON.parse(raw))
        tasks.push({
          ...row,
          id: 800000 + tasks.length,
          created_at: Math.floor(Date.now() / 1000),
          is_completed: false,
        });
      if (loseTaskResponse) {
        loseTaskResponse = false;
        req.socket.destroy();
        return;
      }
      return reply(200, { _embedded: { tasks: tasks.slice(-1) } });
    }
    // Sales retroactive processing may look up contacts; the fixture contains no extra phone identities.
    if (/^\/api\/v4\/contacts\/\d+$/.test(path.pathname))
      return reply(200, {
        id: Number(path.pathname.split("/").pop()),
        custom_fields_values: [],
      });
    return reply(404, { message: `Unhandled local route ${path.pathname}` });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as any).port}`,
    scenarios,
    leads,
    tasks,
    posts,
    payloads,
    loseNextTaskResponse: () => {
      loseTaskResponse = true;
    },
    failLeadReads: (value: boolean) => {
      failLeadReads = value;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export function services(runId: string) {
  const db = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  const redis = new Redis(redisOptions);
  redis.on("error", () => {});
  const queue = new Bull(`local-fixation-${runId}`, {
    redis: { host: "127.0.0.1", port: 56381 },
  });
  queue.on("error", () => {});
  const notificationQueue = new Bull(`local-notifications-${runId}`, {
    redis: { host: "127.0.0.1", port: 56381 },
  });
  notificationQueue.on("error", () => {});
  const phoneLock = new AmoFixationPhoneLockService({ client: redis } as any);
  const safety = new ClientFixationSafetyService(phoneLock);
  const amo = new AmoCrmAdapter();
  // Only CRM evidence/provisioning is simulated; Client writes, markers, CAS,
  // outbox, leases, controller, role checks and webhook processing are real.
  amo.checkUniqueness = (phone: string) =>
    (amo as any).request(
      `/local-uniqueness?phone=${encodeURIComponent(phone)}`,
    );
  amo.createFixationRequest = async (data: any) => {
    const result = await (amo as any).request(
      "/leads",
      { method: "POST", body: JSON.stringify([data]) },
      { retryTransient: false },
    );
    return result._embedded.leads[0];
  };
  amo.syncAgencyCompanyToAmoContact = async () => null;
  const fixation = new ClientFixationService(
    db as any,
    amo,
    notificationQueue,
    { sendSafely: async () => true } as any,
    queue,
  );
  (fixation as any).ensureBrokerAmoContact = (id: string) =>
    db.broker.findUniqueOrThrow({ where: { id } });
  (fixation as any).sleep = async () => {}; // retry ordering is tested, without 2s/5s business delays
  const outbox = new FixationRequestService(db as any, safety, fixation);
  const webhooks = new WebhooksService(db as any, queue);
  const reviewTasks = new AmoReviewTaskService(db as any);
  const worker = new AmoUniquenessProcessor(webhooks, reviewTasks);
  const recovery = new AmoUniquenessRecoveryService(db as any, queue);
  return {
    db,
    redis,
    queue,
    notificationQueue,
    phoneLock,
    safety,
    fixation,
    outbox,
    webhooks,
    reviewTasks,
    worker,
    recovery,
    close: async () => {
      redis.disconnect();
      await Promise.all([
        queue.close(),
        notificationQueue.close(),
        db.$disconnect(),
      ]);
    },
  };
}

export async function seedBroker(
  db: PrismaClient,
  role: "BROKER" | "MANAGER" | "ADMIN" = "BROKER",
) {
  return db.broker.create({
    data: {
      id: randomUUID(),
      fullName: `Synthetic ${role}`,
      phone: `+7${Date.now().toString().slice(-6)}${Math.floor(
        Math.random() * 10000,
      )
        .toString()
        .padStart(4, "0")}`,
      role,
      status: "ACTIVE",
      funnelStage: "FIXATION",
      amoContactId: BigInt(70000000 + Math.floor(Math.random() * 10000000)),
    },
  });
}

export async function until(
  check: () => Promise<boolean> | boolean,
  timeout = 15_000,
) {
  const limit = Date.now() + timeout;
  while (Date.now() < limit) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Error("LOCAL_TEST_CONDITION_TIMED_OUT");
}
