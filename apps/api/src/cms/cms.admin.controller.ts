import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '@st-michael/shared';
import { CurrentUser, CurrentUserPayload } from '../auth/current-user.decorator';
import { CmsService } from './cms.service';

@ApiTags('admin-cms')
@Controller('admin/cms')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.MANAGER)
@ApiBearerAuth()
export class AdminCmsController {
  constructor(private readonly cms: CmsService) {}

  // ─── Content blocks ─────────────────────

  @Get('content')
  @ApiOperation({ summary: 'List all content blocks' })
  async list() {
    return this.cms.getAllContent();
  }

  @Get('content/:key')
  async getBlock(@Param('key') key: string) {
    return { key, value: await this.cms.getContent(key) };
  }

  @Patch('content/:key')
  @ApiOperation({ summary: 'Upsert content block' })
  @Roles(UserRole.ADMIN)
  async upsert(
    @Param('key') key: string,
    @Body() body: { value: any },
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.cms.upsertContent(key, body.value, user?.id);
  }

  // ─── Events ─────────────────────────────

  @Get('events')
  async listEvents(@Query('all') all?: string) {
    return this.cms.listEvents({ onlyActive: false, onlyFuture: all !== '1' });
  }

  @Post('events')
  @Roles(UserRole.ADMIN)
  async createEvent(@Body() body: any) {
    return this.cms.createEvent(body);
  }

  @Patch('events/:id')
  @Roles(UserRole.ADMIN)
  async updateEvent(@Param('id') id: string, @Body() body: any) {
    return this.cms.updateEvent(id, body);
  }

  @Delete('events/:id')
  @Roles(UserRole.ADMIN)
  async deleteEvent(@Param('id') id: string) {
    return this.cms.deleteEvent(id);
  }

  // ─── Projects ───────────────────────────

  @Get('projects')
  async listProjects() {
    return this.cms.listProjects(false);
  }

  @Post('projects')
  @Roles(UserRole.ADMIN)
  async createProject(@Body() body: any) {
    return this.cms.createProject(body);
  }

  @Patch('projects/:id')
  @Roles(UserRole.ADMIN)
  async updateProject(@Param('id') id: string, @Body() body: any) {
    return this.cms.updateProject(id, body);
  }

  @Delete('projects/:id')
  @Roles(UserRole.ADMIN)
  async deleteProject(@Param('id') id: string) {
    return this.cms.deleteProject(id);
  }

  // ─── Bootstrap ──────────────────────────

  @Post('seed-defaults')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Insert default landing content if missing (idempotent)' })
  async seedDefaults() {
    return this.cms.seedDefaults();
  }
}
