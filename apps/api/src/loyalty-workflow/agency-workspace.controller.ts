import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Patch,
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
import {
  AgencyCallControlDto,
  AgencyClaimDto,
  AgencyContactsDto,
  AgencyPilotDto,
  AgencyReassignDto,
  AgencyScriptDto,
  AgencyWorkspaceQuery,
} from "./agency-workspace.dto";
import { AgencyWorkspaceService } from "./agency-workspace.service";
import { ExpectedVersionDto } from "./loyalty-workflow.dto";
import { AgencyCallReviewDto } from "./agency-call-review.dto";
import { AgencyCallReviewService } from "./agency-call-review.service";

@Controller("loyalty-workflow/agencies-v1-2")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.MANAGER)
export class AgencyWorkspaceController {
  constructor(
    private readonly workspace: AgencyWorkspaceService,
    private readonly reviews: AgencyCallReviewService,
  ) {}

  @Get(":id/attempts/:attemptId/reviews")
  @Header("Cache-Control", "private, no-store")
  callReviews(
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @Param("attemptId", new ParseUUIDPipe({ version: "4" })) attemptId: string,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.reviews.list(id, attemptId, user);
  }

  @Post(":id/attempts/:attemptId/reviews")
  reviewCall(
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @Param("attemptId", new ParseUUIDPipe({ version: "4" })) attemptId: string,
    @Body() body: AgencyCallReviewDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.reviews.save(id, attemptId, body, user);
  }

  @Get()
  @Header("Cache-Control", "private, no-store")
  list(
    @Query() query: AgencyWorkspaceQuery,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.workspace.list(query, user);
  }

  @Post("script")
  script(
    @Body() body: AgencyScriptDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.workspace.approveScript(body, user);
  }

  @Post("pilot")
  pilot(@Body() body: AgencyPilotDto, @CurrentUser() user: CurrentUserPayload) {
    return this.workspace.pilot(body, user);
  }

  @Patch(":id/call-control")
  control(
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @Body() body: AgencyCallControlDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.workspace.control(id, body, user);
  }

  @Post("tasks/:id/resume")
  resume(
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @Body() body: ExpectedVersionDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.workspace.resumeTask(id, body.expectedVersion, user);
  }

  @Patch(":id/contacts")
  contacts(
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @Body() body: AgencyContactsDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.workspace.contacts(id, body, user);
  }

  @Patch("assignments/:id/reassign")
  reassign(
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @Body() body: AgencyReassignDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.workspace.reassign(id, body, user);
  }

  @Post("export")
  @Header("Cache-Control", "private, no-store")
  @Header("Content-Type", "text/csv; charset=utf-8")
  @Header(
    "Content-Disposition",
    'attachment; filename="agency-call-events.csv"',
  )
  export(
    @Query() query: AgencyWorkspaceQuery,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.workspace.export(query, user);
  }

  @Post("assignments/:id/claim")
  claim(
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @Body() body: AgencyClaimDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.workspace.claim(id, body, user);
  }
}
