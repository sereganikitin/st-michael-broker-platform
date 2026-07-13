import {
  Body, Controller, Delete, Get, Param, Patch, Post, Query, UploadedFile, UploadedFiles, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiConsumes } from '@nestjs/swagger';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '@st-michael/shared';
import { DocumentsService } from './documents.service';

@ApiTags('admin-documents')
@Controller('admin/documents')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.MANAGER)
@ApiBearerAuth()
export class DocumentsAdminController {
  constructor(private readonly documentsService: DocumentsService) {}

  @Get()
  async list(@Query() query: any) {
    return this.documentsService.getDocuments(query);
  }

  // ─── Folders (папки Материалов) ────────────────────────────────

  @Get('folders')
  @ApiOperation({ summary: 'Список папок Материалов (для админки)' })
  async listFolders(@Query('include') include?: string) {
    return this.documentsService.listFolders({
      includeDocuments: include === 'documents' || include === 'all',
    });
  }

  @Post('folders')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Создать папку' })
  async createFolder(@Body() body: any) {
    return this.documentsService.createFolder(body);
  }

  @Patch('folders/reorder')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Пересортировать папки: [{id, sortOrder}, ...]' })
  async reorderFolders(@Body() body: { items: Array<{ id: string; sortOrder: number }> }) {
    return this.documentsService.reorderFolders(body?.items || []);
  }

  @Patch('folders/:id')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Обновить папку (имя/флаги/обложка/URL)' })
  async updateFolder(@Param('id') id: string, @Body() body: any) {
    return this.documentsService.updateFolder(id, body);
  }

  @Delete('folders/:id')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Удалить папку. deleteDocuments=true — удаляет и файлы, иначе отвязывает.' })
  async deleteFolder(@Param('id') id: string, @Query('deleteDocuments') deleteDocuments?: string) {
    return this.documentsService.deleteFolder(id, {
      deleteDocuments: deleteDocuments === 'true' || deleteDocuments === '1',
    });
  }

  @Post('folders/:id/icon')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Загрузить обложку папки' })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  async uploadFolderIcon(@Param('id') id: string, @UploadedFile() file: Express.Multer.File) {
    return this.documentsService.uploadFolderIcon(file, id);
  }

  @Patch('folders/:id/documents/reorder')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Пересортировать файлы внутри папки: [{id, sortOrder}, ...]' })
  async reorderDocumentsInFolder(
    @Param('id') id: string,
    @Body() body: { items: Array<{ id: string; sortOrder: number }> },
  ) {
    return this.documentsService.reorderDocumentsInFolder(id, body?.items || []);
  }

  // ─── Documents ─────────────────────────────────────────────────

  @Post('upload')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Upload file (multipart) to local storage' })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 200 * 1024 * 1024 } }))
  async upload(@UploadedFile() file: Express.Multer.File, @Body() body: any) {
    return this.documentsService.uploadFile(file, {
      name: body.name,
      description: body.description,
      category: body.category,
      subcategory: body.subcategory,
      folderId: body.folderId,
      project: body.project,
      isPublic: body.isPublic === 'true' || body.isPublic === true,
      sortOrder: body.sortOrder,
    });
  }

  @Post('upload-multi')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Массовая загрузка файлов в папку' })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FilesInterceptor('files', 50, { limits: { fileSize: 200 * 1024 * 1024 } }))
  async uploadMulti(@UploadedFiles() files: Express.Multer.File[], @Body() body: any) {
    return this.documentsService.uploadMultiple(files, {
      category: body.category,
      folderId: body.folderId,
      subcategory: body.subcategory,
      project: body.project,
      isPublic: body.isPublic === 'true' || body.isPublic === true,
    });
  }

  @Post('external')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Add external link as a document' })
  async createExternal(@Body() body: any) {
    return this.documentsService.createExternal(body);
  }

  @Patch(':id')
  @Roles(UserRole.ADMIN)
  async update(@Param('id') id: string, @Body() body: any) {
    return this.documentsService.updateDocument(id, body);
  }

  @Delete(':id')
  @Roles(UserRole.ADMIN)
  async remove(@Param('id') id: string) {
    return this.documentsService.deleteDocument(id);
  }
}
