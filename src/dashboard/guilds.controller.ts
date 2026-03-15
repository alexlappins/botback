import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { SessionGuard } from '../auth/session.guard';
import type { SessionUser } from '../auth/session.serializer';
import type { LogChannelsConfig } from '../common/storage/guild-storage.service';
import { GuildStorageService } from '../common/storage/guild-storage.service';
import { LogEventsService } from '../logs/log-events.service';
import { TemplateInstallService } from '../server-templates/template-install.service';
import { GuildsService } from './guilds.service';

const LOG_TYPES: (keyof LogChannelsConfig)[] = [
  'joinLeave',
  'messages',
  'moderation',
  'channel',
  'banKick',
];

@Controller('api/guilds')
@UseGuards(SessionGuard)
export class GuildsController {
  constructor(
    private readonly guilds: GuildsService,
    private readonly storage: GuildStorageService,
    private readonly logEvents: LogEventsService,
    private readonly templateInstall: TemplateInstallService,
  ) {}

  private getUser(req: Request): SessionUser {
    const user = (req as Request & { user?: SessionUser }).user;
    if (!user?.accessToken) throw new UnauthorizedException('Not logged in');
    return user;
  }

  private async ensureGuildAccess(guildId: string, req: Request): Promise<void> {
    const user = (req as Request & { user: SessionUser }).user;
    const list = await this.guilds.getUserGuilds(user.accessToken);
    if (!list.some((g) => g.id === guildId)) throw new UnauthorizedException('No access to this guild');
  }

  @Get()
  async list(@Req() req: Request) {
    const user = this.getUser(req);
    return this.guilds.getUserGuilds(user.accessToken);
  }

  @Get(':id/logs/events')
  async getLogEvents(
    @Param('id') guildId: string,
    @Req() req: Request,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
  ) {
    await this.ensureGuildAccess(guildId, req);
    const events = await this.logEvents.findAllByGuild(guildId, {
      limit: limit ? Math.min(parseInt(limit, 10) || 50, 100) : 50,
      before: before || undefined,
    });
    return { events };
  }

  @Get(':id/logs')
  async getLogs(@Param('id') guildId: string, @Req() req: Request) {
    await this.ensureGuildAccess(guildId, req);
    const config = this.storage.getConfig(guildId);
    return config.logChannels ?? {};
  }

  @Patch(':id/logs')
  async setLog(
    @Param('id') guildId: string,
    @Body() body: { type: keyof LogChannelsConfig; channelId: string | null },
    @Req() req: Request,
  ) {
    await this.ensureGuildAccess(guildId, req);
    if (!body.type || !LOG_TYPES.includes(body.type)) {
      throw new UnauthorizedException('Invalid log type');
    }
    this.storage.setLogChannel(guildId, body.type, body.channelId ?? null);
    return this.storage.getConfig(guildId).logChannels ?? {};
  }

  @Get(':id/roles')
  async getRoles(@Param('id') guildId: string, @Req() req: Request) {
    await this.ensureGuildAccess(guildId, req);
    return this.guilds.getGuildRoles(guildId);
  }

  @Get(':id/reaction-roles')
  async getReactionRoles(@Param('id') guildId: string, @Req() req: Request) {
    await this.ensureGuildAccess(guildId, req);
    const bindings = this.storage.getReactionRoleBindings(guildId);
    const channels = this.storage.getReactionRoleChannels(guildId);
    const list: Array<{
      messageId: string;
      channelId: string | undefined;
      roles: Array<{ emojiKey: string; roleId: string }>;
    }> = [];
    for (const [messageId, rolesMap] of Object.entries(bindings)) {
      const roles = Object.entries(rolesMap).map(([emojiKey, roleId]) => ({ emojiKey, roleId }));
      if (roles.length) {
        list.push({
          messageId,
          channelId: channels[messageId],
          roles,
        });
      }
    }
    return { bindings: list };
  }

  @Post(':id/reaction-roles')
  async addReactionRole(
    @Param('id') guildId: string,
    @Body() body: { channelId: string; messageId: string; emoji: string; roleId: string },
    @Req() req: Request,
  ) {
    await this.ensureGuildAccess(guildId, req);
    if (!body.channelId || !body.messageId || !body.emoji?.trim() || !body.roleId) {
      throw new UnauthorizedException('channelId, messageId, emoji, roleId required');
    }
    await this.guilds.addReactionRoleBinding(
      guildId,
      body.channelId,
      body.messageId,
      body.emoji.trim(),
      body.roleId,
    );
    return { ok: true };
  }

  @Post(':id/reaction-roles/remove')
  async removeReactionRole(
    @Param('id') guildId: string,
    @Body() body: { messageId: string; emojiKey: string },
    @Req() req: Request,
  ) {
    await this.ensureGuildAccess(guildId, req);
    if (!body.messageId || !body.emojiKey) {
      throw new UnauthorizedException('messageId and emojiKey required');
    }
    this.storage.removeReactionRoleBinding(guildId, body.messageId, body.emojiKey);
    return { ok: true };
  }

  @Get(':id/channels')
  async channels(@Param('id') guildId: string, @Req() req: Request) {
    await this.ensureGuildAccess(guildId, req);
    return this.guilds.getGuildChannels(guildId);
  }

  @Post(':id/install-template')
  async installTemplate(
    @Param('id') guildId: string,
    @Body() body: { templateId: string },
    @Req() req: Request,
  ) {
    await this.ensureGuildAccess(guildId, req);
    if (!body?.templateId) throw new BadRequestException('templateId required');
    const result = await this.templateInstall.install(guildId, body.templateId);
    if ('error' in result) throw new BadRequestException(result.error);
    return result;
  }

  @Post(':id/send')
  async send(
    @Param('id') guildId: string,
    @Body() body: { channelId: string; title?: string; description?: string; image?: string },
    @Req() req: Request,
  ) {
    await this.ensureGuildAccess(guildId, req);
    if (!body.channelId) throw new UnauthorizedException('channelId required');
    await this.guilds.sendMessage(guildId, body.channelId, {
      title: body.title,
      description: body.description,
      image: body.image,
    });
    return { ok: true };
  }
}
