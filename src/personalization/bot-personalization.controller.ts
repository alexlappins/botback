import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Put,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { Client, PermissionFlagsBits, type TextChannel } from 'discord.js';

import { CustomerGuard } from '../auth/customer.guard';
import { SessionGuard } from '../auth/session.guard';
import type { SessionUser } from '../auth/session.serializer';
import { GuildsService } from '../dashboard/guilds.service';
import { PremiumService } from '../premium/premium.service';
import { BotPersonalizationService, validateCustomBotName } from './bot-personalization.service';

@Controller('api/guilds/:guildId/personalization')
@UseGuards(SessionGuard, CustomerGuard)
export class BotPersonalizationController {
  constructor(
    @Inject(Client) private readonly client: Client,
    private readonly personalization: BotPersonalizationService,
    private readonly guilds: GuildsService,
    private readonly premium: PremiumService,
  ) {}

  private async ensureAccess(guildId: string, req: Request): Promise<void> {
    const user = (req as Request & { user: SessionUser }).user;
    const list = await this.guilds.getUserGuilds(user.accessToken, user.refreshToken);
    if (!list.some((g) => g.id === guildId)) {
      throw new UnauthorizedException('No access to this server');
    }
  }

  private async ensurePremium(guildId: string): Promise<void> {
    if (!(await this.premium.isPremium(guildId))) {
      throw new BadRequestException({
        message: 'Bot Personalization is a Premium feature.',
        reason: 'premium_required',
      });
    }
  }

  /** Settings + Manage Webhooks warnings for commonly used channels (TZ §8.7). */
  @Get()
  async getSettings(@Param('guildId') guildId: string, @Req() req: Request) {
    await this.ensureAccess(guildId, req);
    const row = await this.personalization.getSettings(guildId);
    return {
      enabled: row?.enabled ?? false,
      customName: row?.customName ?? null,
      customAvatarUrl: row?.customAvatarUrl ?? null,
      missingWebhookPerms: await this.collectMissingPerms(guildId),
    };
  }

  @Put()
  async saveSettings(
    @Param('guildId') guildId: string,
    @Body() body: { enabled?: boolean; customName?: string | null; customAvatarUrl?: string | null },
    @Req() req: Request,
  ) {
    await this.ensureAccess(guildId, req);
    await this.ensurePremium(guildId);

    const patch: { enabled?: boolean; customName?: string | null; customAvatarUrl?: string | null } = {};
    if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled);
    if (body.customName !== undefined) {
      const name = body.customName?.toString().trim() || null;
      if (name) {
        const err = validateCustomBotName(name);
        if (err) throw new BadRequestException(err);
      }
      patch.customName = name;
    }
    if (body.customAvatarUrl !== undefined) {
      const url = body.customAvatarUrl?.toString().trim() || null;
      if (url && !/^https?:\/\//i.test(url)) {
        throw new BadRequestException('Avatar must be an http(s) URL');
      }
      patch.customAvatarUrl = url;
    }

    const prev = await this.personalization.getSettings(guildId);
    const saved = await this.personalization.saveSettings(guildId, patch);
    // Avatar changed → recreate webhooks lazily so Discord picks the new look
    // up sooner (its webhook-avatar cache is sticky, TZ §8.10).
    if (patch.customAvatarUrl !== undefined && prev?.customAvatarUrl !== saved.customAvatarUrl) {
      await this.personalization.invalidateGuildWebhooks(guildId);
    }
    return saved;
  }

  /** Send a test message with the configured identity to a channel (TZ §8.4). */
  @Post('preview')
  async preview(
    @Param('guildId') guildId: string,
    @Body() body: { channelId?: string },
    @Req() req: Request,
  ) {
    await this.ensureAccess(guildId, req);
    await this.ensurePremium(guildId);
    const channelId = body?.channelId?.toString().trim();
    if (!channelId) throw new BadRequestException('channelId required');

    const guild =
      this.client.guilds.cache.get(guildId) ??
      (await this.client.guilds.fetch(guildId).catch(() => null));
    if (!guild) throw new NotFoundException('Guild not available to the bot');
    const channel = guild.channels.cache.get(channelId);
    if (!channel?.isTextBased()) throw new BadRequestException('Channel is not a text channel');

    const result = await this.personalization.sendBotMessage(guild, channel as TextChannel, {
      content: 'Preview: this is how bot messages will look with your personalization settings.',
    });
    return { ok: true, via: result.via };
  }

  /** Channels used by bot features where Manage Webhooks is missing (TZ §8.7). */
  private async collectMissingPerms(guildId: string): Promise<{ channelId: string; channelName: string }[]> {
    const guild =
      this.client.guilds.cache.get(guildId) ??
      (await this.client.guilds.fetch(guildId).catch(() => null));
    if (!guild) return [];
    const me = guild.members.me;
    if (!me) return [];
    const out: { channelId: string; channelName: string }[] = [];
    for (const [, ch] of guild.channels.cache) {
      if (!ch.isTextBased()) continue;
      const perms = ch.permissionsFor(me);
      // Only surface channels the bot can actually post in but can't webhook.
      if (perms?.has(PermissionFlagsBits.SendMessages) && !perms.has(PermissionFlagsBits.ManageWebhooks)) {
        out.push({ channelId: ch.id, channelName: ch.name });
        if (out.length >= 10) break; // keep the warning list short
      }
    }
    return out;
  }
}
