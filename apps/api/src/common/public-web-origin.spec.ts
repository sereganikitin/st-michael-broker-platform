import {
  CANONICAL_PUBLIC_WEB_ORIGIN,
  getPublicWebOrigin,
} from "./public-web-origin";

describe("getPublicWebOrigin", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  function configure(webUrl: string | undefined, nodeEnv = "production") {
    process.env.NODE_ENV = nodeEnv;
    if (webUrl === undefined) delete process.env.WEB_URL;
    else process.env.WEB_URL = webUrl;
  }

  it.each([
    undefined,
    "",
    "https://broker.stmichael.ru",
    "https://broker.stmichael.ru/",
    "https://72.56.241.199",
    "http://broker.stmichael.ru",
    "http://localhost:3000",
    "https://broker.stmichael.ru:8443",
    "https://untrusted.example",
    "https://broker.stmichael.ru/path",
    "https://user:password@broker.stmichael.ru",
    "https://broker.stmichael.ru?return=external",
    "https://broker.stmichael.ru#fragment",
    "not-a-url",
  ])("always uses canonical HTTPS in production for %s", (webUrl) => {
    configure(webUrl);
    expect(getPublicWebOrigin()).toBe(CANONICAL_PUBLIC_WEB_ORIGIN);
  });

  it.each([
    ["http://localhost:3000", "http://localhost:3000"],
    ["http://localhost:3000/", "http://localhost:3000"],
    [" http://localhost:3000/ ", "http://localhost:3000"],
    ["http://127.0.0.1:3000/", "http://127.0.0.1:3000"],
    ["http://[::1]:3000/", "http://[::1]:3000"],
    ["https://dev.example/", "https://dev.example"],
    ["https://broker.stmichael.ru/", CANONICAL_PUBLIC_WEB_ORIGIN],
  ])("accepts an explicit development origin %s", (webUrl, expected) => {
    configure(webUrl, "development");
    expect(getPublicWebOrigin()).toBe(expected);
  });

  it("supports an explicit local test origin", () => {
    configure("http://localhost:4000/", "test");
    expect(getPublicWebOrigin()).toBe("http://localhost:4000");
  });

  it.each(["development", "test"])(
    "preserves the local default for missing configuration in %s",
    (nodeEnv) => {
      configure(undefined, nodeEnv);
      expect(getPublicWebOrigin()).toBe("http://localhost:3000");
      configure("", nodeEnv);
      expect(getPublicWebOrigin()).toBe("http://localhost:3000");
      configure("  ", nodeEnv);
      expect(getPublicWebOrigin()).toBe("http://localhost:3000");
    },
  );

  it("keeps the safe canonical default when NODE_ENV is not configured", () => {
    delete process.env.NODE_ENV;
    delete process.env.WEB_URL;
    expect(getPublicWebOrigin()).toBe(CANONICAL_PUBLIC_WEB_ORIGIN);
  });

  it.each([
    "not-a-url",
    "localhost:3000",
    "//localhost:3000",
    "ftp://localhost:3000",
    "javascript:alert(1)",
    "http://user:password@localhost:3000",
    "http://localhost:3000/path",
    "http://localhost:3000/path/..",
    "http://localhost:3000//",
    "http://localhost:3000/?",
    "http://localhost:3000?token=bad",
    "http://localhost:3000/#",
    "http://localhost:3000#fragment",
    "http://local host:3000",
    "http://localhost:3000\\path",
    "http://localhost:3000\n",
  ])("falls back safely for an invalid development origin %s", (webUrl) => {
    configure(webUrl, "development");
    expect(getPublicWebOrigin()).toBe(CANONICAL_PUBLIC_WEB_ORIGIN);
  });
});
