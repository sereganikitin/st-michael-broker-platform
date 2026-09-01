import { Body, Controller, Get, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { UserRole } from "@st-michael/shared";
import {
  CurrentUser,
  CurrentUserPayload,
} from "../auth/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { LoyaltyProgramDecideDto } from "./loyalty-program.dto";
import { LoyaltyProgramService } from "./loyalty-program.service";

@ApiTags("loyalty-program")
@ApiBearerAuth()
@Controller("loyalty-program")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.MANAGER)
export class LoyaltyProgramController {
  constructor(private readonly program: LoyaltyProgramService) {}

  @Get("2026")
  @ApiOperation({
    summary:
      "Word program 2026 overlay: sold partners glued to Anna agency cards",
  })
  overlay(
    @CurrentUser() user: CurrentUserPayload,
    @Query("list") list?: "SOLD_2026" | "SLEEPING",
  ) {
    const allowed = list === "SOLD_2026" || list === "SLEEPING" ? list : undefined;
    return this.program.overlay(user, allowed);
  }

  @Post("2026/matches")
  @ApiOperation({ summary: "Manually glue a Word partner to an Anna card" })
  decide(
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: LoyaltyProgramDecideDto,
  ) {
    return this.program.decide(user, body);
  }
}
