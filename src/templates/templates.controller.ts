import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { SessionGuard } from '../auth/session.guard';
import type { SessionUser } from '../auth/session.serializer';
import { GuildsService } from '../dashboard/guilds.service';
import {
  type CreateTemplateDto,
  type UpdateTemplateDto,
  TemplatesService,
} from './templates.service';

@Controller('api/guilds/:guildId/templates')
@UseGuards(SessionGuard)
export class TemplatesController {
  constructor(
    private readonly templates: TemplatesService,
    private readonly guilds: GuildsService,
  ) {}

  private getUser(req: Request): SessionUser {
    const user = (req as Request & { user?: SessionUser }).user;
    if (!user?.accessToken) throw new UnauthorizedException('Not logged in');
    return user;
  }

  private async ensureGuildAccess(guildId: string, accessToken: string): Promise<void> {
    const list = await this.guilds.getUserGuilds(accessToken);
    if (!list.some((g) => g.id === guildId)) throw new ForbiddenException('No access to this guild');
  }

  @Post()
  async create(
    @Param('guildId') guildId: string,
    @Body() dto: CreateTemplateDto,
    @Req() req: Request,
  ) {
    const user = this.getUser(req);
    await this.ensureGuildAccess(guildId, user.accessToken);
    return this.templates.create(guildId, dto);
  }

  @Get()
  async list(@Param('guildId') guildId: string, @Req() req: Request) {
    const user = this.getUser(req);
    await this.ensureGuildAccess(guildId, user.accessToken);
    return this.templates.findAllByGuild(guildId);
  }

  @Get(':id')
  async getOne(
    @Param('guildId') guildId: string,
    @Param('id') id: string,
    @Req() req: Request,
  ) {
    const user = this.getUser(req);
    await this.ensureGuildAccess(guildId, user.accessToken);
    return this.templates.findOne(guildId, id);
  }

  @Patch(':id')
  async update(
    @Param('guildId') guildId: string,
    @Param('id') id: string,
    @Body() dto: UpdateTemplateDto,
    @Req() req: Request,
  ) {
    const user = this.getUser(req);
    await this.ensureGuildAccess(guildId, user.accessToken);
    return this.templates.update(guildId, id, dto);
  }

  @Delete(':id')
  async remove(
    @Param('guildId') guildId: string,
    @Param('id') id: string,
    @Req() req: Request,
  ) {
    const user = this.getUser(req);
    await this.ensureGuildAccess(guildId, user.accessToken);
    await this.templates.remove(guildId, id);
    return { ok: true };
  }

  @Post(':id/send')
  async sendFromTemplate(
    @Param('guildId') guildId: string,
    @Param('id') id: string,
    @Body() body: { channelId: string },
    @Req() req: Request,
  ) {
    const user = this.getUser(req);
    await this.ensureGuildAccess(guildId, user.accessToken);
    if (!body.channelId) throw new UnauthorizedException('channelId required');
    const template = await this.templates.findOne(guildId, id);
    await this.guilds.sendMessage(guildId, body.channelId, {
      title: template.title ?? undefined,
      description: template.description ?? undefined,
      image: template.image ?? undefined,
    });
    return { ok: true };
  }
}
