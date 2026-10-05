import { AmoCrmAdapter } from "../../../../packages/integrations/src/amo-crm.adapter";
import { AMO_CONTACT_FIELDS } from "../../../../packages/integrations/src/amo-crm.fields";
import { findLatestFixationBrokerId } from "../common/latest-fixation-broker";
import * as latestBrokerResolver from "../common/latest-fixation-broker";
import { ClientFixationService } from "./client-fixation.service";

describe("latest-created duplicate broker rule", () => {
  const phone = "+79990000321";
  const contact = (
    id: number,
    created: number | undefined,
    broker = true,
    number = phone,
  ) => ({
    id,
    name: "Broker",
    created_at: created,
    updated_at: 999999,
    custom_fields_values: [
      { field_id: AMO_CONTACT_FIELDS.PHONE, values: [{ value: number }] },
      { field_id: AMO_CONTACT_FIELDS.IS_BROKER, values: [{ value: broker }] },
    ],
  });
  function adapterWithPages(pages: any[]) {
    const adapter = new AmoCrmAdapter();
    const request = jest.spyOn(adapter as any, "request");
    pages.forEach((contacts, index) =>
      request.mockResolvedValueOnce({
        _embedded: { contacts },
        _links: index < pages.length - 1 ? { next: {} } : {},
      }),
    );
    return { adapter, request };
  }
  afterEach(() => jest.restoreAllMocks());

  it("scans every page, chooses created_at not updated_at or lead counts", async () => {
    const old = {
      ...contact(70, 100),
      updated_at: 99999999,
      _embedded: { leads: [{ id: 1 }] },
    };
    const latest = contact(60, 200, true, "8 (999) 000-03-21");
    const { adapter, request } = adapterWithPages([[old], [latest]]);
    await expect(
      adapter.findBrokerContactForFixationByPhone(phone),
    ).resolves.toEqual(latest);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][0]).toContain("page=2");
  });
  it("breaks equal creation dates deterministically by larger amo id", async () => {
    const { adapter } = adapterWithPages([
      [contact(31, 200), contact(32, 200)],
    ]);
    await expect(
      adapter.findBrokerContactForFixationByPhone(phone),
    ).resolves.toMatchObject({ id: 32 });
  });
  it("never selects an unflagged client or another country sharing a suffix", async () => {
    const valid = contact(1, 100);
    const { adapter } = adapterWithPages([
      [valid, contact(2, 300, false), contact(3, 400, true, "+19990000321")],
    ]);
    await expect(
      adapter.findBrokerContactForFixationByPhone(phone),
    ).resolves.toEqual(valid);
  });
  it("preserves promotion of one unflagged exact contact", async () => {
    const unflagged = contact(1, undefined, false);
    const { adapter } = adapterWithPages([[unflagged]]);
    await expect(
      adapter.findBrokerContactForFixationByPhone(phone),
    ).resolves.toEqual(unflagged);
  });
  it("does not guess from several unflagged exact contacts", async () => {
    const { adapter } = adapterWithPages([
      [contact(1, 100, false), contact(2, 200, false)],
    ]);
    await expect(
      adapter.findBrokerContactForFixationByPhone(phone),
    ).rejects.toThrow("AMO_FIXATION_BROKER_DUPLICATES_UNFLAGGED");
  });
  it("rejects missing creation dates instead of guessing latest", async () => {
    const { adapter } = adapterWithPages([
      [contact(1, undefined), contact(2, 200)],
    ]);
    await expect(
      adapter.findBrokerContactForFixationByPhone(phone),
    ).rejects.toThrow("AMO_FIXATION_BROKER_CREATED_AT_INVALID");
  });
  it("leaves exact client uniqueness strict", async () => {
    const { adapter } = adapterWithPages([[contact(1, 100), contact(2, 200)]]);
    await expect(
      adapter.findContactByPhone(phone, { strict: true }),
    ).rejects.toThrow("AMBIGUOUS_EXACT_CONTACT");
  });
  it("propagates transport failures and never creates contacts on lookup", async () => {
    const adapter = new AmoCrmAdapter();
    jest
      .spyOn(adapter as any, "request")
      .mockRejectedValue(new Error("transport unavailable"));
    const create = jest.spyOn(adapter, "createContact");
    await expect(
      adapter.findBrokerContactForFixationByPhone(phone),
    ).rejects.toThrow("transport unavailable");
    expect(create).not.toHaveBeenCalled();
  });
  it("uses exact parameterized primary/alias matching and latest local creation order", async () => {
    const prisma: any = {
      $queryRaw: jest.fn().mockResolvedValue([
        { id: "new", role: "BROKER", status: "PENDING" },
        { id: "old", role: "BROKER", status: "ACTIVE" },
      ]),
    };
    await expect(
      findLatestFixationBrokerId(prisma, "8 (999) 000-03-21"),
    ).resolves.toBe("new");
    const [strings, bound] = prisma.$queryRaw.mock.calls[0];
    expect(bound).toBe("79990000321");
    const sql = Array.from(strings).join("");
    expect(sql).toContain('FROM "broker_phones"');
    expect(sql).toContain(
      'ORDER BY target."created_at" DESC, target."id" DESC',
    );
    expect(sql).toContain('target."merged_into_id" IS NOT NULL');
    expect(sql).toContain("THEN 'UNRESOLVED'");
    expect(sql).not.toContain(phone);
  });
  it("skips blocked/staff destinations without creating or merging cards", async () => {
    const prisma: any = {
      $queryRaw: jest.fn().mockResolvedValue([
        { id: "staff", role: "ADMIN", status: "ACTIVE" },
        { id: "blocked", role: "BROKER", status: "BLOCKED" },
        { id: "eligible", role: "BROKER", status: "ACTIVE" },
      ]),
    };
    await expect(findLatestFixationBrokerId(prisma, phone)).resolves.toBe(
      "eligible",
    );
    prisma.$queryRaw.mockResolvedValue([
      { id: "staff", role: "MANAGER", status: "ACTIVE" },
    ]);
    await expect(findLatestFixationBrokerId(prisma, phone)).rejects.toThrow(
      "FIXATION_BROKER_PHONE_IS_STAFF",
    );
  });
  it("fails closed when local candidate scan exceeds its bound", async () => {
    const prisma: any = {
      $queryRaw: jest.fn().mockResolvedValue(
        Array.from({ length: 21 }, (_, i) => ({
          id: `b${i}`,
          role: "BROKER",
          status: "ACTIVE",
        })),
      ),
    };
    await expect(findLatestFixationBrokerId(prisma, phone)).rejects.toThrow(
      "FIXATION_BROKER_PHONE_CANDIDATES_INVALID",
    );
  });
  it("does not treat dangling or multi-hop merged phone ownership as absence", async () => {
    const prisma: any = {
      $queryRaw: jest
        .fn()
        .mockResolvedValue([
          { id: "unresolved-shadow", role: "UNRESOLVED", status: "BLOCKED" },
        ]),
    };
    await expect(findLatestFixationBrokerId(prisma, phone)).rejects.toThrow(
      "FIXATION_BROKER_PHONE_CANDIDATES_INVALID",
    );
  });
  function serviceHarness(
    storedContact: bigint | null = null,
    holderId: string | null = null,
  ) {
    const broker = {
      id: "signed-in",
      phone,
      amoContactId: storedContact,
      brokerAgencies: [],
      fullName: "Broker",
      mergedIntoId: null,
    };
    const prisma: any = {
      broker: {
        findUnique: jest.fn(async (args: any) =>
          args.where.amoContactId
            ? holderId
              ? { id: holderId }
              : null
            : broker,
        ),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      auditLog: { findMany: jest.fn().mockResolvedValue([]) },
      $executeRaw: jest.fn().mockResolvedValue(0),
      $queryRaw: jest.fn().mockResolvedValue([{ id: broker.id }]),
    };
    prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
    const amo: any = {
      findBrokerContactForFixationByPhone: jest
        .fn()
        .mockResolvedValue(contact(32, 200)),
      updateContact: jest.fn(),
      promoteContactToBroker: jest.fn(),
      createContact: jest.fn(),
    };
    const service = new ClientFixationService(prisma, amo, {} as any);
    return { service, prisma, amo };
  }
  it("relinks only this broker's CRM pointer by CAS, keeping authenticated ownership", async () => {
    process.env.BROKER_CONTACT_GATE_HMAC_KEY =
      "test-explicit-broker-contact-gate-key-32-bytes";
    const { service, prisma, amo } = serviceHarness(31n);
    await expect(
      service.provisionBrokerAmoContact("signed-in"),
    ).resolves.toMatchObject({ id: "signed-in", amoContactId: 32n });
    expect(prisma.broker.updateMany).toHaveBeenCalledWith({
      where: { id: "signed-in", amoContactId: 31n, mergedIntoId: null },
      data: { amoContactId: 32n },
    });
    expect(amo.createContact).not.toHaveBeenCalled();
  });
  it.each([null, 31n])(
    "does not steal another cabinet's CRM contact or mutate it (stored %s)",
    async (stored) => {
      process.env.BROKER_CONTACT_GATE_HMAC_KEY =
        "test-explicit-broker-contact-gate-key-32-bytes";
      const { service, prisma, amo } = serviceHarness(stored, "other-cabinet");
      await expect(
        service.provisionBrokerAmoContact("signed-in"),
      ).rejects.toThrow("AMO_FIXATION_BROKER_CONTACT_OWNED_BY_OTHER_ACCOUNT");
      expect(prisma.broker.updateMany).not.toHaveBeenCalled();
      expect(amo.updateContact).not.toHaveBeenCalled();
      expect(amo.promoteContactToBroker).not.toHaveBeenCalled();
      expect(amo.createContact).not.toHaveBeenCalled();
    },
  );
  it("does not use a stale stored contact after a duplicate/date/link policy failure", async () => {
    const { service, prisma, amo } = serviceHarness(31n);
    amo.findBrokerContactForFixationByPhone.mockRejectedValue(
      new Error("AMO_FIXATION_BROKER_CREATED_AT_INVALID"),
    );
    const create = jest.fn();
    prisma.client = { create };
    await expect(
      service.fixClient(
        "signed-in",
        {
          phone: "+79990000322",
          fullName: "Client",
          project: "ZORGE9",
          agencyInn: "",
        } as any,
        jest.fn(),
      ),
    ).rejects.toThrow("Не удалось безопасно выбрать");
    expect(create).not.toHaveBeenCalled();
    expect(amo.createContact).not.toHaveBeenCalled();
  });
  it("never invokes the latest local-account resolver for authenticated self-fixation", async () => {
    const { service, prisma, amo } = serviceHarness(31n);
    const actor = {
      id: "signed-in",
      phone,
      amoContactId: 31n,
      brokerAgencies: [],
    };
    const latest = jest
      .spyOn(latestBrokerResolver, "findLatestFixationBrokerId")
      .mockResolvedValue("other-account");
    const ensure = jest
      .spyOn(service as any, "ensureBrokerAmoContact")
      .mockResolvedValue(actor);
    amo.checkUniqueness = jest
      .fn()
      .mockRejectedValue(new Error("AMO_AUTH_401"));
    prisma.client = { create: jest.fn() };
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      service.fixClient(
        "signed-in",
        {
          phone: "+79990000322",
          fullName: "Client",
          project: "ZORGE9",
          agencyInn: "",
          responsibleBrokerId: "signed-in",
        } as any,
        jest.fn(),
      ),
    ).rejects.toThrow("Полную проверку уникальности");
    expect(latest).not.toHaveBeenCalled();
    expect(ensure).toHaveBeenCalledWith("signed-in");
    expect(prisma.client.create).not.toHaveBeenCalled();
  });
  it("does not fall back to a stale contact or create a lead after relink CAS count zero", async () => {
    process.env.BROKER_CONTACT_GATE_HMAC_KEY =
      "test-explicit-broker-contact-gate-key-32-bytes";
    const { service, prisma, amo } = serviceHarness(31n);
    prisma.broker.updateMany.mockResolvedValue({ count: 0 });
    prisma.client = { create: jest.fn() };
    amo.createFixationRequest = jest.fn();
    await expect(
      service.fixClient(
        "signed-in",
        {
          phone: "+79990000322",
          fullName: "Client",
          project: "ZORGE9",
          agencyInn: "",
        } as any,
        jest.fn(),
      ),
    ).rejects.toThrow("Не удалось безопасно выбрать");
    expect(prisma.client.create).not.toHaveBeenCalled();
    expect(amo.createFixationRequest).not.toHaveBeenCalled();
    expect(amo.createContact).not.toHaveBeenCalled();
  });
  it("routes a selected older duplicate to the newest responsible broker, preserving the signed-in actor", async () => {
    const actor = { id: "actor", phone: "+79990000320", brokerAgencies: [] };
    const old = {
      id: "old",
      role: "BROKER",
      phone,
      status: "ACTIVE",
      brokerAgencies: [],
    };
    const latest = {
      id: "latest",
      role: "BROKER",
      phone,
      status: "ACTIVE",
      brokerAgencies: [],
    };
    const prisma: any = {
      broker: {
        findUnique: jest.fn(
          async (args: any) => (({ actor, old, latest }) as any)[args.where.id],
        ),
      },
      $queryRaw: jest.fn().mockResolvedValue([
        { id: "latest", role: "BROKER", status: "ACTIVE" },
        { id: "old", role: "BROKER", status: "ACTIVE" },
      ]),
    };
    const service = new ClientFixationService(prisma, {} as any, {} as any);
    const ensure = jest
      .spyOn(service as any, "ensureBrokerAmoContact")
      .mockRejectedValue(
        new Error("AMO_FIXATION_BROKER_CONTACT_OWNED_BY_OTHER_ACCOUNT"),
      );
    await expect(
      service.fixClient(
        "actor",
        {
          phone: "+79990000322",
          fullName: "Client",
          project: "ZORGE9",
          agencyInn: "",
          responsibleBrokerId: "old",
        } as any,
        jest.fn(),
      ),
    ).rejects.toThrow("Не удалось безопасно выбрать");
    expect(ensure).toHaveBeenCalledWith("latest");
    expect(prisma.broker.findUnique).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ where: { id: "actor" } }),
    );
  });
});
