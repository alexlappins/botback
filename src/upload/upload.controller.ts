import { BadRequestException, Controller, Post, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { randomUUID } from 'crypto';
import { extname, join } from 'path';
import { unlinkSync } from 'fs';
import { CustomerGuard } from '../auth/customer.guard';
import { SessionGuard } from '../auth/session.guard';

const UPLOAD_SUBDIR = 'uploads';
const MAX_BYTES = 8 * 1024 * 1024;
const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp']);

function uploadsDir(): string {
  return join(process.cwd(), UPLOAD_SUBDIR);
}

@Controller('api/uploads')
@UseGuards(SessionGuard, CustomerGuard)
export class UploadController {
  constructor(private readonly config: ConfigService) {}

  @Post()
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: uploadsDir(),
        filename: (_req, file, cb) => {
          const ext = extname(file.originalname || '').toLowerCase();
          cb(null, `${randomUUID()}${ext || ''}`);
        },
      }),
      limits: { fileSize: MAX_BYTES },
    }),
  )
  upload(@UploadedFile() file: Express.Multer.File | undefined) {
    if (!file) throw new BadRequestException('A file is required in the "file" field (multipart/form-data)');
    if (!ALLOWED_MIME.has(file.mimetype)) {
      try {
        unlinkSync(file.path);
      } catch {
        /* ignore */
      }
      throw new BadRequestException('Only images are allowed: PNG, JPEG, GIF, WebP');
    }

    const port = this.config.get<string>('PORT') ?? '3000';
    const base =
      this.config.get<string>('PUBLIC_BASE_URL')?.replace(/\/$/, '') ?? `http://localhost:${port}`;
    const publicPath = `/${UPLOAD_SUBDIR}/${file.filename}`;
    return {
      url: `${base}${publicPath}`,
      path: publicPath,
      filename: file.filename,
      mimetype: file.mimetype,
    };
  }
}
