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
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Request } from 'express';
import { Inject } from '@nestjs/common';
import { Client, TextChannel, MessageReaction } from 'discord.js';

import { CustomerGuard } from '../auth/customer.guard';
import { SessionGuard } from '../auth/session.guard';
import type { SessionUser } from '../auth/session.serializer';
import { GuildStorageService } from '../common/storage/guild-storage.service';
import { GuildsService } from '../dashboard/guilds.service';

import { GuildMessage } from './entities/guild-message.entity';
import { GuildReactionRole } from './entities/guild-reaction-role.entity';

/**
 * Per-guild CRUD endpoints used by User Admin Panel:
 *   /api/guilds/:guildId/messages
 *   /api/guilds/:guildId/reaction-roles
 *
 * Edits are mirrored to the actual Discord channels and messages.
 */
// NOTE: Path is intentionally different from /api/guilds/:id/reaction-roles
// (which is owned by the legacy DashboardController and returns a different shape).
@Controller('api/guilds/:guildId/data')
@UseGuards(SessionGuard, CustomerGuard)
export class GuildDataController {
  constructor(
    @Inject(Client) private readonly client: Client,
    @InjectRepository(GuildMessage)
    private readonly messageRepo: Repository<GuildMessage>,
    @InjectRepository(GuildReactionRole)
    private readonly reactionRepo: Repository<GuildReactionRole>,
    private readonly guilds: GuildsService,
    private readonly storage: GuildStorageService,
  ) {}

  private async ensureGuildAccess(guildId: string, req: Request): Promise<void> {
    const user = (req as Request & { user: SessionUser }).user;
    const list = await this.guilds.getUserGuilds(user.accessToken, user.refreshToken);
    if (!list.some((g) => g.id === guildId)) {
      throw new UnauthorizedException('No access to this guild');
    }
  }

  // ─────────────────────────────────────────────────────
  // Messages
  // ─────────────────────────────────────────────────────

  @Get('messages')
  async listMessages(@Param('guildId') guildId: string, @Req() req: Request) {
    await this.ensureGuildAccess(guildId, req);
    return this.messageRepo.find({
      where: { guildId },
      order: { channelName: 'ASC', createdAt: 'ASC' },
    });
  }

  @Patch('messages/:msgId')
  async updateMessage(
    @Param('guildId') guildId: string,
    @Param('msgId') msgId: string,
    @Body()
    body: {
      content?: string | null;
      embedJson?: Record<string, unknown> | string | null;
      componentsJson?: unknown[] | string | null;
    },
    @Req() req: Request,
  ) {
    await this.ensureGuildAccess(guildId, req);
    const msg = await this.messageRepo.findOne({ where: { id: msgId, guildId } });
    if (!msg) throw new NotFoundException('Message not found');

    if (body.content !== undefined) msg.content = body.content?.trim() || null;
    if (body.embedJson !== undefined) msg.embedJson = parseJsonbObject(body.embedJson);
    if (body.componentsJson !== undefined) {
      msg.componentsJson = parseJsonbArray(body.componentsJson);
    }
    await this.messageRepo.save(msg);

    // Mirror to Discord
    try {
      const guild =
        this.client.guilds.cache.get(guildId) ??
        (await this.client.guilds.fetch(guildId).catch(() => null));
      if (guild) {
        const channel = guild.channels.cache.get(msg.discordChannelId);
        if (channel?.isTextBased()) {
          const discordMsg = await (channel as TextChannel).messages
            .fetch(msg.discordMessageId)
            .catch(() => null);
          if (discordMsg) {
            const content = msg.content?.trim() || undefined;
            const embeds = msg.embedJson ? [msg.embedJson] : [];
            const components = msg.componentsJson ?? [];
            await discordMsg.edit({
              content: content ?? '',
              embeds: embeds as never,
              components: components as never,
            });
          }
        }
      }
    } catch (e) {
      // DB updated but Discord edit failed — surface as warning
      throw new BadRequestException(
        `Saved in DB but failed to update Discord message: ${(e as Error).message}`,
      );
    }
    return msg;
  }

  @Delete('messages/:msgId')
  async deleteMessage(
    @Param('guildId') guildId: string,
    @Param('msgId') msgId: string,
    @Req() req: Request,
  ) {
    await this.ensureGuildAccess(guildId, req);
    const msg = await this.messageRepo.findOne({ where: { id: msgId, guildId } });
    if (!msg) throw new NotFoundException('Message not found');

    // Try to delete the actual Discord message (best-effort)
    try {
      const guild =
        this.client.guilds.cache.get(guildId) ??
        (await this.client.guilds.fetch(guildId).catch(() => null));
      const channel = guild?.channels.cache.get(msg.discordChannelId);
      if (channel?.isTextBased()) {
        const discordMsg = await (channel as TextChannel).messages
          .fetch(msg.discordMessageId)
          .catch(() => null);
        await discordMsg?.delete().catch(() => null);
      }
    } catch {
      // ignore
    }

    await this.messageRepo.delete({ id: msgId, guildId });
    return { ok: true };
  }

