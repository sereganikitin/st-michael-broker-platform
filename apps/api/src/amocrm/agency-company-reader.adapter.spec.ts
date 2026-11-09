import { AmoCrmAdapter, getAmoTokens, setAmoTokens } from "../../../../packages/integrations/src/amo-crm.adapter";
import { __resetAmoTrafficLightForTests } from "../../../../packages/integrations/src/amo-traffic-light";

describe("strict company reader", () => {
  const originalFetch = global.fetch;
  let tokens: ReturnType<typeof getAmoTokens>;
  const response = (body: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status });
  beforeEach(() => {
    tokens = getAmoTokens();
    setAmoTokens("test-access", "");
    __resetAmoTrafficLightForTests();
  });
  afterEach(() => { global.fetch = originalFetch; setAmoTokens(tokens.access, tokens.refresh); jest.restoreAllMocks(); });

  it("returns all candidate pages as GET-only evidence", async () => {
    const rows = Array.from({ length: 250 }, (_, index) => ({ id: index + 1 }));
    global.fetch = jest.fn().mockResolvedValueOnce(response({ _embedded: { companies: rows } }))
      .mockResolvedValueOnce(response({ _embedded: { companies: [{ id: 251 }] } }));
    const result = await new AmoCrmAdapter().findCompaniesByInnStrict("9702028892");
    expect(result.items).toHaveLength(251);
    expect(result.pagesRead).toBe(2);
    expect(result.complete).toBe(true);
    for (const [url, init] of (global.fetch as jest.Mock).mock.calls) {
      const parsed = new URL(url);
      expect(parsed.pathname).toBe("/api/v4/companies");
      expect(parsed.searchParams.get("query")).toBe("9702028892");
      expect(parsed.searchParams.get("order[id]")).toBe("asc");
      expect(init.method).toBeUndefined();
    }
  });

  it("treats an explicit 204 as no matching source", async () => {
    global.fetch = jest.fn().mockResolvedValue(response(null, 204));
    expect((await new AmoCrmAdapter().findCompaniesByInnStrict("9702028892")).items).toEqual([]);
  });

  it.each([403, 429])("stops immediately on upstream HTTP %s", async (status) => {
    global.fetch = jest.fn().mockResolvedValue(response({}, status));
    await expect(new AmoCrmAdapter().findCompaniesByInnStrict("9702028892")).rejects.toThrow(`amoCRM ${status}`);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed or incomplete pages instead of reporting no match", async () => {
    global.fetch = jest.fn().mockResolvedValue(response({ _embedded: { companies: [{ id: 2 }, { id: 1 }] } }));
    await expect(new AmoCrmAdapter().findCompaniesByInnStrict("9702028892")).rejects.toThrow("AMO_COMPANY_PAGE_ORDER_INVALID");
    global.fetch = jest.fn().mockResolvedValue(response({ _embedded: { companies: Array.from({ length: 250 }, (_, i) => ({ id: i + 1 })) } }));
    await expect(new AmoCrmAdapter().findCompaniesByInnStrict("9702028892", { maxPages: 1 })).rejects.toThrow("AMO_COMPANY_PAGE_BOUND_EXCEEDED");
  });

  it("does not issue an invalid-INN or expired-deadline request", async () => {
    global.fetch = jest.fn();
    await expect(new AmoCrmAdapter().findCompaniesByInnStrict("name instead of INN")).rejects.toThrow("AMO_COMPANY_INN_INVALID");
    await expect(new AmoCrmAdapter().findCompaniesByInnStrict("9702028892", { deadlineAt: Date.now() - 1 })).rejects.toThrow("AMO_COMPANY_DEADLINE");
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
