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
import { Client, PermissionFlagsBits, TextChannel, MessageReaction } from 'discord.js';

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

  /**
   * Create a brand-new message in Discord and snapshot it as a GuildMessage
   * so the user can later edit/delete it via the dashboard.
   */
  @Post('messages')
  async createMessage(
    @Param('guildId') guildId: string,
    @Body()
    body: {
      discordChannelId: string;
      content?: string | null;
      embedJson?: Record<string, unknown> | string | null;
      componentsJson?: unknown[] | string | null;
    },
    @Req() req: Request,
  ) {
    await this.ensureGuildAccess(guildId, req);
    const channelId = body?.discordChannelId?.trim();
    if (!channelId) throw new BadRequestException('discordChannelId required');

    const content = body.content?.trim() || null;
    const embedJson = parseJsonbObject(body.embedJson ?? null);
    const componentsJson = parseJsonbArray(body.componentsJson ?? null);

    if (!content && !embedJson && !(componentsJson && componentsJson.length)) {
      throw new BadRequestException('Provide at least content, embed, or components');
    }

    const guild =
      this.client.guilds.cache.get(guildId) ??
      (await this.client.guilds.fetch(guildId).catch(() => null));
    if (!guild) throw new NotFoundException('Guild not found');
    const channel = guild.channels.cache.get(channelId);
    if (!channel?.isTextBased()) {
      throw new BadRequestException('Selected channel is not a text channel');
    }

    const safeEmbed = sanitizeEmbedForDiscord(embedJson);
    let sent;
    try {
      sent = await (channel as TextChannel).send({
        content: content ?? undefined,
        embeds: (safeEmbed ? [safeEmbed] : []) as never,
        components: toDiscordComponents(componentsJson) as never,
      });
    } catch (e) {
      throw new BadRequestException(
        `Failed to send message to Discord: ${(e as Error).message}`,
      );
    }

    const row = this.messageRepo.create({
      guildId,
      discordChannelId: channelId,
      discordMessageId: sent.id,
      channelName: (channel as TextChannel).name ?? 'unknown',
      content,
      embedJson,
      componentsJson,
    });
    await this.messageRepo.save(row);
    return row;
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
            const safeEmbed = sanitizeEmbedForDiscord(msg.embedJson);
            const embeds = safeEmbed ? [safeEmbed] : [];
            const components = toDiscordComponents(msg.componentsJson);
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
    const rawEmoji = body?.emojiKey?.trim();
    const roleId = body?.discordRoleId?.trim();
    if (!channelId || !messageId || !rawEmoji || !roleId) {
      throw new BadRequestException('All fields required');
    }

    // Normalise the emoji to the form discord.js gives us in
    // messageReactionAdd events. Without this, custom-emoji bindings save
    // as "<:name:123>" but the event payload is just "123" → no role on
    // reaction. Unicode emoji pass through unchanged.
    const emojiKey = normaliseEmojiKey(rawEmoji);

    // Resolve guild + channel + message BEFORE writing storage. If anything's
    // wrong (missing perms / bad emoji / message gone) we want the dashboard
    // to surface the real error, not silently save a dead binding.
    const guild =
      this.client.guilds.cache.get(guildId) ??
      (await this.client.guilds.fetch(guildId).catch(() => null));
    if (!guild) {
      throw new BadRequestException('Server not found or bot is not on it');
    }
    const channel = guild.channels.cache.get(channelId);
    if (!channel || !channel.isTextBased()) {
      throw new BadRequestException('Channel not found or not a text channel');
    }
    const me = guild.members.me;
    if (me) {
      const perms = channel.permissionsFor(me);
      const missing: string[] = [];
      if (!perms?.has(PermissionFlagsBits.ReadMessageHistory)) missing.push('Read Message History');
      if (!perms?.has(PermissionFlagsBits.AddReactions)) missing.push('Add Reactions');
      if (missing.length) {
        throw new BadRequestException(
          `Bot is missing channel permissions: ${missing.join(', ')}. Grant them and retry.`,
        );
      }
    }
    const discordMsg = await (channel as TextChannel).messages
      .fetch(messageId)
      .catch(() => null);
    if (!discordMsg) {
      throw new BadRequestException('Message not found in that channel');
    }
    try {
      await discordMsg.react(rawEmoji);
    } catch (e) {
      throw new BadRequestException(
        `Couldn't react with that emoji: ${(e as Error).message}. ` +
          'For custom emojis use the format <:name:id>; for unicode just paste the character.',
      );
    }

    // Reaction landed — now it's safe to persist the binding.
    this.storage.setReactionRoleBinding(guildId, messageId, emojiKey, roleId);
    this.storage.setReactionRoleChannel(guildId, messageId, channelId);

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

/**
 * Discord rejects embeds whose `description`/`title` keys are present but
 * empty (`BASE_TYPE_REQUIRED`), and embeds with no renderable content at all.
 * Stored embeds can end up shaped like `{description: ""}` — e.g. a template
 * message whose embed was left blank, or a text/buttons-only message that
 * nonetheless persisted an empty embed object. Without this, adding buttons to
 * such a message (which re-edits the Discord message with the stored embed)
 * 400s on `embeds[0].description[BASE_TYPE_REQUIRED]`.
 *
 * Strips blank scalar fields, drops sub-objects missing their required key
 * (footer.text / author.name / image|thumbnail.url), and returns null when no
 * renderable content remains so the caller can omit the embed entirely.
 */
function sanitizeEmbedForDiscord(
  embed: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!embed || typeof embed !== 'object') return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(embed)) {
    if (v == null) continue;
    if (typeof v === 'string' && v.trim() === '') continue; // description: "", title: "", url: ""
    if (Array.isArray(v) && v.length === 0) continue; // fields: []
    out[k] = v;
  }
  const text = (o: unknown, key: string): string | undefined => {
    const val = (o as Record<string, unknown>)?.[key];
    return typeof val === 'string' ? val.trim() : undefined;
  };
  if ('footer' in out && !text(out.footer, 'text')) delete out.footer;
  if ('author' in out && !text(out.author, 'name')) delete out.author;
  for (const imgKey of ['image', 'thumbnail'] as const) {
    if (imgKey in out && !text(out[imgKey], 'url')) delete out[imgKey];
  }
  const renderable = ['title', 'description', 'fields', 'image', 'thumbnail', 'author', 'footer'];
  if (!renderable.some((k) => k in out)) return null;
  return out;
}

