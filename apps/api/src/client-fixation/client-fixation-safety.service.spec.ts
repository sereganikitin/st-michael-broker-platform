import {
  ClientFixationSafetyService,
  clientFixationFingerprint,
  clientFixationSemanticFingerprint,
} from "./client-fixation-safety.service";
import { AmoFixationPhoneLockService } from "../common/amo-fixation-phone-lock.service";

class FakeRedis {
  readonly values = new Map<
    string,
    { value: string; expiresAt: number | null }
  >();
  fail = false;
  now = 0;
  renewCalls = 0;
  denyRenewal = false;

  advance(milliseconds: number) {
    this.now += milliseconds;
    for (const key of this.values.keys()) this.purgeExpired(key);
  }

  private purgeExpired(key: string) {
    const entry = this.values.get(key);
    if (entry && entry.expiresAt !== null && entry.expiresAt <= this.now) {
      this.values.delete(key);
    }
  }

  async get(key: string) {
    if (this.fail) throw new Error("Redis unavailable");
    this.purgeExpired(key);
    return this.values.get(key)?.value ?? null;
  }

  async set(key: string, value: string, ...args: unknown[]) {
    if (this.fail) throw new Error("Redis unavailable");
    this.purgeExpired(key);
    const nx = args.includes("NX");
    const xx = args.includes("XX");
    if (nx && this.values.has(key)) return null;
    if (xx && !this.values.has(key)) return null;
    const pxIndex = args.indexOf("PX");
    const ttl = pxIndex === -1 ? null : Number(args[pxIndex + 1]);
    this.values.set(key, {
      value,
      expiresAt: ttl === null ? null : this.now + ttl,
    });
    return "OK";
  }

  async del(key: string) {
    if (this.fail) throw new Error("Redis unavailable");
    this.purgeExpired(key);
    return this.values.delete(key) ? 1 : 0;
  }

  async eval(script: string, _keyCount: number, key: string, ...args: string[]) {
    if (this.fail) throw new Error("Redis unavailable");
    this.purgeExpired(key);
    const current = this.values.get(key);
    if (!current) return 0;

    // 2026-09-11: перехват завершённого замка сверяет всё значение целиком,
    // а не владельца — у завершённой записи владельца нет.
    if (script.includes("client-fixation:take-over-completed")) {
      if (current.value !== args[0]) return 0;
      this.values.set(key, {
        value: args[1],
        expiresAt: this.now + Number(args[2]),
      });
      return 1;
    }

    let parsed: { owner?: string };
    try {
      parsed = JSON.parse(current.value) as { owner?: string };
    } catch {
      return 0;
    }
    if (parsed.owner !== args[0]) return 0;

    if (script.includes("client-fixation:compare-owner-set")) {
      this.values.set(key, {
        value: args[1],
        expiresAt: this.now + Number(args[2]),
      });
      return 1;
    }
    if (script.includes("client-fixation:compare-owner-delete")) {
      return this.values.delete(key) ? 1 : 0;
    }
    if (script.includes("client-fixation:compare-owner-renew")) {
      this.renewCalls += 1;
      if (this.denyRenewal) return 0;
      current.expiresAt = this.now + Number(args[1]);
      return 1;
    }
    throw new Error("Unknown Lua script");
  }
}

