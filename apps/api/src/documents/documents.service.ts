import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@st-michael/database';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

@Injectable()
export class DocumentsService {
  private s3: S3Client;
  private bucket: string;

  constructor(@Inject('PrismaClient') private prisma: PrismaClient) {
    this.bucket = process.env.S3_BUCKET || 'st-michael-docs';
    this.s3 = new S3Client({
      region: process.env.S3_REGION || 'ru-central1',
      endpoint: process.env.S3_ENDPOINT || 'https://storage.yandexcloud.net',
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY || '',
        secretAccessKey: process.env.S3_SECRET_KEY || '',
      },
      forcePathStyle: true,
    });
  }

  async getDocuments(filters: {
    category?: string;
    project?: string;
    page?: number;
    limit?: number;
  }) {
    const page = filters.page || 1;
    const limit = filters.limit || 20;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (filters.category) where.category = filters.category;
    if (filters.project) where.project = filters.project;

    const [documents, total] = await Promise.all([
      this.prisma.document.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.document.count({ where }),
    ]);

    return {
      documents,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getDownloadUrl(id: string) {
    const document = await this.prisma.document.findUnique({ where: { id } });
    if (!document) throw new NotFoundException('Document not found');

    // If S3 credentials are configured, generate presigned URL
    if (process.env.S3_ACCESS_KEY && document.fileUrl.startsWith('s3://')) {
      const key = document.fileUrl.replace(`s3://${this.bucket}/`, '');
      const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
      const url = await getSignedUrl(this.s3, command, { expiresIn: 3600 });
      return { url, name: document.name, type: document.type };
    }

    // Fallback to direct URL
    return { url: document.fileUrl, name: document.name, type: document.type };
  }

  async getUploadUrl(data: { name: string; type: string; category: string; project?: string }) {
    const key = `documents/${data.category}/${Date.now()}-${data.name}`;
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: data.type,
    });

    const uploadUrl = await getSignedUrl(this.s3, command, { expiresIn: 3600 });

    // Create document record
    const document = await this.prisma.document.create({
      data: {
        name: data.name,
        type: data.type,
        category: data.category,
        project: data.project as any,
        fileUrl: `s3://${this.bucket}/${key}`,
      },
    });

    return { uploadUrl, document };
  }
}
