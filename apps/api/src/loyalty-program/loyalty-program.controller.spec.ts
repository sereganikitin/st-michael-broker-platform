import "reflect-metadata";
import { UserRole } from "@st-michael/shared";
import { LoyaltyProgramController } from "./loyalty-program.controller";

describe("LoyaltyProgramController RBAC", () => {
  it("admits only ADMIN/MANAGER at the route boundary", () => {
    expect(Reflect.getMetadata("roles", LoyaltyProgramController)).toEqual([
      UserRole.ADMIN,
      UserRole.MANAGER,
    ]);
  });
});
