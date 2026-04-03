import { Controller, Get, Post, Param, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { DocumentsService } from './documents.service';
import { UserRole } from '@st-michael/shared';

@ApiTags('documents')
@Controller('documents')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  @Get()
  @ApiOperation({ summary: 'Get documents' })
  @ApiResponse({ status: 200, description: 'Paginated list of documents' })
  async getDocuments(@Query() query: any) {
    return this.documentsService.getDocuments(query);
  }

  @Get('external')
  @ApiOperation({ summary: 'Get documents from external broker page' })
  @ApiResponse({ status: 200, description: 'List of external documents' })
  async getExternalDocuments() {
    return this.documentsService.getExternalDocuments();
  }

  @Get(':id/download')
  @ApiOperation({ summary: 'Get document download URL' })
  @ApiResponse({ status: 200, description: 'Presigned download URL' })
  async downloadDocument(@Param('id') id: string) {
    return this.documentsService.getDownloadUrl(id);
  }

  @Post('upload-url')
  @UseGuards(RolesGuard)
  @Roles(UserRole.MANAGER, UserRole.ADMIN)
  @ApiOperation({ summary: 'Get upload URL (manager only)' })
  @ApiResponse({ status: 201, description: 'Presigned upload URL' })
  async getUploadUrl(@Body() body: { name: string; type: string; category: string; project?: string }) {
    return this.documentsService.getUploadUrl(body);
  }
}
