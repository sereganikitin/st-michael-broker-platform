import { Controller, Get, Post, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser, CurrentUserPayload } from '../auth/current-user.decorator';
import { AmocrmService } from './amocrm.service';

@ApiTags('amocrm')
@Controller('amocrm')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class AmocrmController {
  constructor(private readonly amocrmService: AmocrmService) {}

  @Post('sync-my-deals')
  @ApiOperation({ summary: 'Pull all deals/clients from amoCRM linked to current broker' })
  async syncMyDeals(@CurrentUser() user: CurrentUserPayload) {
    return this.amocrmService.syncMyDealsAndClients(user.id);
  }

  @Get('account')
  @ApiOperation({ summary: 'Get amoCRM account info (test connection)' })
  async getAccount() {
    return this.amocrmService.getAccount();
  }

  @Get('pipelines')
  @ApiOperation({ summary: 'Get all pipelines' })
  async getPipelines() {
    return this.amocrmService.getPipelines();
  }

  @Get('contact-fields')
  @ApiOperation({ summary: 'Get contact custom fields' })
  async getContactFields() {
    return this.amocrmService.getContactFields();
  }

  @Get('company-fields')
  @ApiOperation({ summary: 'Get company custom fields' })
  async getCompanyFields() {
    return this.amocrmService.getCompanyFields();
  }

  @Get('users')
  @ApiOperation({ summary: 'Get amoCRM users (managers/brokers)' })
  async getUsers() {
    return this.amocrmService.getUsers();
  }

  @Post('sync-broker-by-phone')
  @ApiOperation({ summary: 'Find broker contact in amoCRM by phone, return linked deals/clients' })
  async syncBroker(@Body() body: { phone: string; brokerId?: string; inn?: string }) {
    return this.amocrmService.syncBrokerByPhone(body.phone, body.brokerId, body.inn);
  }
}
