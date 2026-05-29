import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CustomerGuard } from '../auth/customer.guard';
import { SessionGuard } from '../auth/session.guard';
import type { SessionUser } from '../auth/session.serializer';
import { GuildsService } from '../dashboard/guilds.service';
import { StreamSubscription, type EmbedConfig } from './entities/stream-subscription.entity';
import { TwitchAdminService } from './twitch-admin.service';
import { TwitchTokenService } from './twitch-token.service';

/**
 * Dashboard-side REST for the Twitch live-notifications module.
 *
 * Routes mirror /twitch slash commands one-for-one via {@link TwitchAdminService},
 * so the spec's "panel ↔ command parity" requirement is structural: same code path,
 * same validation, same errors. Anything you can do here you can do from the
 * slash command and vice versa.
 */
@Controller('api/guilds/:guildId/twitch')
@UseGuards(SessionGuard, CustomerGuard)
export class TwitchController {
  constructor(
    private readonly admin: TwitchAdminService,
    private readonly guilds: GuildsService,
    private readonly tokens: TwitchTokenService,
    @InjectRepository(StreamSubscription)
    private readonly streamRepo: Repository<StreamSubscription>,
  ) {}

  private async ensureAccess(guildId: string, req: Request): Promise<void> {
    const user = (req as Request & { user: SessionUser }).user;
    const list = await this.guilds.getUserGuilds(user.accessToken, user.refreshToken);
    if (!list.some((g) => g.id === guildId)) {
      throw new UnauthorizedException('No access to this guild');
    }
  }

  @Get()
  async list(@Param('guildId') guildId: string, @Req() req: Request) {
    await this.ensureAccess(guildId, req);
    const items = await this.admin.listForGuild(guildId);
    const limit = this.admin.getLimit(guildId);
    return {
      configured: this.tokens.isConfigured(),
      limit,
      // "Module enabled" is true if at least one subscription is active. The
      // master toggle in the UI flips all rows; if everything is off the module
      // is effectively dormant for this server.
      moduleEnabled: items.some((s) => s.enabled),
      subscriptions: items.map((s) => ({
        id: s.id,
        platform: s.platform,
        platformUserId: s.platformUserId,
        platformUsername: s.platformUsername,
        discordChannelId: s.discordChannelId,
        enabled: s.enabled,
        isLive: s.isLive,
        currentStreamId: s.currentStreamId,
        currentStreamStartedAt: s.currentStreamStartedAt,
        contentTemplate: s.contentTemplate,
        embedConfig: s.embedConfig ?? {},
        createdAt: s.createdAt,
      })),
    };
  }

  @Post()
  async add(
    @Param('guildId') guildId: string,
    @Body() body: { username?: string; discordChannelId?: string },
    @Req() req: Request,
  ) {
    await this.ensureAccess(guildId, req);
    const username = body?.username?.toString().trim() ?? '';
    const discordChannelId = body?.discordChannelId?.toString().trim() ?? '';
    if (!username) throw new BadRequestException('username required');
    if (!discordChannelId) throw new BadRequestException('discordChannelId required');
    if (!this.tokens.isConfigured()) {
      throw new BadRequestException(
        'Twitch credentials not configured on the bot — set TWITCH_CLIENT_ID/SECRET first.',
      );
    }
    const result = await this.admin.addByUsername(guildId, username, discordChannelId);
    if (!result.ok) {
      // Surface the typed reason — the frontend can show a tailored toast.
      throw new BadRequestException({ message: result.message, reason: result.reason });
    }
    return result.subscription;
  }

  @Delete(':subId')
  async remove(
    @Param('guildId') guildId: string,
    @Param('subId') subId: string,
    @Req() req: Request,
  ) {
    await this.ensureAccess(guildId, req);
    const ok = await this.admin.removeById(guildId, subId);
    if (!ok) throw new NotFoundException('Subscription not found');
    return { ok: true };
  }

