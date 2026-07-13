import { Injectable, Inject, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaClient } from '@st-michael/database';
import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';

const UPLOADS_ROOT = process.env.UPLOADS_DIR || '/app/uploads';
const PUBLIC_PREFIX = '/files';
const VALID_CATEGORIES = new Set(['cooperation', 'analytics', 'marketing', 'materials']);

function serializeFolder(f: any, documents?: any[]) {
  return {
    id: f.id,
    name: f.name,
    sortOrder: f.sortOrder,
    showInCabinet: f.showInCabinet,
    showOnLanding: f.showOnLanding,
    iconUrl: f.iconUrl,
    folderUrl: f.folderUrl,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
    documentsCount: typeof f._count?.documents === 'number' ? f._count.documents : (documents?.length ?? 0),
    ...(documents ? { documents } : {}),
  };
}

@Injectable()
export class DocumentsService {
  constructor(@Inject('PrismaClient') private prisma: PrismaClient) {}

  async getDocuments(filters: {
    category?: string;
    subcategory?: string;
    folderId?: string;
    project?: string;
    onlyPublic?: boolean;
    page?: number;
    limit?: number;
  }) {
    const page = Number(filters.page) || 1;
    const limit = Number(filters.limit) || 100;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (filters.category) where.category = filters.category;
    if (filters.subcategory) where.subcategory = filters.subcategory;
    if (filters.folderId) where.folderId = filters.folderId;
    if (filters.project) where.project = filters.project;
    if (filters.onlyPublic) where.isPublic = true;

    const [documents, total] = await Promise.all([
      this.prisma.document.findMany({
        where,
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
        skip,
        take: limit,
        include: { folder: true },
      }),
      this.prisma.document.count({ where }),
    ]);

    return { documents, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  // ─── Material folders (папки в разделах «Материалы» кабинета и лендинга) ───

  async listFolders(opts: {
    onlyCabinet?: boolean;
    onlyLanding?: boolean;
    includeDocuments?: boolean;
    onlyPublicDocuments?: boolean;
  } = {}) {
    const where: any = {};
    if (opts.onlyCabinet) where.showInCabinet = true;
    if (opts.onlyLanding) where.showOnLanding = true;

    const folders = await this.prisma.materialFolder.findMany({
      where,
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: opts.includeDocuments
        ? {
            documents: {
              where: opts.onlyPublicDocuments ? { isPublic: true } : {},
              orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
            },
          }
        : { _count: { select: { documents: true } } },
    });

    return folders.map((f: any) => serializeFolder(f, opts.includeDocuments ? f.documents : undefined));
  }

  async createFolder(data: {
    name: string;
    sortOrder?: number;
    showInCabinet?: boolean;
    showOnLanding?: boolean;
    iconUrl?: string | null;
    folderUrl?: string | null;
  }) {
    const name = (data.name || '').trim();
    if (!name) throw new BadRequestException('name required');
    const existing = await this.prisma.materialFolder.findUnique({ where: { name } });
    if (existing) throw new BadRequestException(`Папка с названием "${name}" уже существует`);

    let sortOrder = Number(data.sortOrder);
    if (!Number.isFinite(sortOrder)) {
      const last = await this.prisma.materialFolder.findFirst({ orderBy: { sortOrder: 'desc' } });
      sortOrder = (last?.sortOrder || 0) + 10;
    }

    return this.prisma.materialFolder.create({
      data: {
        name,
        sortOrder,
        showInCabinet: data.showInCabinet !== false,
        showOnLanding: !!data.showOnLanding,
        iconUrl: data.iconUrl || null,
        folderUrl: data.folderUrl || null,
      },
    });
  }

  async updateFolder(id: string, patch: {
    name?: string;
    showInCabinet?: boolean;
    showOnLanding?: boolean;
    iconUrl?: string | null;
    folderUrl?: string | null;
    sortOrder?: number;
  }) {
    const current = await this.prisma.materialFolder.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('Folder not found');

    const data: any = {};
    if (patch.name !== undefined) {
      const name = String(patch.name).trim();
      if (!name) throw new BadRequestException('name cannot be empty');
      if (name !== current.name) {
        const dup = await this.prisma.materialFolder.findUnique({ where: { name } });
        if (dup) throw new BadRequestException(`Папка "${name}" уже существует`);
        data.name = name;
      }
    }
    if (patch.showInCabinet !== undefined) data.showInCabinet = !!patch.showInCabinet;
    if (patch.showOnLanding !== undefined) data.showOnLanding = !!patch.showOnLanding;
    if (patch.iconUrl !== undefined) data.iconUrl = patch.iconUrl || null;
    if (patch.folderUrl !== undefined) data.folderUrl = patch.folderUrl || null;
    if (patch.sortOrder !== undefined) data.sortOrder = Number(patch.sortOrder) || 0;

    const updated = await this.prisma.materialFolder.update({ where: { id }, data });

    // Синхронизируем legacy Document.subcategory у всех файлов папки, чтобы
    // старый код (кабинет /materials группирует по subcategory) продолжал
    // работать до полной миграции UI.
    if (data.name && data.name !== current.name) {
      await this.prisma.document.updateMany({
        where: { folderId: id },
        data: { subcategory: data.name },
      });
    }

    return updated;
  }

  async deleteFolder(id: string, opts: { deleteDocuments?: boolean } = {}) {
    const folder = await this.prisma.materialFolder.findUnique({
      where: { id },
      include: { documents: { select: { id: true, fileUrl: true } } },
    });
    if (!folder) throw new NotFoundException('Folder not found');

    if (opts.deleteDocuments) {
      for (const d of folder.documents) {
        if (d.fileUrl?.startsWith(PUBLIC_PREFIX + '/')) {
          const relPath = d.fileUrl.slice(PUBLIC_PREFIX.length + 1);
          const fullPath = path.join(UPLOADS_ROOT, relPath);
          if (path.resolve(fullPath).startsWith(path.resolve(UPLOADS_ROOT))) {
            await fs.unlink(fullPath).catch(() => {});
          }
        }
      }
      await this.prisma.document.deleteMany({ where: { folderId: id } });
    } else {
      // onDelete: SetNull автоматически обнулит folderId, но subcategory
      // тоже стоит очистить, чтобы файлы не «прилипли» к другой папке с тем
      // же именем при повторном создании.
      await this.prisma.document.updateMany({
        where: { folderId: id },
        data: { subcategory: null },
      });
    }

    await this.prisma.materialFolder.delete({ where: { id } });
    return { deleted: true, documentsDeleted: opts.deleteDocuments ? folder.documents.length : 0 };
  }

  async reorderFolders(items: Array<{ id: string; sortOrder: number }>) {
    if (!Array.isArray(items) || items.length === 0) return { updated: 0 };
    await this.prisma.$transaction(
      items.map((it) =>
        this.prisma.materialFolder.update({
          where: { id: it.id },
          data: { sortOrder: Number(it.sortOrder) || 0 },
        }),
      ),
    );
    return { updated: items.length };
  }

  async reorderDocumentsInFolder(folderId: string, items: Array<{ id: string; sortOrder: number }>) {
    if (!Array.isArray(items) || items.length === 0) return { updated: 0 };
    await this.prisma.$transaction(
      items.map((it) =>
        this.prisma.document.update({
          where: { id: it.id },
          data: { sortOrder: Number(it.sortOrder) || 0, folderId },
        }),
      ),
    );
    return { updated: items.length };
  }

  async uploadFolderIcon(file: Express.Multer.File, folderId: string) {
    if (!file) throw new BadRequestException('File required');
    const folder = await this.prisma.materialFolder.findUnique({ where: { id: folderId } });
    if (!folder) throw new NotFoundException('Folder not found');

    const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const ext = (path.extname(originalName) || '.png').toLowerCase();
    const fileName = `${randomUUID()}${ext}`;
    const targetDir = path.join(UPLOADS_ROOT, 'folder-icons');
    const targetPath = path.join(targetDir, fileName);

    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(targetPath, file.buffer);

    const iconUrl = `${PUBLIC_PREFIX}/folder-icons/${fileName}`;
    // Удаляем прежнюю обложку, если это был локальный файл
    if (folder.iconUrl?.startsWith(PUBLIC_PREFIX + '/')) {
      const relPath = folder.iconUrl.slice(PUBLIC_PREFIX.length + 1);
      const fullPath = path.join(UPLOADS_ROOT, relPath);
      if (path.resolve(fullPath).startsWith(path.resolve(UPLOADS_ROOT))) {
        await fs.unlink(fullPath).catch(() => {});
      }
    }
    return this.prisma.materialFolder.update({ where: { id: folderId }, data: { iconUrl } });
  }

  async getDocument(id: string) {
    const doc = await this.prisma.document.findUnique({ where: { id } });
    if (!doc) throw new NotFoundException('Document not found');
    return doc;
  }

  private async resolveFolderMeta(folderId: string | undefined | null) {
    if (!folderId) return { folder: null, subcategory: null as string | null };
    const folder = await this.prisma.materialFolder.findUnique({ where: { id: folderId } });
    if (!folder) throw new BadRequestException(`Папка ${folderId} не найдена`);
    return { folder, subcategory: folder.name };
  }

  async uploadFile(file: Express.Multer.File, meta: {
    name?: string;
    description?: string;
    category: string;
    subcategory?: string;
    folderId?: string;
    project?: string;
    isPublic?: boolean;
    sortOrder?: number;
  }) {
    if (!file) throw new BadRequestException('File required');
    if (!meta.category || !VALID_CATEGORIES.has(meta.category)) {
      throw new BadRequestException(`category must be one of: ${[...VALID_CATEGORIES].join(', ')}`);
    }

    const { folder, subcategory: folderName } = await this.resolveFolderMeta(meta.folderId);

    // Multer decodes multipart filename as latin-1; re-decode to UTF-8 so Cyrillic survives.
    const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const ext = (path.extname(originalName) || '').toLowerCase();
    const fileName = `${randomUUID()}${ext}`;
    const targetDir = path.join(UPLOADS_ROOT, meta.category);
    const targetPath = path.join(targetDir, fileName);

    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(targetPath, file.buffer);

    const fileUrl = `${PUBLIC_PREFIX}/${meta.category}/${fileName}`;
    const typeLabel = (ext.replace('.', '').toUpperCase()) || (file.mimetype.split('/')[1] || 'FILE').toUpperCase();

    return this.prisma.document.create({
      data: {
        name: meta.name?.trim() || originalName,
        description: meta.description || null,
        type: typeLabel,
        category: meta.category,
        subcategory: folder ? folderName : (meta.subcategory || null),
        folderId: folder?.id || null,
        project: (meta.project as any) || null,
        fileUrl,
        fileSize: file.size,
        isPublic: meta.isPublic !== false,
        sortOrder: Number(meta.sortOrder) || 0,
      },
    });
  }

  async uploadMultiple(files: Express.Multer.File[], meta: {
    category: string;
    folderId?: string;
    subcategory?: string;
    project?: string;
    isPublic?: boolean;
  }) {
    if (!Array.isArray(files) || files.length === 0) throw new BadRequestException('Files required');
    const results: any[] = [];
    // Стартовый sortOrder = максимум внутри целевой папки + 10, дальше по 10.
    let nextSort = 0;
    if (meta.folderId) {
      const last = await this.prisma.document.findFirst({
        where: { folderId: meta.folderId },
        orderBy: { sortOrder: 'desc' },
        select: { sortOrder: true },
      });
      nextSort = (last?.sortOrder || 0) + 10;
    }
    for (const file of files) {
      const doc = await this.uploadFile(file, {
        category: meta.category,
        folderId: meta.folderId,
        subcategory: meta.subcategory,
        project: meta.project,
        isPublic: meta.isPublic,
        sortOrder: nextSort,
      });
      results.push(doc);
      nextSort += 10;
    }
    return { uploaded: results.length, documents: results };
  }

  async createExternal(meta: {
    name: string;
    description?: string;
    url: string;
    category: string;
    subcategory?: string;
    folderId?: string;
    project?: string;
    isPublic?: boolean;
    sortOrder?: number;
  }) {
    if (!meta.url) throw new BadRequestException('url required');
    if (!meta.category || !VALID_CATEGORIES.has(meta.category)) {
      throw new BadRequestException(`category must be one of: ${[...VALID_CATEGORIES].join(', ')}`);
    }

    const { folder, subcategory: folderName } = await this.resolveFolderMeta(meta.folderId);

    return this.prisma.document.create({
      data: {
        name: meta.name,
        description: meta.description || null,
        type: 'URL',
        category: meta.category,
        subcategory: folder ? folderName : (meta.subcategory || null),
        folderId: folder?.id || null,
        project: (meta.project as any) || null,
        fileUrl: meta.url,
        isPublic: meta.isPublic !== false,
        sortOrder: Number(meta.sortOrder) || 0,
      },
    });
  }

  async updateDocument(id: string, patch: any) {
    const data: any = {};
    for (const k of ['name', 'description', 'category', 'subcategory'] as const) {
      if (patch[k] !== undefined) data[k] = patch[k] || null;
    }
    if (data.name === null) delete data.name;
    if (patch.isPublic !== undefined) data.isPublic = !!patch.isPublic;
    if (patch.sortOrder !== undefined) data.sortOrder = Number(patch.sortOrder) || 0;
    if (patch.category && !VALID_CATEGORIES.has(patch.category)) {
      throw new BadRequestException(`Invalid category`);
    }
    if (patch.folderId !== undefined) {
      if (patch.folderId === null || patch.folderId === '') {
        data.folderId = null;
      } else {
        const { folder, subcategory: folderName } = await this.resolveFolderMeta(patch.folderId);
        data.folderId = folder!.id;
        // subcategory синхронизируется с именем папки, чтобы старый группировщик по строке продолжал работать
        if (patch.subcategory === undefined) data.subcategory = folderName;
      }
    }
    return this.prisma.document.update({ where: { id }, data });
  }

  async deleteDocument(id: string) {
    const doc = await this.prisma.document.findUnique({ where: { id } });
    if (!doc) throw new NotFoundException('Document not found');

    // If it's a local file, try to unlink it (best-effort)
    if (doc.fileUrl.startsWith(PUBLIC_PREFIX + '/')) {
      const relPath = doc.fileUrl.slice(PUBLIC_PREFIX.length + 1);
      const fullPath = path.join(UPLOADS_ROOT, relPath);
      // safety check: ensure path is inside UPLOADS_ROOT
      if (path.resolve(fullPath).startsWith(path.resolve(UPLOADS_ROOT))) {
        await fs.unlink(fullPath).catch(() => {});
      }
    }

    await this.prisma.document.delete({ where: { id } });
    return { deleted: true };
  }

  async getDownloadUrl(id: string) {
    const doc = await this.getDocument(id);
    return { url: doc.fileUrl, name: doc.name, type: doc.type };
  }

  /**
   * Legacy compatibility — old broker page scraper.
   */
  async getExternalDocuments() {
    const BROKER_PAGE = process.env.BROKER_DOCS_URL || 'https://old.zorge9.com/broker/index.html';
    try {
      const res = await fetch(BROKER_PAGE);
      if (!res.ok) return { documents: [], source: BROKER_PAGE, fetchedAt: new Date().toISOString() };
      const html = await res.text();

      const docs: { name: string; url: string; type: string }[] = [];
      const linkRegex = /<a[^>]+href=["']([^"']*files\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
      let match;
      while ((match = linkRegex.exec(html)) !== null) {
        const href = match[1];
        const rawText = match[2].replace(/<[^>]+>/g, '').trim();
        if (!rawText || !href) continue;
        const url = href.startsWith('http') ? href : 'https://old.zorge9.com/' + href.replace(/^\.?\/?/, '');
        const ext = (href.split('.').pop() || '').toLowerCase();
        const type = ext === 'pdf' ? 'PDF' : ext === 'docx' ? 'DOCX' : ext === 'xlsx' ? 'XLSX' : ext.toUpperCase();
        docs.push({ name: rawText, url, type });
      }

      return { documents: docs, source: BROKER_PAGE, fetchedAt: new Date().toISOString() };
    } catch {
      return { documents: [], source: BROKER_PAGE, fetchedAt: new Date().toISOString() };
    }
  }
}
