import { Controller, Get, Patch, Post, Delete, Param, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser, CurrentUserPayload } from '../auth/current-user.decorator';
import { UserRole } from '@st-michael/shared';
import { AdminService } from './admin.service';

@ApiTags('admin')
@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.MANAGER)
@ApiBearerAuth()
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('brokers')
  @ApiOperation({ summary: 'List all brokers (admin/manager only)' })
  async listBrokers(@Query() query: any) {
    return this.adminService.listBrokers(query);
  }

  @Get('brokers/:id')
  @ApiOperation({ summary: 'Get broker details with stats' })
  async getBroker(@Param('id') id: string) {
    return this.adminService.getBroker(id);
  }

  @Patch('brokers/:id')
  @ApiOperation({ summary: 'Update broker (admin only)' })
  @Roles(UserRole.ADMIN)
  async updateBroker(@Param('id') id: string, @Body() body: any) {
    return this.adminService.updateBroker(id, body);
  }

  @Patch('brokers/:id/role')
  @ApiOperation({ summary: 'Change broker role (admin only)' })
  @Roles(UserRole.ADMIN)
  async changeRole(@Param('id') id: string, @Body() body: { role: 'BROKER' | 'MANAGER' | 'ADMIN' }) {
    return this.adminService.changeRole(id, body.role);
  }

  @Patch('brokers/:id/status')
  @ApiOperation({ summary: 'Change broker status (admin only)' })
  @Roles(UserRole.ADMIN)
  async changeStatus(@Param('id') id: string, @Body() body: { status: 'ACTIVE' | 'BLOCKED' | 'PENDING' }) {
    return this.adminService.changeStatus(id, body.status);
  }

  @Get('brokers/:id/deals')
  @ApiOperation({ summary: 'Get any broker deals' })
  async brokerDeals(@Param('id') id: string, @Query() query: any) {
    return this.adminService.brokerDeals(id, query);
  }

  @Get('brokers/:id/clients')
  @ApiOperation({ summary: 'Get any broker clients' })
  async brokerClients(@Param('id') id: string, @Query() query: any) {
    return this.adminService.brokerClients(id, query);
  }

  @Get('brokers/:id/meetings')
  @ApiOperation({ summary: 'Get any broker meetings' })
  async brokerMeetings(@Param('id') id: string, @Query() query: any) {
    return this.adminService.brokerMeetings(id, query);
  }

  @Patch('brokers/:id/sync-amo')
  @ApiOperation({ summary: 'Trigger amoCRM sync for specific broker' })
  async syncBrokerAmo(@Param('id') id: string) {
    return this.adminService.syncBrokerAmo(id);
  }

  @Delete('brokers/:id')
  @ApiOperation({ summary: 'Delete broker with all related data (admin only)' })
  @Roles(UserRole.ADMIN)
  async deleteBroker(@Param('id') id: string) {
    return this.adminService.deleteBroker(id);
  }

  @Post('brokers/import-from-amo')
  @ApiOperation({ summary: 'Bulk import brokers from amoCRM broker pipeline (10787390)' })
  @Roles(UserRole.ADMIN)
  async importBrokersFromAmo() {
    return this.adminService.importBrokersFromAmo();
  }

  // ─── Mailings ─────────────────────────────────────────────

  @Post('mailings/preview')
  @ApiOperation({ summary: 'Preview recipients matching filters' })
  async previewMailing(@Body() body: any) {
    return this.adminService.previewMailing(body?.filters || {});
  }

  @Post('mailings/send')
  @ApiOperation({ summary: 'Send broadcast to filtered brokers' })
  async sendMailing(@CurrentUser() user: CurrentUserPayload, @Body() body: any) {
    return this.adminService.sendMailing(user.id, {
      subject: body.subject,
      body: body.body,
      channels: body.channels,
      filters: body.filters || {},
    });
  }

  @Get('mailings')
  @ApiOperation({ summary: 'List broadcast history' })
  async listMailings(@Query() query: any) {
    return this.adminService.listMailings(query);
  }

  // ─── Meetings (admin-wide) ────────────────────────────────

  @Get('meetings')
  @ApiOperation({ summary: 'List all meetings (admin/manager)' })
  async listAllMeetings(@Query() query: any) {
    return this.adminService.listAllMeetings(query);
  }

  @Patch('meetings/:id/status')
  @ApiOperation({ summary: 'Confirm or cancel a meeting (admin/manager)' })
  async updateMeetingStatus(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
    @Body() body: { status: 'PENDING' | 'CONFIRMED' | 'COMPLETED' | 'CANCELLED' },
  ) {
    return this.adminService.updateMeetingStatus(id, body.status, user.id);
  }
}
