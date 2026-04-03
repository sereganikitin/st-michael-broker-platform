import { Injectable, Inject, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaClient } from '@st-michael/database';
import { XMLParser } from 'fast-xml-parser';

const FEEDS = [
  {
    url: process.env.PROFITBASE_FEED_ZORGE || 'https://pb7828.profitbase.ru/export/profitbase_xml/cccbe8c77d59ace56d69e0b05cb11ced?scheme=https',
    project: 'ZORGE9',
  },
  {
    url: process.env.PROFITBASE_FEED_SILVER || 'https://pb7828.profitbase.ru/export/profitbase_xml/9829a3c5d6882f1a1cb12906ee9025ee?scheme=https',
    project: 'SILVER_BOR',
  },
];

@Injectable()
export class CatalogService {
  constructor(@Inject('PrismaClient') private prisma: PrismaClient) {}

  async syncFromFeed() {
    let totalCreated = 0;
    let totalUpdated = 0;
    let totalSkipped = 0;
    let totalOffers = 0;

    for (const feed of FEEDS) {
      const result = await this.syncSingleFeed(feed.url, feed.project);
      totalCreated += result.created;
      totalUpdated += result.updated;
      totalSkipped += result.skipped;
      totalOffers += result.total;
    }

    return { created: totalCreated, updated: totalUpdated, skipped: totalSkipped, total: totalOffers };
  }

