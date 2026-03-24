import { Controller, Get, Post, Patch, Param, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser, CurrentUserPayload } from '../auth/current-user.decorator';
import { MeetingsService } from './meetings.service';
import { createMeetingDtoSchema, updateMeetingDtoSchema, paginationQuerySchema } from '@st-michael/shared';

@ApiTags('meetings')
@Controller('meetings')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class MeetingsController {
  constructor(private readonly meetingsService: MeetingsService) {}

  @Get()
  @ApiOperation({ summary: 'Get broker meetings' })
  @ApiResponse({ status: 200, description: 'Paginated list of meetings' })
  async getMeetings(@CurrentUser() user: CurrentUserPayload, @Query() query: any) {
    const pagination = paginationQuerySchema.parse(query);
    return this.meetingsService.getMeetings(user.id, {
      ...pagination,
      status: query.status,
      type: query.type,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get meeting details' })
  @ApiResponse({ status: 200, description: 'Meeting details' })
  async getMeeting(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string) {
    return this.meetingsService.getMeeting(id, user.id);
  }

  @Post()
  @ApiOperation({ summary: 'Create meeting' })
  @ApiResponse({ status: 201, description: 'Meeting created' })
  async createMeeting(@CurrentUser() user: CurrentUserPayload, @Body() body: unknown) {
    const data = createMeetingDtoSchema.parse(body) as any;
    return this.meetingsService.createMeeting(user.id, data);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update meeting' })
  @ApiResponse({ status: 200, description: 'Meeting updated' })
  async updateMeeting(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const data = updateMeetingDtoSchema.parse(body) as any;
    return this.meetingsService.updateMeeting(id, user.id, data);
  }

  @Post(':id/sign-act')
  @ApiOperation({ summary: 'Sign inspection act' })
  @ApiResponse({ status: 200, description: 'Act signed, client fixation updated' })
  async signAct(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string) {
    return this.meetingsService.signAct(id, user.id);
  }
}
