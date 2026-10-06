jest.mock("web-push", () => ({
  setVapidDetails: jest.fn(),
  sendNotification: jest.fn(),
}));
jest.mock("@sendgrid/mail", () => ({
  setApiKey: jest.fn(),
  send: jest.fn().mockResolvedValue({}),
}));

describe("push contact subject, independent from SMTP identity", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
  });
  it.each([undefined, "mailto:configured@example.test"])(
    "uses a new default but preserves explicit VAPID_SUBJECT=%s",
    async (subject) => {
      jest.resetModules();
      process.env.VAPID_PUBLIC_KEY = "test-only-public-key";
      process.env.VAPID_PRIVATE_KEY = "test-only-private-key";
      if (subject) process.env.VAPID_SUBJECT = subject;
      else delete process.env.VAPID_SUBJECT;
      const webpush = require("web-push");
      const { NotificationProcessor } = require("./notification.processor");
      const prisma = {
        pushSubscription: { findMany: jest.fn().mockResolvedValue([]) },
      };
      await (new NotificationProcessor(prisma as any) as any).sendPush(
        "test-broker",
        "Test",
        "Test",
      );
      expect(webpush.setVapidDetails).toHaveBeenCalledWith(
        subject || "mailto:broker@stmichael.ru",
        "test-only-public-key",
        "test-only-private-key",
      );
      expect(webpush.sendNotification).not.toHaveBeenCalled();
    },
  );
});

describe("explicit verified SendGrid identity", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
  });
  function harness(from?: string) {
    jest.resetModules();
    process.env.SENDGRID_API_KEY = "test-only-sendgrid-key";
    process.env.SMTP_USER = "smtp-user@example.test";
    process.env.SMTP_FROM = "smtp-from@example.test";
    if (from === undefined) delete process.env.SENDGRID_FROM;
    else process.env.SENDGRID_FROM = from;
    const sgMail = require("@sendgrid/mail");
    const { NotificationProcessor } = require("./notification.processor");
    const prisma = {
      notification: {
        create: jest.fn().mockResolvedValue({ id: "notification-test" }),
        update: jest.fn().mockResolvedValue({}),
      },
      broker: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ email: "recipient@example.test" }),
      },
    };
    const processor = new NotificationProcessor(prisma as any);
    const job = {
      data: {
        brokerId: "test-broker",
        channel: "EMAIL",
        subject: "Test",
        body: "Test-only body",
      },
    } as any;
    return { sgMail, prisma, processor, job };
  }
  it.each([undefined, "", "   "])(
    "fails configured EMAIL without SENDGRID_FROM=%s before provider send",
    async (from) => {
      const h = harness(from);
      await expect(h.processor.handleSend(h.job)).rejects.toThrow(
        "[Email] SENDGRID_FROM is not configured",
      );
      expect(h.sgMail.send).not.toHaveBeenCalled();
      expect(h.prisma.notification.update).toHaveBeenCalledWith({
        where: { id: "notification-test" },
        data: { status: "FAILED", sentAt: undefined },
      });
    },
  );
  it("preserves the explicit sender and never substitutes the support contact or SMTP identity", async () => {
    const h = harness("verified-sender@example.test");
    await h.processor.handleSend(h.job);
    expect(h.sgMail.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "recipient@example.test",
        from: { email: "verified-sender@example.test", name: "ST Michael" },
      }),
    );
    expect(h.prisma.notification.update).toHaveBeenCalledWith({
      where: { id: "notification-test" },
      data: { status: "SENT", sentAt: expect.any(Date) },
    });
  });
});
