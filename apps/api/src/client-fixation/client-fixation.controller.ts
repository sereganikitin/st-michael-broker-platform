import { Controller, Post, Get, Patch, Body, Param, UseGuards, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser, CurrentUserPayload } from '../auth/current-user.decorator';
import { ClientFixationService } from './client-fixation.service';
import {
  fixClientDtoSchema,
  extendUniquenessDtoSchema,
  resolveUniquenessDtoSchema,
  paginationQuerySchema,
} from '@st-michael/shared';
import { UserRole, UniquenessStatus, Project } from '@st-michael/shared';

@ApiTags('clients')
@Controller('clients')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class ClientFixationController {
  constructor(private readonly clientFixationService: ClientFixationService) {}

  @Post('fix')
  @ApiOperation({ summary: 'Fix client uniqueness' })
  @ApiResponse({ status: 201, description: 'Client fixed successfully' })
  async fixClient(@CurrentUser() user: CurrentUserPayload, @Body() body: unknown) {
    const data = fixClientDtoSchema.parse(body) as {
      phone: string;
      fullName: string;
      comment?: string;
      project: Project;
      agencyInn: string;
    };
    return this.clientFixationService.fixClient(user.id, data);
  }

  @Get()
  @ApiOperation({ summary: 'Get broker clients' })
  @ApiResponse({ status: 200, description: 'List of clients' })
  async getClients(@CurrentUser() user: CurrentUserPayload, @Query() query: any) {
    const pagination = paginationQuerySchema.parse(query);
    return this.clientFixationService.getClients(user.id, {
      ...pagination,
      status: query.status,
      project: query.project,
      search: query.search,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get client details' })
  @ApiResponse({ status: 200, description: 'Client details' })
  async getClient(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string) {
    return this.clientFixationService.getClient(id, user.id);
  }

  @Post(':id/extend')
  @ApiOperation({ summary: 'Extend uniqueness period' })
  @ApiResponse({ status: 200, description: 'Uniqueness extended' })
  async extendUniqueness(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const data = extendUniquenessDtoSchema.parse(body) as { reason: string; comment?: string };
    return this.clientFixationService.extendUniqueness(id, user.id, data);
  }

  @Patch(':id/fix')
  @ApiOperation({ summary: 'Mark client as fixed' })
  @ApiResponse({ status: 200, description: 'Client marked as fixed' })
  async markFixed(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string) {
    return this.clientFixationService.markFixed(id, user.id);
  }

  @Patch(':id/resolve')
  @UseGuards(RolesGuard)
  @Roles(UserRole.MANAGER, UserRole.ADMIN)
  @ApiOperation({ summary: 'Resolve uniqueness conflict (manager only)' })
  @ApiResponse({ status: 200, description: 'Conflict resolved' })
  async resolveUniqueness(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const data = resolveUniquenessDtoSchema.parse(body) as { status: UniquenessStatus; reason: string };
    return this.clientFixationService.resolveUniqueness(id, user.id, data);
  }
}
