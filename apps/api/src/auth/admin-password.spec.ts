import { BadRequestException, ForbiddenException, UnauthorizedException, ConflictException, ValidationPipe } from "@nestjs/common";
import { GUARDS_METADATA, HTTP_CODE_METADATA, ROUTE_ARGS_METADATA } from "@nestjs/common/constants";
import { validate } from "class-validator";
import { readFileSync } from "fs";
import { resolve } from "path";
import * as bcrypt from "bcrypt";
import { AuthService } from "./auth.service";
import { AdminController } from "../admin/admin.controller";
import { AdminChangePasswordDto } from "../admin/admin-password.dto";
import { hashPassword, verifyPassword } from "./password-hash";
import { sessionVersionMatches } from "./session-version";

const actorId = "11111111-1111-4111-8111-111111111111";
const targetId = "22222222-2222-4222-8222-222222222222";
const oldPassword = "admin-existing-password";
const newPassword = "user-new-safe-password";
let oldHash: string;
function account(id: string, overrides: any = {}) {
  return { id, phone: id === actorId ? "+79990000001" : "+79990000002", role: id === actorId ? "ADMIN" : "BROKER",
    status: "ACTIVE", mergedIntoId: null, passwordHash: oldHash, authVersion: 0, fullName: "Test user",
    funnelStage: "NEW_BROKER", amoContactId: null, brokerAgencies: [], ...overrides };
}
function harness(actor: any = account(actorId), target: any = account(targetId)) {
  const tx = { $queryRaw: jest.fn().mockResolvedValue([{ id: actorId }, { id: targetId }]),
    broker: { findUnique: jest.fn(async ({ where }) => where.id === actorId ? actor : target), updateMany: jest.fn().mockResolvedValue({ count: 1 }), update: jest.fn().mockResolvedValue({ id: targetId }) },
    phoneOtp: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) }, auditLog: { create: jest.fn().mockResolvedValue({ id: "audit-id" }) } };
  const prisma: any = { $transaction: jest.fn(async (fn) => fn(tx)), broker: { findUnique: jest.fn() } };
  const jwt = { sign: jest.fn().mockReturnValue("jwt"), verify: jest.fn() };
  const service = new AuthService(prisma, jwt as any, { add: jest.fn() } as any, { syncFromFeed: jest.fn().mockResolvedValue({}) } as any);
  return { tx, prisma, jwt, service };
}

beforeAll(async () => { oldHash = await bcrypt.hash(oldPassword, 10); });