  // ─────────────────────────────────────────────────────
  // Reaction roles
  // ─────────────────────────────────────────────────────

  @Get('reaction-roles')
  async listReactionRoles(@Param('guildId') guildId: string, @Req() req: Request) {
    await this.ensureGuildAccess(guildId, req);
    return this.reactionRepo.find({
      where: { guildId },
      order: { createdAt: 'ASC' },
    });
  }

  @Post('reaction-roles')
  async addReactionRole(
    @Param('guildId') guildId: string,
    @Body()
    body: {
      discordChannelId: string;
      discordMessageId: string;
      emojiKey: string;
      discordRoleId: string;
    },
    @Req() req: Request,
  ) {
    await this.ensureGuildAccess(guildId, req);
    const channelId = body?.discordChannelId?.trim();
    const messageId = body?.discordMessageId?.trim();
    const emojiKey = body?.emojiKey?.trim();
    const roleId = body?.discordRoleId?.trim();
    if (!channelId || !messageId || !emojiKey || !roleId) {
      throw new BadRequestException('All fields required');
    }
    // Persist binding in storage so the reaction listener can act
    this.storage.setReactionRoleBinding(guildId, messageId, emojiKey, roleId);
    this.storage.setReactionRoleChannel(guildId, messageId, channelId);

    // Place the reaction on the message so users can see it
    try {
      const guild =
        this.client.guilds.cache.get(guildId) ??
        (await this.client.guilds.fetch(guildId).catch(() => null));
      const channel = guild?.channels.cache.get(channelId);
      if (channel?.isTextBased()) {
        const discordMsg = await (channel as TextChannel).messages
          .fetch(messageId)
          .catch(() => null);
        await discordMsg?.react(emojiKey).catch(() => null);
      }
    } catch {
      // ignore — binding is saved; reaction can be added manually
    }

    const row = this.reactionRepo.create({
      guildId,
      discordChannelId: channelId,
      discordMessageId: messageId,
      emojiKey,
      discordRoleId: roleId,
    });
    await this.reactionRepo.save(row).catch(async () => {
      // Unique constraint — return existing row
      const existing = await this.reactionRepo.findOne({
        where: { guildId, discordMessageId: messageId, emojiKey },
      });
      if (existing) {
        existing.discordRoleId = roleId;
        existing.discordChannelId = channelId;
        await this.reactionRepo.save(existing);
        return existing;
      }
    });
    return row;
  }

  @Delete('reaction-roles/:rrId')
  async deleteReactionRole(
    @Param('guildId') guildId: string,
    @Param('rrId') rrId: string,
    @Req() req: Request,
  ) {
    await this.ensureGuildAccess(guildId, req);
    const row = await this.reactionRepo.findOne({ where: { id: rrId, guildId } });
    if (!row) throw new NotFoundException('Reaction role not found');

    this.storage.removeReactionRoleBinding(guildId, row.discordMessageId, row.emojiKey);

    // Remove the reaction from the message (best-effort)
    try {
      const guild =
        this.client.guilds.cache.get(guildId) ??
        (await this.client.guilds.fetch(guildId).catch(() => null));
      const channel = guild?.channels.cache.get(row.discordChannelId);
      if (channel?.isTextBased()) {
        const discordMsg = await (channel as TextChannel).messages
          .fetch(row.discordMessageId)
          .catch(() => null);
        if (discordMsg) {
          const reactions = discordMsg.reactions.cache;
          const target = reactions.find((r: MessageReaction) => {
            return (r.emoji.id ?? r.emoji.name) === row.emojiKey;
          });
          await target?.remove().catch(() => null);
        }
      }
    } catch {
      // ignore
    }

    await this.reactionRepo.delete({ id: rrId, guildId });
    return { ok: true };
  }
}

function parseJsonbObject(v: unknown): Record<string, unknown> | null {
  if (v == null) return null;
  if (typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    try {
      const parsed = JSON.parse(s) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      throw new BadRequestException('embedJson: invalid JSON');
    }
  }
  return null;
}

function parseJsonbArray(v: unknown): unknown[] | null {
  if (v == null) return null;
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    try {
      const parsed = JSON.parse(s) as unknown;
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      throw new BadRequestException('componentsJson: invalid JSON');
    }
  }
  return null;
}
