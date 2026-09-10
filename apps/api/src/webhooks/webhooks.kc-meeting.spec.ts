import { WebhooksService } from "./webhooks.service";

// 2026-09-10 (владелец): карточка колл-центра, дошедшая до «успешно
// реализовано» (статус 142 воронки 7600542), означает проведённую встречу.
// Раньше вебхук менял только уникальность, и у брокера оставалось «0 встр.»
// при реальных встречах — эти проверки закрывают регресс.
describe("WebhooksService: встреча по карточке колл-центра", () => {
  const makeService = (existing: any = null) => {
    const prisma: any = {
      meeting: {
        findFirst: jest.fn().mockResolvedValue(existing),
        create: jest.fn().mockResolvedValue({ id: "meeting-new" }),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const service = new WebhooksService(prisma as any);
    jest.spyOn((service as any).logger, "log").mockImplementation(() => undefined);
    jest.spyOn((service as any).logger, "warn").mockImplementation(() => undefined);
    return { service, prisma };
  };

  it("заводит встречу «состоялась» и помечает её номером лида", async () => {
    const { service, prisma } = makeService(null);
    const result = await (service as any).upsertKcMeeting({
      clientId: "client-1",
      brokerId: "broker-1",
      leadId: 30253117,
      when: new Date("2026-09-10T10:00:00.000Z"),
    });
    expect(result).toBe("created");
    const data = prisma.meeting.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      clientId: "client-1",
      brokerId: "broker-1",
      status: "COMPLETED",
      type: "OFFICE_VISIT",
    });
    expect(data.comment).toContain("[amo:kc-lead:30253117]");
  });

  it("повторный вызов по тому же лиду дубля не создаёт", async () => {
    const { service, prisma } = makeService({ id: "meeting-1", status: "COMPLETED" });
    const result = await (service as any).upsertKcMeeting({
      clientId: "client-1",
      brokerId: "broker-1",
      leadId: 30253117,
      when: new Date(),
    });
    expect(result).toBe("exists");
    expect(prisma.meeting.create).not.toHaveBeenCalled();
    expect(prisma.meeting.update).not.toHaveBeenCalled();
  });

  it("ранее назначенную встречу по тому же лиду переводит в «состоялась»", async () => {
    const { service, prisma } = makeService({ id: "meeting-1", status: "PENDING" });
    await (service as any).upsertKcMeeting({
      clientId: "client-1",
      brokerId: "broker-1",
      leadId: 42,
      when: new Date(),
    });
    expect(prisma.meeting.update).toHaveBeenCalledWith({
      where: { id: "meeting-1" },
      data: { status: "COMPLETED" },
    });
  });

  it("закрытие лида колл-центра отменяет встречу этого лида", async () => {
    const { service, prisma } = makeService(null);
    await (service as any).cancelKcMeeting("broker-1", 30253117);
    const args = prisma.meeting.updateMany.mock.calls[0][0];
    expect(args.where.brokerId).toBe("broker-1");
    expect(args.where.comment.contains).toBe("[amo:kc-lead:30253117]");
    expect(args.data).toEqual({ status: "CANCELLED" });
  });

  it("сбой записи встречи не роняет обработку вебхука", async () => {
    const { service, prisma } = makeService(null);
    prisma.meeting.findFirst.mockRejectedValue(new Error("база недоступна"));
    await expect(
      (service as any).recordKcMeetingHeld({ id: "client-1" }, { id: "broker-1" }, 7),
    ).resolves.toBeUndefined();
  });

  it("без брокера встреча не заводится", async () => {
    const { service, prisma } = makeService(null);
    await (service as any).recordKcMeetingHeld({ id: "client-1" }, null, 7);
    expect(prisma.meeting.create).not.toHaveBeenCalled();
  });
});
