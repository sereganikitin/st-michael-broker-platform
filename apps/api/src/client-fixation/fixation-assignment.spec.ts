import { resolveFixationBrokers } from "./fixation-assignment";

describe("verified fixation destination", () => {
  function fixture() {
    const rows: any = {
      author: { id: "author", role: "BROKER", status: "ACTIVE" },
      recipient: {
        id: "recipient",
        role: "BROKER",
        status: "ACTIVE",
        phone: "+79990000101",
      },
      newer: { id: "newer", role: "BROKER", status: "ACTIVE" },
    };
    const db: any = {
      broker: {
        findUnique: jest.fn(async ({ where }) => rows[where.id] || null),
      },
      $queryRaw: jest
        .fn()
        .mockResolvedValue([{ id: "newer", role: "BROKER", status: "ACTIVE" }]),
    };
    return { db, rows };
  }
  it("uses the canonical card once and keeps the author separate", async () => {
    const f = fixture();
    expect(
      await resolveFixationBrokers(f.db, "author", "recipient"),
    ).toMatchObject({
      broker: { id: "author" },
      responsibleBroker: { id: "newer" },
    });
  });
  it("keeps an accepted destination even when phone lookup would route elsewhere", async () => {
    const f = fixture();
    expect(
      await resolveFixationBrokers(f.db, "author", "recipient", true),
    ).toMatchObject({ responsibleBroker: { id: "recipient" } });
    expect(f.db.$queryRaw).not.toHaveBeenCalled();
  });
  it("requires review when the pinned recipient has been merged", async () => {
    const f = fixture();
    f.rows.recipient.mergedIntoId = "newer";
    await expect(
      resolveFixationBrokers(f.db, "author", "recipient", true),
    ).rejects.toThrow("проверка сотрудником");
  });
  it("rejects a staff identity as a delegated broker", async () => {
    const f = fixture();
    f.rows.recipient.role = "ADMIN";
    await expect(
      resolveFixationBrokers(f.db, "author", "recipient"),
    ).rejects.toThrow();
  });
});