  /**
   * Update mutable per-subscription fields: which Discord channel gets the
   * notification, and per-row enabled flag. Username + broadcaster id are
   * immutable — to switch streamer, delete and re-add.
   */
  @Patch(':subId')
  async patch(
    @Param('guildId') guildId: string,
    @Param('subId') subId: string,
    @Body()
    body: {
      discordChannelId?: string;
      enabled?: boolean;
      contentTemplate?: string | null;
      embedConfig?: Partial<EmbedConfig>;
    },
    @Req() req: Request,
  ) {
    await this.ensureAccess(guildId, req);
    const row = await this.streamRepo.findOne({ where: { id: subId, guildId } });
    if (!row) throw new NotFoundException('Subscription not found');
    if (body.discordChannelId !== undefined) {
      const trimmed = body.discordChannelId.toString().trim();
      if (!trimmed) throw new BadRequestException('discordChannelId cannot be empty');
      row.discordChannelId = trimmed;
    }
    if (body.enabled !== undefined) row.enabled = Boolean(body.enabled);
    if (body.contentTemplate !== undefined) {
      const t = body.contentTemplate?.toString() ?? null;
      // Discord message content cap is 2000 chars; we clamp early so a stray
      // paste doesn't roundtrip to Discord and surface as a 400.
      row.contentTemplate = t && t.length > 2000 ? t.slice(0, 2000) : t;
    }
    if (body.embedConfig !== undefined) {
      row.embedConfig = sanitizeEmbedConfig(row.embedConfig ?? {}, body.embedConfig);
    }
    await this.streamRepo.save(row);
    return row;
  }

  /**
   * Master module toggle. Spec UX: a single switch enables/disables the whole
   * Twitch module for this server. Implementation flips per-row `enabled` for
   * every subscription, preserving individual rows so re-enabling restores
   * all tracked streamers without re-adding.
   */
  @Patch('module/enabled')
  async toggleModule(
    @Param('guildId') guildId: string,
    @Body() body: { enabled?: boolean },
    @Req() req: Request,
  ) {
    await this.ensureAccess(guildId, req);
    const enabled = Boolean(body?.enabled);
    await this.streamRepo
      .createQueryBuilder()
      .update()
      .set({ enabled })
      .where('guild_id = :guildId AND platform = :platform', { guildId, platform: 'twitch' })
      .execute();
    return { ok: true, enabled };
  }
}

/**
 * Apply a partial embed-config patch on top of the current row, dropping any
 * key we don't recognise. Keeps a typo in the body from polluting the jsonb
 * blob and getting saved forever.
 */
function sanitizeEmbedConfig(current: EmbedConfig, patch: Partial<EmbedConfig>): EmbedConfig {
  const out: EmbedConfig = { ...current };
  if (patch.color !== undefined) {
    if (patch.color === '' || patch.color === null) delete out.color;
    else if (typeof patch.color === 'string' && /^#[0-9a-f]{6}$/i.test(patch.color)) {
      out.color = patch.color;
    }
  }
  if (patch.titleTemplate !== undefined) {
    const t = patch.titleTemplate?.toString() ?? '';
    out.titleTemplate = t.slice(0, 256); // Discord embed title hard limit
  }
  if (patch.descriptionTemplate !== undefined) {
    out.descriptionTemplate = (patch.descriptionTemplate?.toString() ?? '').slice(0, 4096);
  }
  if (patch.buttonLabel !== undefined) {
    out.buttonLabel = (patch.buttonLabel?.toString() ?? '').slice(0, 80);
  }
  if (patch.contentTemplate !== undefined) {
    // contentTemplate also lives at the row level (and wins) but we accept it
    // here too so the editor can keep everything in one patch call.
    out.contentTemplate = (patch.contentTemplate?.toString() ?? '').slice(0, 2000);
  }
  if (patch.showGame !== undefined) out.showGame = Boolean(patch.showGame);
  if (patch.showThumbnail !== undefined) out.showThumbnail = Boolean(patch.showThumbnail);
  if (patch.showStreamerAvatar !== undefined) out.showStreamerAvatar = Boolean(patch.showStreamerAvatar);
  return out;
}
