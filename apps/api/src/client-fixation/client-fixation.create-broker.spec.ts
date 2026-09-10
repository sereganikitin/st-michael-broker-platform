import { BadRequestException } from "@nestjs/common";
import {
  ClientFixationService,
  brokerPhoneConflict,
} from "./client-fixation.service";

// 2026-09-09 (владелец, критично): брокер не должен видеть чужие ФИО и
// статусы. Расхождение в написании ФИО больше не конфликт — заявка уходит
// брокеру с этим номером; блокированная карточка даёт обобщённую ошибку,
// подробности только сотрудникам и в журнал.
describe("brokerPhoneConflict", () => {
  it("другой человек на этом номере → конфликта нет, заявка уходит ему", () => {
    expect(
      brokerPhoneConflict(
        { fullName: "Кравченко Наталья Владимировна", status: "PENDING" },
        "Климшина Алена",
      ),
    ).toBeNull();
  });
  it("тот же человек с другим написанием ФИО → без конфликта", () => {
    expect(brokerPhoneConflict({ fullName: "Иванов Иван", status: "ACTIVE" }, "Иван Иванов И.")).toBeNull();
    expect(brokerPhoneConflict({ fullName: "Петрова Мария", status: "PENDING" }, "Мария Петрова")).toBeNull();
  });
  it("слитая карточка → без конфликта (заявка уйдёт выжившей карточке)", () => {
    expect(
      brokerPhoneConflict({ fullName: "Иванов Иван", status: "ACTIVE", mergedIntoId: "x" }, "Иванов Иван"),
    ).toBeNull();
  });
  it("заблокированная карточка → обобщённое сообщение без ФИО и статуса", () => {
    const conflict = brokerPhoneConflict({ fullName: "Иванов Иван", status: "BLOCKED" }, "Иванов Иван");
    expect(conflict?.code).toBe("BROKER_PHONE_CONFLICT");
    expect(conflict?.safeMessage).not.toContain("Иванов");
    expect(conflict?.safeMessage).not.toContain("заблокирован");
    expect(conflict?.safeMessage).toContain("недоступен для фиксации");
    // подробности остаются сотрудникам и журналу
    expect(conflict?.staffMessage).toContain("Иванов Иван");
  });
});

describe("ClientFixationService.createBrokerByCreator", () => {
  const creator = { id: "coord-1", fullName: "Координатор", brokerAgencies: [] };
  const mkService = (existing: any) => {
    const prisma: any = {
      broker: {
        findUnique: jest.fn(async (args: any) =>
          args?.where?.id === "coord-1" ? creator : args?.where?.phone ? existing : null,
        ),
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({}),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const service = new ClientFixationService(prisma, {} as any, {} as any);
    (service as any).ensureBrokerAmoContact = jest.fn().mockResolvedValue(undefined);
    return { service, prisma };
  };
  it("брокеру возвращает только id существующей карточки, без ФИО и статуса", async () => {
    const { service } = mkService({ id: "b1", fullName: "Иванов Иван", phone: "+79990000001", email: null, isCoordinator: false, status: "ACTIVE", mergedIntoId: null });
    const res: any = await service.createBrokerByCreator("coord-1", { fullName: "Иван Иванов", phone: "+79990000001" } as any);
    expect(res.created).toBe(false);
    expect(res.existed).toBe(true);
    expect(res.broker).toEqual({ id: "b1" });
    expect(res.status).toBeUndefined();
  });
  it("номер занят ДРУГИМ человеком → заявка молча уходит ему, чужие данные не раскрываются", async () => {
    const { service } = mkService({ id: "b2", fullName: "Кравченко Наталья", phone: "+79253181467", email: null, isCoordinator: false, status: "PENDING", mergedIntoId: null });
    const res: any = await service.createBrokerByCreator("coord-1", { fullName: "Климшина Алена", phone: "+79253181467" } as any);
    expect(res.broker).toEqual({ id: "b2" });
    expect(JSON.stringify(res)).not.toContain("Кравченко");
    expect(JSON.stringify(res)).not.toContain("PENDING");
  });
  // 2026-09-10 (правило владельца): ФИО значения не имеет, фиксация идёт по
  // номеру. Новое написание становится «именем для работы», прежнее — в журнал.
  it("новое ФИО на том же номере запоминается как имя для работы", async () => {
    const { service, prisma } = mkService({
      id: "b4",
      fullName: "Ковалева Анастасия Андреевна",
      displayName: null,
      phone: "+79252212177",
      email: null,
      isCoordinator: false,
      status: "PENDING",
      mergedIntoId: null,
    });
    await service.createBrokerByCreator("coord-1", {
      fullName: "Субоч Евгений",
      phone: "+79252212177",
    } as any);
    expect(prisma.broker.update).toHaveBeenCalledWith({
      where: { id: "b4" },
      data: { displayName: "Субоч Евгений", displayNameSource: "fixation_form" },
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "BROKER_NAME_UPDATED" }),
      }),
    );
  });

  it("то же ФИО — карточку не трогаем", async () => {
    const { service, prisma } = mkService({
      id: "b5",
      fullName: "Иванов Иван",
      displayName: null,
      phone: "+79990000005",
      email: null,
      isCoordinator: false,
      status: "ACTIVE",
      mergedIntoId: null,
    });
    await service.createBrokerByCreator("coord-1", {
      fullName: "иванов иван",
      phone: "+79990000005",
    } as any);
    expect(prisma.broker.update).not.toHaveBeenCalled();
  });

  it("сотруднику отдаёт подробности карточки", async () => {
    const { service } = mkService({ id: "b3", fullName: "Кравченко Наталья", phone: "+79253181468", email: null, isCoordinator: false, status: "PENDING", mergedIntoId: null });
    const res: any = await service.createBrokerByCreator(
      "coord-1",
      { fullName: "Климшина Алена", phone: "+79253181468" } as any,
      { audience: "STAFF" },
    );
    expect(res.broker.fullName).toBe("Кравченко Наталья");
    expect(res.status).toBe("PENDING");
  });
});
