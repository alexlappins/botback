import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Request } from 'express';
import { Repository } from 'typeorm';
import { AdminGuard } from '../auth/admin.guard';
import { CustomerGuard } from '../auth/customer.guard';
import { SessionGuard } from '../auth/session.guard';
import type { SessionUser } from '../auth/session.serializer';
import { ServerTemplate } from './entities/server-template.entity';
import { UserTemplateAccess } from './entities/user-template-access.entity';

@Controller('api/my/server-templates')
@UseGuards(SessionGuard, CustomerGuard)
export class TemplateAccessController {
  constructor(
    @InjectRepository(UserTemplateAccess)
    private readonly accessRepo: Repository<UserTemplateAccess>,
    @InjectRepository(ServerTemplate)
    private readonly templateRepo: Repository<ServerTemplate>,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
  @Header('Pragma', 'no-cache')
  async myTemplates(@Req() req: Request) {
    const user = (req as Request & { user: SessionUser }).user;
    if (user.role === 'admin') {
      const list = await this.templateRepo.find({
        order: { createdAt: 'DESC' },
        select: ['id', 'name', 'description', 'discordTemplateUrl', 'iconUrl', 'createdAt'],
      });
      // Admin gets all templates without access metadata
      return list.map((t) => ({ ...t, access: null }));
    }

    const rows = await this.accessRepo.find({ where: { userId: user.id } });
    const ids = rows.map((r) => r.templateId);
    if (!ids.length) return [];
    const templates = await this.templateRepo.find({
      where: ids.map((id) => ({ id })),
      select: ['id', 'name', 'description', 'discordTemplateUrl', 'iconUrl', 'createdAt'],
      order: { createdAt: 'DESC' },
    });
    const accessByTemplate = new Map(rows.map((r) => [r.templateId, r]));
    return templates.map((t) => {
      const a = accessByTemplate.get(t.id);
      return {
        ...t,
        access: a
          ? {
              grantedAt: a.grantedAt,
              installedAt: a.installedAt,
              installedGuildId: a.installedGuildId,
              usageType: a.usageType,
              pricePaid: a.pricePaid,
              currency: a.currency,
            }
          : null,
      };
    });
  }
}

@Controller('api/admin/template-access')
@UseGuards(SessionGuard, AdminGuard)
export class TemplateAccessAdminController {
  constructor(
    @InjectRepository(UserTemplateAccess)
    private readonly accessRepo: Repository<UserTemplateAccess>,
  ) {}

  @Post()
  async grant(@Body() body: { userId: string; templateId: string }) {
    const userId = body?.userId?.trim();
    const templateId = body?.templateId?.trim();
    if (!userId || !templateId) throw new BadRequestException('userId and templateId required');
    const existing = await this.accessRepo.findOne({ where: { userId, templateId } });
    if (existing) return existing;
    const row = this.accessRepo.create({ userId, templateId });
    return this.accessRepo.save(row);
  }

  @Delete(':userId/:templateId')
  async revoke(@Param('userId') userId: string, @Param('templateId') templateId: string) {
    await this.accessRepo.delete({ userId, templateId });
    return { ok: true };
  }
}

