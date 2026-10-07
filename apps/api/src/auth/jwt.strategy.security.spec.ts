import { JwtStrategy } from "./jwt.strategy";

describe("JwtStrategy current account boundary", () => {
  const previousJwtSecret = process.env.JWT_SECRET;

  beforeAll(() => {
    process.env.JWT_SECRET = "test-only-jwt-secret-at-least-32-characters";
  });

  afterAll(() => {
    if (previousJwtSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = previousJwtSecret;
    }
  });

  it("rejects a token owner that is no longer ACTIVE", async () => {
    const authService = { validateBroker: jest.fn().mockResolvedValue(null) };
    const strategy = new JwtStrategy({} as any, authService as any);

    await expect(
      strategy.validate({
        sub: "broker-1",
        role: "ADMIN",
        phone: "+79990000000",
      }),
    ).resolves.toBeNull();
  });

  it("uses the current database role instead of the stale JWT role", async () => {
    const authService = {
      validateBroker: jest.fn().mockResolvedValue({
        id: "broker-1",
        phone: "+79990000000",
        fullName: "Current User",
        role: "BROKER",
        status: "ACTIVE",
      }),
    };
    const strategy = new JwtStrategy({} as any, authService as any);

    await expect(
      strategy.validate({
        sub: "broker-1",
        role: "ADMIN",
        phone: "+79990000000",
      }),
    ).resolves.toMatchObject({ role: "BROKER" });
  });

  it("rejects stale and wrong-type bearer tokens after password change", async () => {
    const authService = { validateBroker: jest.fn().mockResolvedValue({
      id: "broker-1", phone: "+79990000000", fullName: "Broker", role: "BROKER", authVersion: 2,
    }) };
    const strategy = new JwtStrategy({} as any, authService as any);
    for (const payload of [{ sub: "broker-1" }, { sub: "broker-1", type: "access", authVersion: 1 },
      { sub: "broker-1", type: "refresh", authVersion: 2 }, { sub: "broker-1", type: "access", authVersion: "2" }]) {
      await expect(strategy.validate(payload)).resolves.toBeNull();
    }
    await expect(strategy.validate({ sub: "broker-1", type: "access", authVersion: 2 })).resolves.toMatchObject({ id: "broker-1", authVersion: 2 });
  });
});
