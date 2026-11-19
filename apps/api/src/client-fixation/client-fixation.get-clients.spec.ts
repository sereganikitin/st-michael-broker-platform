import { ClientFixationService } from "./client-fixation.service";

describe("ClientFixationService.getClients", () => {
  let prisma: any;
  let service: ClientFixationService;

  beforeEach(() => {
    prisma = {
      client: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    service = new ClientFixationService(prisma, {} as any, {} as any);
  });

  it("scopes a broker to own and responsible clients and hides old-cabinet history", async () => {
    await service.getClients("broker-1", {});
    expect(prisma.client.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [{ brokerId: "broker-1" }, { responsibleBrokerId: "broker-1" }],
          // 2026-09-07: исторические записи старого кабинета брокеру не видны.
          AND: [
            {
              OR: [
                { comment: null },
                { NOT: { comment: { startsWith: "[old-cabinet:" } } },
              ],
            },
          ],
        },
      }),
    );
  });

  it("lets staff see every fixation uniqueness row", async () => {
    await service.getClients("admin-1", { asStaff: true });
    expect(prisma.client.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {},
      }),
    );
  });

  it('keeps the delegated filter scoped to clients submitted by the caller', async () => {
    await service.getClients('author', { submittedForOthers: true, search: 'Synthetic' });
    expect(prisma.client.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      AND: expect.arrayContaining([{ brokerId: 'author', responsibleBrokerId: { not: 'author' } }]),
    }) }));
  });

  it("lets staff filter uniqueness rows to one broker", async () => {
    await service.getClients("admin-1", { asStaff: true, brokerId: "broker-9" });
    expect(prisma.client.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [{ brokerId: "broker-9" }, { responsibleBrokerId: "broker-9" }],
        },
      }),
    );
  });
});
