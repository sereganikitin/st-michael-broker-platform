import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { CmsService } from './cms.service';

@ApiTags('public-cms')
@Controller('public/cms')
export class PublicCmsController {
  constructor(private readonly cms: CmsService) {}

  @Get('content')
  @ApiOperation({ summary: 'All landing content blocks (with defaults if missing)' })
  async allContent() {
    return this.cms.getAllContent();
  }

  @Get('content/:key')
  async oneBlock(@Param('key') key: string) {
    return { key, value: await this.cms.getContent(key) };
  }

  @Get('events')
  @ApiOperation({ summary: 'Active landing events (defaults to upcoming only)' })
  async events(@Query('all') all?: string) {
    const onlyFuture = all !== '1' && all !== 'true';
    return this.cms.listEvents({ onlyActive: true, onlyFuture });
  }

  @Get('projects')
  @ApiOperation({ summary: 'Active landing projects' })
  async projects() {
    return this.cms.listProjects(true);
  }
}