/**
 * Normalize stored button rows into Discord's raw REST API shape before
 * sending/editing a message.
 *
 * The dashboard serializer stores buttons in camelCase (`customId`) — but
 * Discord's API requires snake_case `custom_id`, and discord.js passes plain
 * objects straight through WITHOUT converting. So a stored `customId` reaches
 * Discord as an unknown field while the required `custom_id` is missing →
 * Discord 400 (`custom_id` is required), which is exactly why "add role button"
 * kept failing even after the embed fix. Accepts either casing (template-side
 * data may already be snake_case) and rebuilds clean rows of action-row +
 * button objects, dropping anything malformed.
 */
function toDiscordComponents(rows: unknown[] | null | undefined): unknown[] {
  if (!Array.isArray(rows)) return [];
  const result: unknown[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const comps = (row as { components?: unknown[] }).components;
    if (!Array.isArray(comps)) continue;
    const buttons: Record<string, unknown>[] = [];
    for (const c of comps) {
      if (!c || typeof c !== 'object') continue;
      const b = c as Record<string, unknown>;
      const btn: Record<string, unknown> = { type: 2 };
      if (b.label != null) btn.label = b.label;
      if (b.emoji != null) btn.emoji = b.emoji;
      if (b.disabled != null) btn.disabled = b.disabled;
      const url = b.url;
      const customId = b.custom_id ?? b.customId;
      if (url) {
        btn.style = 5; // link buttons use a URL, no custom_id
        btn.url = url;
      } else {
        if (b.style != null) btn.style = b.style;
        if (customId != null) btn.custom_id = customId;
      }
      // A non-link button with no custom_id is invalid — skip it rather than
      // let Discord reject the whole message.
      if (btn.style !== 5 && btn.custom_id == null) continue;
      buttons.push(btn);
    }
    if (buttons.length) result.push({ type: 1, components: buttons.slice(0, 5) });
  }
  return result;
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

/**
 * Convert an admin-typed emoji into the canonical key the reaction listener
 * compares against:
 *   - "<:name:123>"    → "123"  (custom emoji — discord.js gives us the id)
 *   - "<a:name:123>"   → "123"  (animated custom — same)
 *   - "name:123"       → "123"
 *   - "😀" / unicode    → "😀"   (unicode passes through)
 *
 * Matches `getEmojiKey(reaction)` in reaction-roles.components.ts, which
 * reads `reaction.emoji.id ?? reaction.emoji.name`.
 */
function normaliseEmojiKey(input: string): string {
  const trimmed = input.trim();
  const customMatch = trimmed.match(/^<a?:[^:]+:(\d+)>$/);
  if (customMatch) return customMatch[1];
  if (trimmed.includes(':')) {
    const tail = trimmed.split(':').pop();
    if (tail && /^\d+$/.test(tail)) return tail;
  }
  return trimmed;
}