describe("ADMIN password change", () => {
  it("is ADMIN-only, UUID-validated, rate-limited and returns explicit HTTP 200", () => {
    const endpoint = AdminController.prototype.changeUserPassword;
    expect(Reflect.getMetadata("roles", endpoint)).toEqual(["ADMIN"]);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, endpoint)).toBe(200);
    expect(Reflect.getMetadata(GUARDS_METADATA, endpoint).map((g: any) => g.name)).toContain("ThrottlerGuard");
    const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, AdminController, "changeUserPassword");
    expect(args["5:1"].pipes.map((pipe: any) => pipe.name)).toContain("ParseUUIDPipe");
  });

  it.each(["BROKER", "MANAGER"])("denies a non-ADMIN actor %s even without HTTP guards", async (role) => {
    const h = harness(account(actorId, { role }));
    await expect(h.service.adminChangePassword(actorId, targetId, oldPassword, newPassword, 0)).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.tx.broker.updateMany).not.toHaveBeenCalled();
  });

  it.each([null, { status: "BLOCKED" }, { status: "PENDING" }, { passwordHash: null }, { mergedIntoId: targetId }])(
    "requires an active nonmerged registered administrator", async (override) => {
      const h = harness(override === null ? null : account(actorId, override));
      await expect(h.service.adminChangePassword(actorId, targetId, oldPassword, newPassword, 0)).rejects.toBeInstanceOf(ForbiddenException);
      expect(h.tx.broker.updateMany).not.toHaveBeenCalled();
    },
  );

  it.each([null, { status: "BLOCKED" }, { status: "PENDING" }, { passwordHash: null }, { mergedIntoId: actorId }])(
    "never creates, activates or changes an ineligible target", async (override) => {
      const h = harness(account(actorId), override === null ? null : account(targetId, override));
      await expect(h.service.adminChangePassword(actorId, targetId, oldPassword, newPassword, 0)).rejects.toBeInstanceOf(BadRequestException);
      expect(h.tx.broker.updateMany).not.toHaveBeenCalled();
      expect(h.tx.auditLog.create).not.toHaveBeenCalled();
    },
  );

  it("requires the current administrator password and the current session version", async () => {
    const h = harness();
    await expect(h.service.adminChangePassword(actorId, targetId, "incorrect-admin-password", newPassword, 0)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(h.service.adminChangePassword(actorId, targetId, oldPassword, newPassword, 1)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(h.tx.broker.updateMany).not.toHaveBeenCalled();
  });

  it.each([actorId, actorId.toUpperCase(), "not-a-uuid"])("denies self or malformed target before a transaction", async (id) => {
    const h = harness();
    await expect(h.service.adminChangePassword(actorId, id, oldPassword, newPassword, 0)).rejects.toBeInstanceOf(BadRequestException);
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each(["short", "a".repeat(129), null, 123])("checks password boundaries without writes", async (password) => {
    const h = harness();
    await expect(h.service.adminChangePassword(actorId, targetId, oldPassword, password as any, 0)).rejects.toBeInstanceOf(BadRequestException);
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each(["BROKER", "MANAGER", "ADMIN"])("sets a %s password without changing profile, role or activation", async (role) => {
    const h = harness(account(actorId), account(targetId, { role, authVersion: 3 }));
    await expect(h.service.adminChangePassword(actorId, targetId, oldPassword, newPassword, 0)).resolves.toEqual({
      ok: true, message: "Пароль пользователя изменён", sessionsRevoked: true,
    });
    const update = h.tx.broker.updateMany.mock.calls[0][0];
    expect(Object.keys(update.data).sort()).toEqual(["authVersion", "passwordHash", "passwordResetExpiresAt", "passwordResetToken"]);
    expect(update.data.authVersion).toEqual({ increment: 1 });
    expect(update.where).toMatchObject({ id: targetId, authVersion: 3, mergedIntoId: null, status: "ACTIVE", passwordHash: oldHash });
    expect(await verifyPassword(newPassword, update.data.passwordHash)).toBe(true);
    expect(await verifyPassword(oldPassword, update.data.passwordHash)).toBe(false);
    expect(h.tx.phoneOtp.updateMany).toHaveBeenCalledWith({ where: { phone: "+79990000002", purpose: { in: ["LOGIN", "PASSWORD_RESET"] }, consumedAt: null }, data: { consumedAt: expect.any(Date) } });
    expect(h.tx.auditLog.create).toHaveBeenCalledWith({ data: { userId: actorId, action: "ADMIN_PASSWORD_CHANGED", entity: "Broker", entityId: targetId, payload: { sessionsRevoked: true } } });
    const audit = JSON.stringify(h.tx.auditLog.create.mock.calls);
    for (const privateValue of [oldPassword, newPassword, oldHash, update.data.passwordHash]) expect(audit).not.toContain(privateValue);
    expect(h.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "Serializable", maxWait: 5000, timeout: 10000 });
    expect(h.tx.$queryRaw.mock.calls[0].slice(1)).toEqual([actorId, targetId]);
    expect(h.tx.$queryRaw.mock.calls[0][0].join("")).toContain("ORDER BY id FOR UPDATE");
  });

  it("does not audit a missed target CAS or report success when audit fails", async () => {
    const h = harness();
    h.tx.broker.updateMany.mockResolvedValue({ count: 0 });
    await expect(h.service.adminChangePassword(actorId, targetId, oldPassword, newPassword, 0)).rejects.toBeInstanceOf(ConflictException);
    expect(h.tx.auditLog.create).not.toHaveBeenCalled();
    const other = harness();
    other.tx.auditLog.create.mockRejectedValue(new Error("transaction-audit-failure"));
    await expect(other.service.adminChangePassword(actorId, targetId, oldPassword, newPassword, 0)).rejects.toThrow();
  });

  it("validates the DTO with a field-only contract and rejects extra fields", async () => {
    const dto = Object.assign(new AdminChangePasswordDto(), { currentPassword: oldPassword, newPassword });
    expect(await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).toEqual([]);
    const invalid = Object.assign(new AdminChangePasswordDto(), { currentPassword: "", newPassword: "short", role: "ADMIN" });
    expect((await validate(invalid, { whitelist: true, forbidNonWhitelisted: true })).map(e => e.property).sort()).toEqual(["currentPassword", "newPassword", "role"]);
  });

  it("the production Nest validation response never includes password values or DTO objects", async () => {
    const currentSecret = "synthetic-current-secret-".repeat(10);
    const newSecret = "tiny-secret";
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    try {
      await pipe.transform({ currentPassword: currentSecret, newPassword: newSecret },
        { type: "body", metatype: AdminChangePasswordDto });
      throw new Error("Expected validation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      const response = (error as BadRequestException).getResponse();
      expect(response).toMatchObject({ statusCode: 400, message: expect.any(Array) });
      const serialized = JSON.stringify(response);
      for (const privateValue of [currentSecret, newSecret]) expect(serialized).not.toContain(privateValue);
      expect(serialized).not.toMatch(/"(?:target|value)":/);
    }
  });
});

describe("session revocation and full password hashing", () => {
  it.each(["access", "refresh"] as const)("rejects old %s tokens after a version increment and enforces token type", (kind) => {
    expect(sessionVersionMatches({ sub: targetId }, 0, kind)).toBe(true);
    expect(sessionVersionMatches({ sub: targetId }, 1, kind)).toBe(false);
    expect(sessionVersionMatches({ sub: targetId, type: kind, authVersion: 1 }, 1, kind)).toBe(true);
    expect(sessionVersionMatches({ sub: targetId, type: kind, authVersion: 0 }, 1, kind)).toBe(false);
    expect(sessionVersionMatches({ sub: targetId, type: kind === "access" ? "refresh" : "access", authVersion: 1 }, 1, kind)).toBe(false);
    for (const authVersion of ["0", -1, 1.5, null]) expect(sessionVersionMatches({ sub: targetId, type: kind, authVersion }, 0, kind)).toBe(false);
    expect(sessionVersionMatches({ sub: targetId, type: kind }, 0, kind)).toBe(false);
    expect(sessionVersionMatches({ sub: targetId, authVersion: 0 }, 0, kind)).toBe(false);
  });

  it("refreshes only the matching active version, upgrades legacy tokens and never accepts an access token as a typed refresh", async () => {
    const h = harness();
    h.prisma.broker.findUnique.mockResolvedValue(account(targetId, { authVersion: 1 }));
    for (const payload of [{ sub: targetId }, { sub: targetId, type: "refresh", authVersion: 0 }, { sub: targetId, type: "access", authVersion: 1 }]) {
      h.jwt.verify.mockReturnValue(payload);
      await expect(h.service.refreshToken("token")).rejects.toBeInstanceOf(UnauthorizedException);
    }
    h.jwt.verify.mockReturnValue({ sub: targetId, type: "refresh", authVersion: 1 });
    await expect(h.service.refreshToken("token")).resolves.toEqual({ accessToken: "jwt" });
    expect(h.jwt.sign).toHaveBeenLastCalledWith(expect.objectContaining({ type: "access", authVersion: 1 }));
    h.prisma.broker.findUnique.mockResolvedValue(account(targetId));
    h.jwt.verify.mockReturnValue({ sub: targetId });
    await h.service.refreshToken("legacy");
    expect(h.jwt.sign).toHaveBeenLastCalledWith(expect.objectContaining({ type: "access", authVersion: 0 }));
  });

  it("supports legacy bcrypt hashes and the entire 128-character password without 72-byte collisions", async () => {
    expect(await verifyPassword(oldPassword, oldHash)).toBe(true);
    const first = "я".repeat(127) + "А";
    const second = "я".repeat(127) + "Б";
    const hash = await hashPassword(first);
    expect(hash).toMatch(/^bcrypt-sha256-v1\$\$2[ab]\$10\$/);
    expect(await verifyPassword(first, hash)).toBe(true);
    expect(await verifyPassword(second, hash)).toBe(false);
  });

  it("uses a default-zero additive migration and never rewrites passwords", () => {
    const migration = readFileSync(resolve(__dirname, "../../../../packages/database/prisma/migrations/20261007010000_broker_auth_version/migration.sql"), "utf8");
    expect(migration).toContain('ADD COLUMN "auth_version" INTEGER NOT NULL DEFAULT 0');
    expect(migration).not.toMatch(/\b(UPDATE|DELETE|DROP)\b/);
  });

  it.each(["self", "email", "sms"])("increments authVersion and revokes recovery atomically for the %s change path", async (path) => {
    const h = harness();
    h.prisma.broker.findUnique.mockResolvedValue(account(targetId, { authVersion: 4,
      passwordResetToken: "opaque-reset-token", passwordResetExpiresAt: new Date(Date.now() + 60000) }));
    if (path === "self") await h.service.changePassword(targetId, oldPassword, newPassword);
    if (path === "email") await h.service.resetPassword("opaque-reset-token", newPassword);
    if (path === "sms") {
      const otp = { verify: jest.fn().mockResolvedValue(undefined) };
      const service = new AuthService(h.prisma, h.jwt as any, { add: jest.fn() } as any,
        { syncFromFeed: jest.fn().mockResolvedValue({}) } as any, otp as any);
      await service.resetPasswordByCode({ phone: "+79990000002", code: "123456", password: newPassword });
      expect(otp.verify).toHaveBeenCalledTimes(1);
    }
    const mutation = h.tx.broker.update.mock.calls[0][0];
    expect(mutation.where).toMatchObject({ id: targetId, authVersion: 4, passwordHash: oldHash, mergedIntoId: null });
    expect(mutation.data).toEqual({ passwordHash: expect.any(String), authVersion: { increment: 1 }, passwordResetToken: null, passwordResetExpiresAt: null });
    if (path === "email") expect(mutation.where.passwordResetToken).toBe("opaque-reset-token");
    expect(await verifyPassword(newPassword, mutation.data.passwordHash)).toBe(true);
    expect(h.tx.phoneOtp.updateMany).toHaveBeenCalledTimes(1);
    expect(h.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "Serializable" });
  });

  it("mints distinct typed access and refresh tokens with the current authVersion", async () => {
    AuthService.lastFeedSyncAt = Date.now();
    const h = harness();
    h.prisma.broker.findUnique.mockResolvedValue(account(targetId, { authVersion: 5 }));
    await h.service.login({ phone: "+79990000002", password: oldPassword });
    expect(h.jwt.sign.mock.calls[0][0]).toMatchObject({ type: "access", authVersion: 5 });
    expect(h.jwt.sign.mock.calls[1][0]).toMatchObject({ type: "refresh", authVersion: 5 });
  });

  it("suppresses private ORM errors if a password CAS races with another change", async () => {
    const h = harness();
    h.prisma.broker.findUnique.mockResolvedValue(account(targetId));
    h.tx.broker.update.mockRejectedValue(new Error(`private mutation ${oldHash} ${newPassword}`));
    try {
      await h.service.changePassword(targetId, oldPassword, newPassword);
      throw new Error("Expected conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictException);
      expect(JSON.stringify((error as ConflictException).getResponse())).not.toContain(newPassword);
      expect(h.tx.phoneOtp.updateMany).not.toHaveBeenCalled();
    }
  });
});
