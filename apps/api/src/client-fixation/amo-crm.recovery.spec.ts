import { Project } from "@st-michael/shared";
import { AmoCrmAdapter } from "../../../../packages/integrations/src/amo-crm.adapter";
import { AMO_CONTACT_FIELDS, AMO_PIPELINES } from "../../../../packages/integrations/src/amo-crm.fields";

const PHONE = "+79990000901";
const PARAMS = { clientPhone: PHONE, brokerAmoContactId: 201,
  createdAfterUnix: 880, createdBeforeUnix: 1_900, lookupAttempts: 1 };
const lead = (overrides: Record<string, unknown> = {}) => ({
  id: 301, name: "Synthetic fixation", pipeline_id: AMO_PIPELINES.KC,
  status_id: 143, created_at: 1_000,
  _embedded: { contacts: [{ id: 101 }, { id: 102 }, { id: 201 }] },
  ...overrides,
});

function harness(contacts: any[] = [{ id: 101 }, { id: 102 }]) {
  const adapter = new AmoCrmAdapter();
  const exact = jest.spyOn(adapter, "findContactsByPhoneExact").mockResolvedValue(contacts);
  const leads = jest.spyOn(adapter, "getLeadsByContact").mockResolvedValue([]);
  const strict = jest.spyOn(adapter, "findContactByPhone");
  const createLead = jest.spyOn(adapter, "createLead");
  const createContact = jest.spyOn(adapter, "createContact");
  const updateLead = jest.spyOn(adapter, "updateLead");
  return { adapter, exact, leads, strict, createLead, createContact, updateLead };
}

