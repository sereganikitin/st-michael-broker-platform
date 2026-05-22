import { Body, Controller, Get, Header, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { CmsService } from './cms.service';

@ApiTags('public-cms')
@Controller('public/cms')
export class PublicCmsController {
  constructor(private readonly cms: CmsService) {}

  // Cache-Control: no-store — чтобы после правок в /admin/content
  // лендинг сразу видел свежие значения, без задержки от CDN/service worker.
  @Get('content')
  @ApiOperation({ summary: 'All landing content blocks (with defaults if missing)' })
  @Header('Cache-Control', 'no-store, no-cache, must-revalidate')
  async allContent() {
    return this.cms.getAllContent();
  }

  @Get('content/:key')
  @Header('Cache-Control', 'no-store, no-cache, must-revalidate')
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

  // ВРЕМЕННЫЙ debug-endpoint для разработки маппинга полей amoCRM.
  // Использует UUID-секрет в URL чтобы случайные люди не открыли. Будет
  // удалён после получения field_id для «От брокера» / «Планирует» /
  // «Готовность» / «Опросник» (коммит a30982a, todo: remove).
  @Get('_debug-amo-fields/7d3a8e9c-1b4f-4a2e-9c7d-f5e8b1a3c2d6')
  @Header('Cache-Control', 'no-store')
  async debugAmoFields() {
    const token = process.env.AMO_ACCESS_TOKEN;
    const subdomain = process.env.AMO_SUBDOMAIN || 'stmichael';
    const base = process.env.AMO_BASE_DOMAIN || 'amocrm.ru';
    if (!token) return { error: 'AMO_ACCESS_TOKEN not set' };

    const fetchAll = async (entity: 'leads' | 'contacts') => {
      const all: any[] = [];
      let url: string | null = `https://${subdomain}.${base}/api/v4/${entity}/custom_fields?limit=50`;
      while (url) {
        const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        if (!r.ok) {
          const txt = await r.text().catch(() => '');
          all.push({ __error: `${entity} HTTP ${r.status}: ${txt.slice(0, 200)}` });
          break;
        }
        const data: any = await r.json();
        const fields = data?._embedded?.custom_fields || [];
        all.push(...fields);
        url = data?._links?.next?.href || null;
      }
      return all;
    };

    const [leadFields, contactFields] = await Promise.all([
      fetchAll('leads'),
      fetchAll('contacts'),
    ]);

    // Уменьшим payload — оставим только нужное: id/name/type/code/enums
    const pick = (arr: any[]) => arr.map((f) => ({
      id: f.id,
      name: f.name,
      type: f.type,
      code: f.code,
      enums: f.enums?.map((e: any) => ({ id: e.id, value: e.value })) || undefined,
    }));

    return {
      leads: pick(leadFields),
      contacts: pick(contactFields),
    };
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
