import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
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

  @Get('projects/:slug')
  async projectBySlug(@Param('slug') slug: string) {
    return this.cms.getProjectBySlug(slug);
  }

  @Get('promos')
  @ApiOperation({ summary: 'Active promo slider items' })
  async promos() {
    return this.cms.listPromos(true);
  }

  @Get('news')
  @ApiOperation({ summary: 'Active news cards' })
  async news() {
    return this.cms.listNews(true);
  }

  @Post('contact')
  @ApiOperation({ summary: 'Submit contact / lead form (public)' })
  async submitContact(@Body() body: any, @Req() req: Request) {
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
      || req.socket.remoteAddress
      || null;
    const ua = (req.headers['user-agent'] as string) || null;
    const created = await this.cms.createContactRequest(
      {
        name: body?.name,
        phone: body?.phone,
        email: body?.email,
        message: body?.message,
        source: body?.source || 'landing-contact',
        eventId: body?.eventId,
      },
      ip,
      ua,
    );
    return { ok: true, id: created.id };
  }
}