describe("GET-only ambiguous fixation recovery across exact contacts", () => {
  const originalFetch = global.fetch;
  beforeEach(() => { global.fetch = jest.fn(); });
  afterEach(() => { global.fetch = originalFetch; jest.restoreAllMocks(); });

  it("recovers the unique strong lead on the second exact contact without choosing a contact", async () => {
    const h = harness();
    h.leads.mockResolvedValueOnce([]).mockResolvedValueOnce([lead()] as any);
    await expect(h.adapter.recoverFixationLeadAfterAmbiguousCreate(PARAMS))
      .resolves.toEqual({ kind: "found", leadId: 301 });
    expect(h.exact).toHaveBeenCalledWith(PHONE);
    expect(h.leads.mock.calls).toEqual([[101], [102]]);
    expect(h.strict).not.toHaveBeenCalled();
    expect(h.createLead).not.toHaveBeenCalled();
    expect(h.createContact).not.toHaveBeenCalled();
    expect(h.updateLead).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("counts the same lead attached to both client contacts only once", async () => {
    const h = harness();
    h.leads.mockResolvedValue([lead()] as any);
    await expect(h.adapter.recoverFixationLeadAfterAmbiguousCreate(PARAMS))
      .resolves.toEqual({ kind: "found", leadId: 301 });
    expect(h.leads).toHaveBeenCalledTimes(2);
  });

  it("never picks one of two distinct strong leads", async () => {
    const h = harness();
    h.leads.mockResolvedValueOnce([lead()] as any)
      .mockResolvedValueOnce([lead({ id: 302 })] as any);
    await expect(h.adapter.recoverFixationLeadAfterAmbiguousCreate(PARAMS))
      .resolves.toEqual({ kind: "ambiguous", reason: "multiple_leads" });
  });

  it("does not accept an early match when a later contact read fails or expose private error text", async () => {
    const h = harness();
    h.leads.mockResolvedValueOnce([lead()] as any)
      .mockRejectedValueOnce(new Error("Bearer private-token / +79990000999"));
    const result = await h.adapter.recoverFixationLeadAfterAmbiguousCreate(PARAMS);
    expect(result).toEqual({ kind: "ambiguous", reason: "lookup_failed" });
    expect(JSON.stringify(result)).not.toMatch(/private-token|79990000999/);
  });

  it.each([
    { _embedded: { contacts: [{ id: 101 }, { id: 102 }, { id: 202 }] } },
    { pipeline_id: AMO_PIPELINES.ZORGE9 },
    { created_at: 879 },
    { created_at: 1_901 },
  ])("does not relax broker/pipeline/time filters: %j", async (overrides) => {
    const h = harness();
    h.leads.mockResolvedValue([lead(overrides)] as any);
    await expect(h.adapter.recoverFixationLeadAfterAmbiguousCreate(PARAMS))
      .resolves.toEqual({ kind: "empty" });
    expect(h.leads).toHaveBeenCalledTimes(2);
  });

  it.each([
    { created_at: 1_001 }, { status_id: 142 },
    { _embedded: { contacts: [{ id: 101 }, { id: 102 }, { id: 201 }, { id: 202 }] } },
  ])("rejects contradictory rereads of one lead: %j", async (overrides) => {
    const h = harness();
    h.leads.mockResolvedValueOnce([lead()] as any)
      .mockResolvedValueOnce([lead(overrides)] as any);
    await expect(h.adapter.recoverFixationLeadAfterAmbiguousCreate(PARAMS))
      .resolves.toEqual({ kind: "ambiguous", reason: "conflicting_lead_snapshot" });
  });

  it.each([
    [[{ id: 0 }]], [[{ id: 101 }, { id: 101 }]], [[{ id: 1.5 }]],
  ])("rejects malformed or duplicated exact contact IDs", async (contacts) => {
    const h = harness(contacts);
    await expect(h.adapter.recoverFixationLeadAfterAmbiguousCreate(PARAMS))
      .resolves.toEqual({ kind: "ambiguous", reason: "invalid_contact_id" });
    expect(h.leads).not.toHaveBeenCalled();
  });

  it("rejects client/broker contact identity collision", async () => {
    const h = harness([{ id: 201 }]);
    await expect(h.adapter.recoverFixationLeadAfterAmbiguousCreate(PARAMS))
      .resolves.toEqual({ kind: "ambiguous", reason: "contact_role_collision" });
    expect(h.leads).not.toHaveBeenCalled();
  });

  it("bounds pathological duplicate cohorts as ambiguous, not absent", async () => {
    const h = harness(Array.from({ length: 26 }, (_, i) => ({ id: 1_000 + i })));
    await expect(h.adapter.recoverFixationLeadAfterAmbiguousCreate(PARAMS))
      .resolves.toEqual({ kind: "ambiguous", reason: "exact_contact_bound_exceeded" });
    expect(h.leads).not.toHaveBeenCalled();
  });

  it.each([
    [{ id: 0 }, "invalid_lead_id"],
    [{ status_id: 999_999_999 }, "invalid_lead_snapshot"],
    [{ created_at: undefined }, "invalid_lead_snapshot"],
    [{ _embedded: { contacts: [{ id: 101 }, { id: 201 }, { id: 201 }] } }, "invalid_lead_contacts"],
    [{ _embedded: { contacts: [{ id: 102 }, { id: 201 }] } }, "incomplete_lead_contacts"],
  ])("fails closed on malformed or incomplete lead evidence", async (overrides, reason) => {
    const h = harness([{ id: 101 }]);
    h.leads.mockResolvedValue([lead(overrides as Record<string, unknown>)] as any);
    await expect(h.adapter.recoverFixationLeadAfterAmbiguousCreate(PARAMS))
      .resolves.toEqual({ kind: "ambiguous", reason });
  });

  it("reports empty only after every exact contact has no matching lead", async () => {
    const h = harness();
    await expect(h.adapter.recoverFixationLeadAfterAmbiguousCreate(PARAMS))
      .resolves.toEqual({ kind: "empty" });
    expect(h.leads.mock.calls).toEqual([[101], [102]]);
  });

  it("returns empty for a complete exact contact absence", async () => {
    const h = harness([]);
    await expect(h.adapter.recoverFixationLeadAfterAmbiguousCreate(PARAMS))
      .resolves.toEqual({ kind: "empty" });
    expect(h.leads).not.toHaveBeenCalled();
  });

  it.each([
    ["Зорге 9", Project.ZORGE9, { kind: "found", leadId: 301 }],
    ["Берзарина 37", Project.SILVER_BOR, { kind: "found", leadId: 301 }],
    ["Толбухина", Project.TOLBUKHINA, { kind: "found", leadId: 301 }],
    ["Зорге 9", Project.SILVER_BOR, { kind: "ambiguous", reason: "lead_project_mismatch" }],
    ["", Project.SILVER_BOR, { kind: "ambiguous", reason: "lead_project_unconfirmed" }],
  ])("requires explicit project evidence when a caller supplies expectedProject", async (value, expectedProject, result) => {
    const h = harness([{ id: 101 }]);
    h.leads.mockResolvedValue([lead({ custom_fields_values: [
      { field_id: 839179, field_name: "Объект интереса", values: [{ value }] },
    ] })] as any);
    await expect(h.adapter.recoverFixationLeadAfterAmbiguousCreate({ ...PARAMS, expectedProject }))
      .resolves.toEqual(result);
  });

  it("rejects an unknown expected project before any GET", async () => {
    const h = harness();
    await expect(h.adapter.recoverFixationLeadAfterAmbiguousCreate({ ...PARAMS, expectedProject: Project.UNKNOWN }))
      .resolves.toEqual({ kind: "ambiguous", reason: "invalid_expected_project" });
    expect(h.exact).not.toHaveBeenCalled();
  });

  it("performs the actual paginated exact-contact and complete lead hydration through GET only", async () => {
    const adapter = new AmoCrmAdapter();
    const exactContact = (id: number) => ({ id,
      custom_fields_values: [{ field_id: AMO_CONTACT_FIELDS.PHONE, values: [{ value: PHONE }] }],
    });
    const request = jest.spyOn(adapter as any, "request").mockImplementation(async (path: unknown) => {
      const url = String(path);
      if (url.startsWith("/contacts?")) {
        return url.includes("page=1")
          ? { _embedded: { contacts: [exactContact(101)] }, _links: { next: { href: "synthetic" } } }
          : { _embedded: { contacts: [exactContact(102)] } };
      }
      if (url.startsWith("/contacts/101?")) return { _embedded: { leads: [] } };
      if (url.startsWith("/contacts/102?")) return { _embedded: { leads: [{ id: 301 }] } };
      if (url.startsWith("/leads?filter[id][]=301")) return { _embedded: { leads: [lead()] } };
      throw new Error("unexpected synthetic request");
    });
    await expect(adapter.recoverFixationLeadAfterAmbiguousCreate(PARAMS))
      .resolves.toEqual({ kind: "found", leadId: 301 });
    expect(request).toHaveBeenCalledTimes(5);
    for (const [, init] of request.mock.calls) expect((init as any)?.method || "GET").toBe("GET");
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
