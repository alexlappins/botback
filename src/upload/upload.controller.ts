import { BadRequestException, Controller, Post, Req, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
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
  upload(@UploadedFile() file: Express.Multer.File | undefined, @Req() req: Request) {
    if (!file) throw new BadRequestException('A file is required in the "file" field (multipart/form-data)');
    if (!ALLOWED_MIME.has(file.mimetype)) {
      try {
        unlinkSync(file.path);
      } catch {
        /* ignore */
      }
      throw new BadRequestException('Only images are allowed: PNG, JPEG, GIF, WebP');
    }

    // The returned URL must be reachable by BOTH the admin's browser (preview)
    // and Discord's servers (embed images) — i.e. absolute and public. The old
    // fallback was http://localhost:<port>, which broke previews and made
    // Discord reject the embed whenever PUBLIC_BASE_URL wasn't configured.
    // Now: explicit PUBLIC_BASE_URL wins; otherwise derive from the request
    // (with `trust proxy` set in main.ts this yields the real https origin
    // behind nginx/caddy).
    const derived = `${req.protocol}://${req.get('host') ?? `localhost:${this.config.get<string>('PORT') ?? '3000'}`}`;
    const base = this.config.get<string>('PUBLIC_BASE_URL')?.replace(/\/$/, '') ?? derived;
    const publicPath = `/${UPLOAD_SUBDIR}/${file.filename}`;
    return {
      url: `${base}${publicPath}`,
      path: publicPath,
      filename: file.filename,
      mimetype: file.mimetype,
    };
  }
}