function createService() {
  const redis = new FakeRedis();
  const phoneLock = new AmoFixationPhoneLockService({ client: redis } as any);
  const service = new ClientFixationSafetyService(phoneLock);
  return { redis, service, phoneLock };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const payload = {
  phone: "+79990000001",
  fullName: "Тестовый Клиент",
  project: "ZORGE9",
  agencyInn: "7700000000",
  amount: 17_000_000,
};

describe("ClientFixationSafetyService", () => {
  it("builds the same PII-free fingerprint regardless of object key order", () => {
    const left = clientFixationFingerprint(payload);
    const right = clientFixationFingerprint({
      amount: payload.amount,
      agencyInn: payload.agencyInn,
      project: payload.project,
      fullName: payload.fullName,
      phone: payload.phone,
    });

    expect(left).toBe(right);
    expect(left).toMatch(/^[a-f0-9]{64}$/);
    expect(left).not.toContain(payload.phone);
  });

  // 2026-09-11 (аудит обращения владельца): одного клиента законно фиксируют
  // разные брокеры. Раньше пять минут после успешной заявки любая другая на
  // тот же номер падала с «Ключ повторного запроса уже использован».
  it("другая заявка на тот же номер после завершённой — проходит, а не падает", async () => {
    const { redis, service } = createService();

    const first = await service.execute(
      { actorId: "broker-1", payload, idempotencyKey: "11111111-1111-4111-8111-111111111111" },
      async () => ({ clientId: "client-1" }),
    );
    expect(first).toEqual({ clientId: "client-1" });

    const action = jest.fn(async () => ({ clientId: "client-2" }));
    const second = await service.execute(
      {
        actorId: "broker-2",
        payload: { ...payload, fullName: "Другой клиент на тот же номер" },
        idempotencyKey: "22222222-2222-4222-8222-222222222222",
      },
      action,
    );

    expect(action).toHaveBeenCalledTimes(1);
    expect(second).toEqual({ clientId: "client-2" });
    void redis;
  });

  it("пока чужая заявка на этот номер обрабатывается — человеческий отказ", async () => {
    const { service } = createService();
    const gate = deferred<{ clientId: string }>();

    const inFlight = service.execute(
      { actorId: "broker-1", payload },
      () => gate.promise,
    );

    const action = jest.fn(async () => ({ clientId: "client-2" }));
    await expect(
      service.execute(
        { actorId: "broker-2", payload: { ...payload, fullName: "Второй брокер" } },
        action,
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        message: "По этому номеру сейчас обрабатывается другая заявка. Повторите через минуту.",
      }),
      fixationGuardConflict: true,
    });
    expect(action).not.toHaveBeenCalled();

    gate.resolve({ clientId: "client-1" });
    await inFlight;
  });

  it("повтор той же заявки по-прежнему отдаётся из кэша без второго прогона", async () => {
    const { service } = createService();
    const action = jest.fn(async () => ({ clientId: "client-1" }));
    const key = "33333333-3333-4333-8333-333333333333";

    const first = await service.execute({ actorId: "broker-1", payload, idempotencyKey: key }, action);
    const second = await service.execute({ actorId: "broker-1", payload, idempotencyKey: key }, action);

    expect(action).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("тот же ключ с другими данными — понятный текст, без технических слов", async () => {
    const { service } = createService();
    const key = "44444444-4444-4444-8444-444444444444";

    await service.execute({ actorId: "broker-1", payload, idempotencyKey: key }, async () => ({ clientId: "client-1" }));

    await expect(
      service.execute(
        { actorId: "broker-1", payload: { ...payload, amount: 19_000_000 }, idempotencyKey: key },
        async () => ({ clientId: "client-2" }),
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        message: "Эта заявка уже отправлялась с другими данными. Обновите страницу и заполните форму заново.",
      }),
      fixationGuardConflict: true,
    });
  });

  it("uses canonical phone for the global semantic lock", () => {
    const base = clientFixationSemanticFingerprint(payload);
    const changedPresentation = clientFixationSemanticFingerprint({
      ...payload,
      fullName: "Другое написание имени",
      comment: "Изменённый комментарий",
      amount: 18_000_000,
      project: "MOMENTS",
      agencyInn: "7800000000",
      responsibleBrokerId: "a6019ff9-7cc4-45d4-b13e-6678e0bf0f55",
      confirmDuplicate: true,
    });
    const changedPhone = clientFixationSemanticFingerprint({
      ...payload,
      phone: "+79990000002",
    });

    expect(changedPresentation).toBe(base);
    expect(changedPhone).not.toBe(base);
  });

  it("uses one deployed semantic key for equivalent phone formatting", () => {
    const { phoneLock } = createService();
    const canonicalKey = phoneLock.key("+79990000001");

    expect(phoneLock.key("8 (999) 000-00-01")).toBe(canonicalKey);
    expect(phoneLock.key("9990000001")).toBe(canonicalKey);
    expect(phoneLock.key("779990000001")).toBe(canonicalKey);
    expect(canonicalKey).toBe(
      `client-fixation:semantic:${clientFixationFingerprint({ phone: payload.phone })}`,
    );
    expect(canonicalKey).not.toContain(payload.phone);
  });

  it("accepts a valid +77 subscriber prefix without treating it as duplicate country code", () => {
    const { phoneLock } = createService();
    const validDoubleSeven = "+77990000001";
    const key = phoneLock.key(validDoubleSeven);

    expect(key).toBe(
      `client-fixation:semantic:${clientFixationFingerprint({ phone: validDoubleSeven })}`,
    );
    expect(phoneLock.key("777990000001")).toBe(key);
    expect(() => phoneLock.key("789990000001")).toThrow(
      "AMO_FIXATION_PHONE_LOCK_PHONE_INVALID",
    );
  });

  it("allows only one amo lead for two parallel identical legacy requests", async () => {
    const { service } = createService();
    const releaseAmo = deferred<{ id: number }>();
    const enteredAmo = deferred<void>();
    const amoCreateLead = jest.fn(() => {
      enteredAmo.resolve();
      return releaseAmo.promise;
    });
    const request = { actorId: "broker-1", payload };

    const first = service.execute(request, amoCreateLead);
    await enteredAmo.promise;
    const second = service.execute(request, amoCreateLead);

    await expect(second).rejects.toMatchObject({ status: 409 });
    releaseAmo.resolve({ id: 32310587 });
    await expect(first).resolves.toEqual({ id: 32310587 });
    expect(amoCreateLead).toHaveBeenCalledTimes(1);
  });

  it("uses the semantic lock when parallel requests carry different UUIDs", async () => {
    const { service } = createService();
    const releaseAmo = deferred<{ id: number }>();
    const enteredAmo = deferred<void>();
    const amoCreateLead = jest.fn(() => {
      enteredAmo.resolve();
      return releaseAmo.promise;
    });
    const first = service.execute(
      {
        actorId: "broker-1",
        payload,
        idempotencyKey: "b5066154-6973-4730-bc62-d3df0dc85925",
      },
      amoCreateLead,
    );
    await enteredAmo.promise;
    const second = service.execute(
      {
        actorId: "broker-1",
        payload,
        idempotencyKey: "7c5ae5b9-33b7-4420-98d7-a562edda3731",
      },
      amoCreateLead,
    );

    await expect(second).rejects.toMatchObject({ status: 409 });
    releaseAmo.resolve({ id: 32310587 });
    await expect(first).resolves.toEqual({ id: 32310587 });
    expect(amoCreateLead).toHaveBeenCalledTimes(1);
  });

  it("blocks parallel variations of the same business fixation", async () => {
    const { service } = createService();
    const releaseAmo = deferred<{ id: number }>();
    const enteredAmo = deferred<void>();
    const amoCreateLead = jest.fn(() => {
      enteredAmo.resolve();
      return releaseAmo.promise;
    });

    const first = service.execute(
      {
        actorId: "broker-1",
        payload,
        idempotencyKey: "b5066154-6973-4730-bc62-d3df0dc85925",
      },
      amoCreateLead,
    );
    await enteredAmo.promise;
    const second = service.execute(
      {
        actorId: "broker-1",
        payload: {
          ...payload,
          fullName: "Другое написание имени",
          comment: "Изменённый комментарий",
          project: "MOMENTS",
          agencyInn: "7800000000",
          confirmDuplicate: true,
        },
        idempotencyKey: "7c5ae5b9-33b7-4420-98d7-a562edda3731",
      },
      amoCreateLead,
    );

    await expect(second).rejects.toMatchObject({ status: 409 });
    releaseAmo.resolve({ id: 32310587 });
    await expect(first).resolves.toEqual({ id: 32310587 });
    expect(amoCreateLead).toHaveBeenCalledTimes(1);
  });

  it("serializes the same phone globally without replaying another actor result", async () => {
    const { service } = createService();
    const releaseAmo = deferred<{ id: number }>();
    const enteredAmo = deferred<void>();
    const firstAction = jest.fn(() => {
      enteredAmo.resolve();
      return releaseAmo.promise;
    });
    const secondAction = jest.fn().mockResolvedValue({ id: 32310589 });

    const first = service.execute(
      { actorId: "broker-1", payload },
      firstAction,
    );
    await enteredAmo.promise;
    await expect(
      service.execute({ actorId: "broker-2", payload }, secondAction),
    ).rejects.toMatchObject({ status: 409 });

    releaseAmo.resolve({ id: 32310587 });
    await expect(first).resolves.toEqual({ id: 32310587 });
    // 2026-09-11: после завершения первой заявки второй брокер больше не
    // упирается в замок — он идёт в обычные правила уникальности. Чужой
    // результат ему при этом не отдаётся: у него свой прогон и свой ответ.
    await expect(
      service.execute({ actorId: "broker-2", payload }, secondAction),
    ).resolves.toEqual({ id: 32310589 });
    expect(firstAction).toHaveBeenCalledTimes(1);
    expect(secondAction).toHaveBeenCalledTimes(1);
  });

  it("replays a completed response for the same UUID without another amo lead", async () => {
    const { service } = createService();
    const amoCreateLead = jest.fn().mockResolvedValue({
      client: { id: "client-1", amoLeadId: BigInt(32310587) },
      amoSyncStatus: "SYNCED",
    });
    const request = {
      actorId: "broker-1",
      payload,
      idempotencyKey: "b5066154-6973-4730-bc62-d3df0dc85925",
    };

    await expect(service.execute(request, amoCreateLead)).resolves.toEqual({
      client: { id: "client-1", amoLeadId: BigInt(32310587) },
      amoSyncStatus: "SYNCED",
    });
    await expect(service.execute(request, amoCreateLead)).resolves.toEqual({
      client: { id: "client-1", amoLeadId: "32310587" },
      amoSyncStatus: "SYNCED",
    });
    expect(amoCreateLead).toHaveBeenCalledTimes(1);
  });

  it("rejects reusing one UUID for a different fixation payload", async () => {
    const { service } = createService();
    const key = "b5066154-6973-4730-bc62-d3df0dc85925";
    await service.execute(
      { actorId: "broker-1", payload, idempotencyKey: key },
      async () => ({ id: 32310587 }),
    );

    await expect(
      service.execute(
        {
          actorId: "broker-1",
          payload: { ...payload, phone: "+79990000002" },
          idempotencyKey: key,
        },
        async () => ({ id: 32310589 }),
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("keeps an ambiguous failure locked instead of retrying the amo mutation", async () => {
    const { service } = createService();
    const amoCreateLead = jest
      .fn()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce({ id: 32310589 });
    const request = { actorId: "broker-1", payload };

    await expect(service.execute(request, amoCreateLead)).rejects.toThrow(
      "response lost",
    );
    await expect(service.execute(request, amoCreateLead)).rejects.toMatchObject(
      {
        status: 409,
      },
    );
    expect(amoCreateLead).toHaveBeenCalledTimes(1);
  });

  it("does not let an expired owner overwrite or delete replacement semantic and replay leases", async () => {
    const { redis, service } = createService();
    const firstResult = deferred<{ id: number }>();
    const secondResult = deferred<{ id: number }>();
    const firstEntered = deferred<void>();
    const secondEntered = deferred<void>();
    const request = {
      actorId: "broker-1",
      payload,
      idempotencyKey: "b5066154-6973-4730-bc62-d3df0dc85925",
    };
    const semanticFingerprint = clientFixationSemanticFingerprint(payload);
    const semanticKey = `client-fixation:semantic:${semanticFingerprint}`;
    const replayKey =
      "client-fixation:idempotency:broker-1:b5066154-6973-4730-bc62-d3df0dc85925";

    const first = service.execute(request, () => {
      firstEntered.resolve();
      return firstResult.promise;
    });
    await firstEntered.promise;
    const firstOwner = JSON.parse((await redis.get(semanticKey))!).owner;

    redis.advance(10 * 60_000 + 1);
    const second = service.execute(request, () => {
      secondEntered.resolve();
      return secondResult.promise;
    });
    await secondEntered.promise;
    const secondOwner = JSON.parse((await redis.get(semanticKey))!).owner;
    expect(secondOwner).not.toBe(firstOwner);

    await (service as any).releaseOwned(redis, semanticKey, firstOwner);
    await (service as any).releaseOwned(redis, replayKey, firstOwner);
    expect(JSON.parse((await redis.get(semanticKey))!).owner).toBe(secondOwner);
    expect(JSON.parse((await redis.get(replayKey))!).owner).toBe(secondOwner);

    firstResult.resolve({ id: 32310587 });
    await expect(first).rejects.toMatchObject({ status: 409 });
    expect(JSON.parse((await redis.get(semanticKey))!).owner).toBe(secondOwner);
    expect(JSON.parse((await redis.get(replayKey))!).owner).toBe(secondOwner);

    secondResult.resolve({ id: 32310589 });
    await expect(second).resolves.toEqual({ id: 32310589 });
    expect(JSON.parse((await redis.get(semanticKey))!).status).toBe(
      "completed",
    );
    expect(JSON.parse((await redis.get(replayKey))!).status).toBe(
      "completed",
    );
  });

  it("renews both owned leases until the external mutation settles", async () => {
    jest.useFakeTimers();
    try {
      const { redis, service } = createService();
      const releaseAmo = deferred<{ id: number }>();
      const enteredAmo = deferred<void>();
      const operation = service.execute(
        {
          actorId: "broker-1",
          payload,
          idempotencyKey: "b5066154-6973-4730-bc62-d3df0dc85925",
        },
        () => {
          enteredAmo.resolve();
          return releaseAmo.promise;
        },
      );
      await enteredAmo.promise;

      await jest.advanceTimersByTimeAsync(30_000);
      expect(redis.renewCalls).toBe(2);

      releaseAmo.resolve({ id: 32310587 });
      await expect(operation).resolves.toEqual({ id: 32310587 });
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it("fails closed when renewal reports that lease ownership was lost", async () => {
    jest.useFakeTimers();
    try {
      const { redis, service } = createService();
      const releaseAmo = deferred<{ id: number }>();
      const enteredAmo = deferred<void>();
      const operation = service.execute(
        { actorId: "broker-1", payload },
        () => {
          enteredAmo.resolve();
          return releaseAmo.promise;
        },
      );
      await enteredAmo.promise;
      redis.denyRenewal = true;

      await jest.advanceTimersByTimeAsync(30_000);
      releaseAmo.resolve({ id: 32310587 });

      await expect(operation).rejects.toMatchObject({ status: 409 });
    } finally {
      jest.useRealTimers();
    }
  });

  it("proves ownership before POST and cannot overwrite a replacement owner", async () => {
    const { redis, service, phoneLock } = createService();
    const amoCreateLead = jest.fn().mockResolvedValue({ id: 32310587 });
    const replacement = JSON.stringify({
      fingerprint: "replacement-writer",
      status: "processing",
      owner: "owner-b",
    });
    const semanticKey = phoneLock.key(payload.phone);

    await expect(
      service.execute(
        { actorId: "broker-1", payload },
        async ({ assertOwned }) => {
          redis.values.delete(semanticKey);
          await redis.set(semanticKey, replacement, "PX", 600_000, "NX");
          await assertOwned();
          return amoCreateLead();
        },
      ),
    ).rejects.toMatchObject({ status: 409 });

    expect(amoCreateLead).not.toHaveBeenCalled();
    expect(await redis.get(semanticKey)).toBe(replacement);
  });

  it("fails closed before amoCRM when Redis is unavailable", async () => {
    const { redis, service } = createService();
    redis.fail = true;
    const amoCreateLead = jest.fn().mockResolvedValue({ id: 32310587 });

    await expect(
      service.execute({ actorId: "broker-1", payload }, amoCreateLead),
    ).rejects.toMatchObject({ status: 503 });
    expect(amoCreateLead).not.toHaveBeenCalled();
  });

  it("keeps confirmDuplicate distinct in the exact UUID fingerprint", () => {
    expect(clientFixationFingerprint(payload)).not.toBe(
      clientFixationFingerprint({ ...payload, confirmDuplicate: true }),
    );
  });
});
