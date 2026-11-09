import {
  AmoCrmAdapter,
  getAmoTokens,
  setAmoTokens,
  setAmoTokenRefreshHook,
} from "../../../../packages/integrations/src/amo-crm.adapter";
import { __resetAmoTrafficLightForTests } from "../../../../packages/integrations/src/amo-traffic-light";

describe("AmoCrmAdapter OAuth refresh deadline", () => {
  const originalFetch = global.fetch;
  const originalClientId = process.env.AMO_CLIENT_ID;
  const originalClientSecret = process.env.AMO_CLIENT_SECRET;
  let originalTokens: ReturnType<typeof getAmoTokens>;

  const response = (status: number, body: unknown) => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  });

  beforeEach(() => {
    jest.useFakeTimers();
    __resetAmoTrafficLightForTests();
    originalTokens = getAmoTokens();
    setAmoTokens("expired-access", "current-refresh");
    process.env.AMO_CLIENT_ID = "test-client";
    process.env.AMO_CLIENT_SECRET = "test-secret";
    setAmoTokenRefreshHook(null);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    jest.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    setAmoTokens(originalTokens.access, originalTokens.refresh);
    setAmoTokenRefreshHook(null);
    if (originalClientId === undefined) delete process.env.AMO_CLIENT_ID;
    else process.env.AMO_CLIENT_ID = originalClientId;
    if (originalClientSecret === undefined)
      delete process.env.AMO_CLIENT_SECRET;
    else process.env.AMO_CLIENT_SECRET = originalClientSecret;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it.each(["headers", "body"])(
    "bounds stalled refresh %s and allows a later refresh to recover",
    async (stalledPhase) => {
      let signal: AbortSignal | undefined;
      let markStarted: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const persist = jest.fn();
      setAmoTokenRefreshHook(persist);
      global.fetch = jest.fn(async (url: string, init: RequestInit) => {
        if (!String(url).endsWith("/oauth2/access_token")) {
          return response(401, {}) as Response;
        }
        signal = init.signal as AbortSignal;
        const stalled = () =>
          new Promise<never>((_resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => reject(new Error("aborted")),
              { once: true },
            );
            markStarted();
          });
        if (stalledPhase === "headers") return stalled();
        return { ...response(200, {}), json: stalled } as unknown as Response;
      }) as any;

      const request = new AmoCrmAdapter().getAccount();
      const failed = expect(request).rejects.toThrow("amoCRM 401 /account");
      await started;
      expect(signal).toBeInstanceOf(AbortSignal);
      await jest.advanceTimersByTimeAsync(14_999);
      expect(signal.aborted).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await failed;
      expect(signal.aborted).toBe(true);
      expect(getAmoTokens()).toEqual({
        access: "expired-access",
        refresh: "current-refresh",
      });
      expect(persist).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);

      // A timed-out shared promise must not remain cached forever.
      global.fetch = jest.fn(async (url: string, init: RequestInit) => {
        if (String(url).endsWith("/oauth2/access_token")) {
          return response(200, {
            access_token: "new-access",
            refresh_token: "rotated-refresh",
          }) as Response;
        }
        return response(
          (init.headers as any).Authorization === "Bearer new-access"
            ? 200
            : 401,
          { id: 1 },
        ) as Response;
      }) as any;
      await expect(new AmoCrmAdapter().getAccount()).resolves.toEqual({
        id: 1,
      });
      expect(getAmoTokens()).toEqual({
        access: "new-access",
        refresh: "rotated-refresh",
      });
      expect(persist).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it("shares one successful refresh across concurrent readers and persists the rotation once", async () => {
    let resolveRefresh: (value: Response) => void;
    let refreshSignal: AbortSignal;
    const refresh = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });
    const persist = jest.fn();
    setAmoTokenRefreshHook(persist);
    const fetch = jest.fn(async (url: string, init: RequestInit) => {
      if (String(url).endsWith("/oauth2/access_token")) {
        refreshSignal = init.signal as AbortSignal;
        return refresh;
      }
      return response(
        (init.headers as any).Authorization === "Bearer new-access" ? 200 : 401,
        { id: 1 },
      ) as Response;
    });
    global.fetch = fetch as any;

    const requests = [
      new AmoCrmAdapter().getAccount(),
      new AmoCrmAdapter().getAccount(),
    ];
    await jest.advanceTimersByTimeAsync(0);
    expect(
      fetch.mock.calls.filter(([url]) => url.endsWith("/oauth2/access_token")),
    ).toHaveLength(1);
    resolveRefresh(
      response(200, {
        access_token: "new-access",
        refresh_token: "rotated-refresh",
      }) as Response,
    );
    await expect(Promise.all(requests)).resolves.toEqual([
      { id: 1 },
      { id: 1 },
    ]);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith({
      access: "new-access",
      refresh: "rotated-refresh",
    });
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(15_000);
    expect(refreshSignal.aborted).toBe(false);
  });

  it("clears the deadline after a rejected refresh without changing credentials", async () => {
    const persist = jest.fn();
    setAmoTokenRefreshHook(persist);
    const fetch = jest.fn(async (url: string) =>
      response(url.endsWith("/oauth2/access_token") ? 400 : 401, {}),
    );
    global.fetch = fetch as any;
    await expect(new AmoCrmAdapter().getAccount()).rejects.toThrow(
      "amoCRM 401 /account",
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(getAmoTokens()).toEqual({
      access: "expired-access",
      refresh: "current-refresh",
    });
    expect(persist).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
});
