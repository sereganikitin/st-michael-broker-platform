import { UserStatus } from "@st-michael/database";
import { CANONICAL_PUBLIC_WEB_ORIGIN } from "../common/public-web-origin";
import { AuthService } from "./auth.service";

jest.mock("nodemailer", () => ({ createTransport: jest.fn() }));

const nodemailer = require("nodemailer") as { createTransport: jest.Mock };

function createHarness() {
  const prisma = {
    broker: {
      findFirst: jest.fn().mockResolvedValue({
        id: "broker-email-test",
        email: "broker@example.test",
        fullName: "Test Broker",
        role: "BROKER",
        status: UserStatus.ACTIVE,
        passwordHash: "existing-password-hash",
      }),
      update: jest.fn().mockResolvedValue({ id: "broker-email-test" }),
    },
  };
  const service = new AuthService(
    prisma as any,
    { sign: jest.fn(), verify: jest.fn() } as any,
    { add: jest.fn() } as any,
    { syncFromFeed: jest.fn() } as any,
  );
  const sendMail = jest.fn().mockResolvedValue({});
  nodemailer.createTransport.mockReturnValue({ sendMail });
  return { prisma, service, sendMail };
}

describe("AuthService public email links", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.NODE_ENV = "production";
    process.env.SMTP_HOST = "smtp.example.test";
    process.env.SMTP_USER = "sender@example.test";
    process.env.SMTP_PASS = "test-only-password";
    delete process.env.WEB_URL;
    jest.clearAllMocks();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  it.each([
    undefined,
    "https://broker.stmichael.ru",
    "https://broker.stmichael.ru/",
    "https://72.56.241.199",
    "http://broker.stmichael.ru",
    "http://localhost:3000",
    "https://untrusted.example/path?query=1#fragment",
  ])(
    "sends both reset links to canonical HTTPS with WEB_URL=%s",
    async (webUrl) => {
      if (webUrl !== undefined) process.env.WEB_URL = webUrl;
      const { prisma, service, sendMail } = createHarness();
      const requestedAt = Date.now();

      await expect(
        service.forgotPassword("broker@example.test"),
      ).resolves.toEqual({
        message: "Если email зарегистрирован, на него отправлена ссылка",
      });

      expect(prisma.broker.findFirst).toHaveBeenCalledWith({
        where: {
          email: "broker@example.test",
          status: UserStatus.ACTIVE,
          passwordHash: { not: null },
        },
      });
      expect(prisma.broker.update).toHaveBeenCalledTimes(1);
      const update = prisma.broker.update.mock.calls[0][0];
      const token = update.data.passwordResetToken;
      expect(token).toMatch(/^[a-f0-9]{64}$/);
      expect(
        update.data.passwordResetExpiresAt.getTime(),
      ).toBeGreaterThanOrEqual(requestedAt + 60 * 60 * 1000);
      expect(Object.keys(update.data).sort()).toEqual([
        "passwordResetExpiresAt",
        "passwordResetToken",
      ]);
      expect(sendMail).toHaveBeenCalledTimes(1);
      const mail = sendMail.mock.calls[0][0];
      const expectedUrl = `${CANONICAL_PUBLIC_WEB_ORIGIN}/reset-password?token=${token}`;
      expect(mail.to).toBe("broker@example.test");
      expect(mail.subject).toBe("Восстановление пароля — ST Michael");
      const resetLinks = [
        ...mail.html.matchAll(/href="([^"]*\/reset-password[^\"]*)"/g),
      ].map((match: RegExpMatchArray) => match[1]);
      expect(resetLinks).toEqual([expectedUrl, expectedUrl]);
      expect(mail.html).not.toContain("72.56.241.199");
      expect(mail.html).not.toContain("localhost");
      expect(mail.html).not.toContain("untrusted.example");
      expect(mail.html).toContain('href="mailto:broker@stmichael.ru"');
      expect(mail.html).not.toContain("info@zorge9.com");
    },
  );

  it("uses an explicitly configured local development origin without a double slash", async () => {
    process.env.NODE_ENV = "development";
    process.env.WEB_URL = "http://localhost:3000/";
    const { prisma, service, sendMail } = createHarness();

    await service.forgotPassword("broker@example.test");

    const token = prisma.broker.update.mock.calls[0][0].data.passwordResetToken;
    expect(sendMail.mock.calls[0][0].html).toContain(
      `href="http://localhost:3000/reset-password?token=${token}"`,
    );
  });

  it("does not send an email or change an ineligible account", async () => {
    const { prisma, service, sendMail } = createHarness();
    prisma.broker.findFirst.mockResolvedValue(null);

    await service.forgotPassword("unregistered@example.test");

    expect(prisma.broker.update).not.toHaveBeenCalled();
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it.each([undefined, "https://72.56.241.199", "http://localhost:3000"])(
    "also uses canonical HTTPS for welcome links with WEB_URL=%s",
    async (webUrl) => {
      if (webUrl !== undefined) process.env.WEB_URL = webUrl;
      const { prisma, service, sendMail } = createHarness();
      jest.spyOn(console, "log").mockImplementation(() => undefined);

      await (service as any).sendWelcomeEmail(
        "broker@example.test",
        "Test Broker",
      );

      const html = sendMail.mock.calls[0][0].html;
      expect(html).toContain('href="mailto:broker@stmichael.ru"');
      expect(html).not.toContain("info@zorge9.com");
      const loginLinks = [...html.matchAll(/href="([^"]*\/login)"/g)].map(
        (match: RegExpMatchArray) => match[1],
      );
      expect(loginLinks).toEqual([
        `${CANONICAL_PUBLIC_WEB_ORIGIN}/login`,
        `${CANONICAL_PUBLIC_WEB_ORIGIN}/login`,
      ]);
      expect(prisma.broker.update).not.toHaveBeenCalled();
    },
  );
});
