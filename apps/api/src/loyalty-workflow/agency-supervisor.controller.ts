import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { UserRole } from "@st-michael/shared";
import {
  CurrentUser,
  CurrentUserPayload,
} from "../auth/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { AgencyWorkspaceQuery } from "./agency-workspace.dto";
import { AgencyDelayReasonDto } from "./agency-supervisor.dto";
import { AgencySupervisorService } from "./agency-supervisor.service";

@Controller("loyalty-workflow/agencies-v1-2/supervisor")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.MANAGER)
export class AgencySupervisorController {
  constructor(private readonly supervisor: AgencySupervisorService) {}
  @Get()
  @Header("Cache-Control", "private, no-store")
  report(
    @Query() query: AgencyWorkspaceQuery,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.supervisor.report(query, user);
  }
  @Post("tasks/:id/delay-reason")
  delayReason(
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @Body() body: AgencyDelayReasonDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.supervisor.delayReason(id, body, user);
  }
}