  private async syncSingleFeed(feedUrl: string, defaultProject: string) {
    const res = await fetch(feedUrl);
    if (!res.ok) throw new BadRequestException(`Feed fetch failed: ${res.status}`);

    const xml = await res.text();
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      isArray: (name) => name === 'offer' || name === 'image' || name === 'custom-field' || name === 'special-offer',
    });
    const parsed = parser.parse(xml);
    const offers = parsed?.['realty-feed']?.offer || [];

    let created = 0;
    let updated = 0;
    let skipped = 0;

    for (const offer of offers) {
      const externalId = String(offer['@_internal-id'] || '');
      if (!externalId) { skipped++; continue; }

      const status = this.mapStatus(offer.status);
      const rooms = this.mapRooms(offer.rooms, offer.studio);
      const sqm = Number(offer?.area?.value || 0);
      const price = Number(offer?.price?.value || 0);
      const pricePerSqm = Number(offer?.['price-meter']?.value || (sqm > 0 ? Math.round(price / sqm) : 0));

      const projectName = offer?.object?.name || '';
      const project = this.mapProject(projectName) || defaultProject;

      const propertyType = offer?.property_type || null;
      const images = Array.isArray(offer.image) ? offer.image : offer.image ? [offer.image] : [];
      const planImage = images.find((img: any) => (img?.['@_type'] || '') === 'plan');
      const planImageUrl = typeof planImage === 'string' ? planImage : planImage?.['#text'] || null;

      const data = {
        number: String(offer.number || ''),
        project: project as any,
        building: offer?.house?.name || '',
        floor: Number(offer.floor || 0),
        rooms,
        sqm,
        price,
        pricePerSqm,
        status: status as any,
        propertyType,
        layoutUrl: null as string | null,
        planImageUrl,
        description: offer?.['window-view'] || null,
        floorsTotal: Number(offer?.house?.['floors-total'] || 0) || null,
        buildingSection: offer?.['building-section'] ? String(offer['building-section']) : null,
        windowView: offer?.['window-view'] || null,
      };

      try {
        const existing = await this.prisma.lot.findUnique({ where: { externalId } });
        if (existing) {
          await this.prisma.lot.update({ where: { externalId }, data });
          updated++;
        } else {
          await this.prisma.lot.create({ data: { ...data, externalId } });
          created++;
        }
      } catch {
        skipped++;
      }
    }

    return { created, updated, skipped, total: offers.length };
  }


  private mapStatus(status: string): string {
    const s = (status || '').toUpperCase();
    if (s === 'AVAILABLE' || s === 'FREE') return 'AVAILABLE';
    if (s === 'BOOKED' || s === 'RESERVED') return 'BOOKED';
    if (s === 'SOLD') return 'SOLD';
    if (s === 'UNAVAILABLE') return 'SOLD';
    return 'AVAILABLE';
  }

  private mapRooms(rooms: any, studio: any): string {
    if (String(studio) === '1') return 'Студия';
    if (!rooms && rooms !== 0) return 'Студия';
    return String(rooms);
  }

  private mapProject(name: string): string {
    const n = name.toLowerCase();
    if (n.includes('зорге') || n.includes('zorge')) return 'ZORGE9';
    if (n.includes('серебр') || n.includes('silver')) return 'SILVER_BOR';
    return 'ZORGE9';
  }

  async getLots(filters: {
    project?: string;
    status?: string;
    rooms?: string;
    floor?: number;
    priceMin?: number;
    priceMax?: number;
    sqmMin?: number;
    sqmMax?: number;
    building?: string;
    propertyType?: string;
    page?: number;
    limit?: number;
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
  }) {
    const page = Number(filters.page) || 1;
    const limit = Number(filters.limit) || 20;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (filters.project) where.project = filters.project;
    if (filters.status) where.status = filters.status;
    else where.status = { not: 'SOLD' };
    if (filters.rooms) where.rooms = filters.rooms;
    if (filters.building) where.building = filters.building;
    if (filters.floor) where.floor = Number(filters.floor);
    if (filters.propertyType) {
      where.propertyType = { contains: filters.propertyType, mode: 'insensitive' };
    }

    if (filters.priceMin || filters.priceMax) {
      where.price = {};
      if (filters.priceMin) where.price.gte = Number(filters.priceMin);
      if (filters.priceMax) where.price.lte = Number(filters.priceMax);
    }

    if (filters.sqmMin || filters.sqmMax) {
      where.sqm = {};
      if (filters.sqmMin) where.sqm.gte = Number(filters.sqmMin);
      if (filters.sqmMax) where.sqm.lte = Number(filters.sqmMax);
    }

    const orderBy: any = {};
    orderBy[filters.sortBy || 'price'] = filters.sortOrder || 'asc';

    const [lots, total] = await Promise.all([
      this.prisma.lot.findMany({ where, skip, take: limit, orderBy }),
      this.prisma.lot.count({ where }),
    ]);

    // Get distinct property types for filters
    const propertyTypes = await this.prisma.lot.groupBy({
      by: ['propertyType'],
      where: { propertyType: { not: null } },
      _count: true,
    });

    // Get distinct projects
    const projects = await this.prisma.lot.groupBy({
      by: ['project'],
      _count: true,
    });

    return {
      lots,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      filters: {
        propertyTypes: propertyTypes.map((p) => ({
          type: p.propertyType,
          count: p._count,
        })),
        projects: projects.map((p) => ({
          project: p.project,
          count: p._count,
        })),
      },
    };
  }

  async getLot(id: string) {
    const lot = await this.prisma.lot.findUnique({
      where: { id },
      include: {
        deals: {
          select: { id: true, status: true, createdAt: true },
          where: { status: { not: 'CANCELLED' } },
        },
      },
    });

    if (!lot) throw new NotFoundException('Lot not found');
    return lot;
  }

  async getAvailableRooms(project?: string) {
    const where: any = { status: 'AVAILABLE' };
    if (project) where.project = project;

    const lots = await this.prisma.lot.groupBy({
      by: ['rooms'],
      where,
      _count: true,
      _min: { price: true },
      _max: { price: true },
    });

    return lots.map((g) => ({
      rooms: g.rooms,
      count: g._count,
      priceMin: Number(g._min.price),
      priceMax: Number(g._max.price),
    }));
  }

  async getStats() {
    const [total, available, booked, sold] = await Promise.all([
      this.prisma.lot.count(),
      this.prisma.lot.count({ where: { status: 'AVAILABLE' } }),
      this.prisma.lot.count({ where: { status: 'BOOKED' } }),
      this.prisma.lot.count({ where: { status: 'SOLD' } }),
    ]);

    const byProject = await this.prisma.lot.groupBy({
      by: ['project'],
      _count: true,
      _avg: { price: true },
    });

    return {
      total,
      available,
      booked,
      sold,
      byProject: byProject.map((p) => ({
        project: p.project,
        count: p._count,
        avgPrice: Math.round(Number(p._avg.price || 0)),
      })),
    };
  }
}
