import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { LoyaltyPermissionModule } from "../loyalty-workflow/loyalty-permission.module";
import { LoyaltyProgramController } from "./loyalty-program.controller";
import { LoyaltyProgramService } from "./loyalty-program.service";

@Module({
  imports: [AuthModule, LoyaltyPermissionModule],
  controllers: [LoyaltyProgramController],
  providers: [LoyaltyProgramService],
})
export class LoyaltyProgramModule {}
