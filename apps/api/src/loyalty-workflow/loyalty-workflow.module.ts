import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { LoyaltyBaseModule } from "../loyalty-base/loyalty-base.module";
import { LoyaltyPermissionModule } from "./loyalty-permission.module";
import { LoyaltyWorkflowController } from "./loyalty-workflow.controller";
import { LoyaltyWorkflowService } from "./loyalty-workflow.service";
import { AgencyWorkspaceController } from "./agency-workspace.controller";
import { AgencyWorkspaceService } from "./agency-workspace.service";

@Module({
  imports: [AuthModule, LoyaltyBaseModule, LoyaltyPermissionModule],
  controllers: [LoyaltyWorkflowController, AgencyWorkspaceController],
  providers: [LoyaltyWorkflowService, AgencyWorkspaceService],
  exports: [LoyaltyWorkflowService],
})
export class LoyaltyWorkflowModule {}
