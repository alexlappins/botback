import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Client,
  DiscordAPIError,
  PermissionFlagsBits,
  WebhookClient,
  type Guild,
  type MessageCreateOptions,
  type TextChannel,
} from 'discord.js';
import { Repository } from 'typeorm';

import { PremiumService } from '../premium/premium.service';
import { BotPersonalization } from './entities/bot-personalization.entity';
import { WebhookCache } from './entities/webhook-cache.entity';

/** Constant service name for the webhook object itself (TZ §8.6) — NOT the
 *  customer-visible name; that's a per-message override. */
const SERVICE_WEBHOOK_NAME = 'Level Up Bot Personalization';

/** Discord caps webhooks at 15 per channel — at the cap we fall back (TZ §8.10). */
const CHANNEL_WEBHOOK_LIMIT = 15;

export interface SendResult {
  via: 'webhook' | 'bot';
}

/**
 * Central "send as the bot" facade (TZ v2.1 §8). Every feature that posts a
 * message to a channel should route through sendBotMessage(); it transparently
 * uses the guild's custom identity webhook when (premium && enabled) and falls
 * back to a plain bot send in every other case — including missing
 * Manage Webhooks permission, deleted webhooks, or the 15-webhook cap.
 */
@Injectable()
export class BotPersonalizationService {
  private readonly logger = new Logger(BotPersonalizationService.name);

  constructor(
    @Inject(Client) private readonly client: Client,
    @InjectRepository(BotPersonalization)
    private readonly personalizationRepo: Repository<BotPersonalization>,
    @InjectRepository(WebhookCache)
    private readonly webhookRepo: Repository<WebhookCache>,
    private readonly premium: PremiumService,
  ) {}

  async getSettings(guildId: string): Promise<BotPersonalization | null> {
    return this.personalizationRepo.findOne({ where: { guildId } });
  }

  async saveSettings(
    guildId: string,
    patch: { enabled?: boolean; customName?: string | null; customAvatarUrl?: string | null },
  ): Promise<BotPersonalization> {
    const row =
      (await this.personalizationRepo.findOne({ where: { guildId } })) ??
      this.personalizationRepo.create({ guildId, enabled: false, customName: null, customAvatarUrl: null });
    if (patch.enabled !== undefined) row.enabled = patch.enabled;
    if (patch.customName !== undefined) row.customName = patch.customName;
    if (patch.customAvatarUrl !== undefined) row.customAvatarUrl = patch.customAvatarUrl;
    return this.personalizationRepo.save(row);
  }

  /**
   * Send a message to a channel with the guild's custom identity when active.
   * Mirrors the TZ §8.6 algorithm; any webhook-path failure falls back to a
   * plain bot send so messages are never lost to personalization glitches.
   */
  async sendBotMessage(
    guild: Guild,
    channel: TextChannel,
    payload: MessageCreateOptions,
  ): Promise<SendResult> {
    const identity = await this.resolveIdentity(guild.id);
    if (!identity) {
      await channel.send(payload);
      return { via: 'bot' };
    }

    try {
      const hook = await this.getOrCreateWebhook(guild, channel);
      if (!hook) {
        await channel.send(payload);
        return { via: 'bot' };
      }
      const wc = new WebhookClient({ url: hook.webhookUrl });
      try {
        await wc.send({
          username: identity.name,
          avatarURL: identity.avatarUrl ?? undefined,
          content: payload.content || undefined,
          embeds: (payload.embeds ?? []) as never,
          components: (payload.components ?? []) as never,
          files: (payload.files ?? []) as never,
          // SuppressEmbeds is the only flag our senders use and webhooks accept it.
          flags: payload.flags as never,
        });
      } finally {
        wc.destroy();
      }
      return { via: 'webhook' };
    } catch (e) {
      // Webhook deleted by a server admin → drop the cache entry; a retry on
      // the next send will recreate it (TZ §8.6 "если вебхук удалён").
      if (e instanceof DiscordAPIError && (e.code === 10015 || e.status === 404)) {
        await this.webhookRepo.delete({ guildId: guild.id, channelId: channel.id }).catch(() => null);
      }
      this.logger.warn(
        `Webhook send failed in #${channel.name} (${guild.id}), falling back to bot: ${(e as Error).message}`,
      );
      await channel.send(payload);
      return { via: 'bot' };
    }
  }

  /** Custom identity iff premium AND enabled AND a name is configured. */
  private async resolveIdentity(guildId: string): Promise<{ name: string; avatarUrl: string | null } | null> {
    if (!(await this.premium.isPremium(guildId))) return null;
    const row = await this.getSettings(guildId);
    if (!row?.enabled || !row.customName?.trim()) return null;
    return { name: row.customName.trim(), avatarUrl: row.customAvatarUrl };
  }

  /**
   * Cached-or-created service webhook for a channel. Returns null when the bot
   * lacks Manage Webhooks or the channel is at Discord's webhook cap — callers
   * fall back to a plain send (TZ §8.7/§8.10).
   */
  private async getOrCreateWebhook(guild: Guild, channel: TextChannel): Promise<WebhookCache | null> {
    const cached = await this.webhookRepo.findOne({
      where: { guildId: guild.id, channelId: channel.id },
    });
    if (cached) return cached;

    const me = guild.members.me;
    if (!me || !channel.permissionsFor(me)?.has(PermissionFlagsBits.ManageWebhooks)) {
      this.logger.warn(`No Manage Webhooks permission in #${channel.name} (${guild.id}) — using plain send`);
      return null;
    }

    try {
      const existing = await channel.fetchWebhooks();
      // Reuse our own service webhook if a previous cache row was lost.
      const ours = existing.find((w) => w.owner?.id === this.client.user?.id && w.name === SERVICE_WEBHOOK_NAME);
      if (ours?.url) {
        const row = this.webhookRepo.create({
          guildId: guild.id,
          channelId: channel.id,
          webhookId: ours.id,
          webhookUrl: ours.url,
        });
        return this.webhookRepo.save(row);
      }
      if (existing.size >= CHANNEL_WEBHOOK_LIMIT) {
        this.logger.warn(`#${channel.name} is at the ${CHANNEL_WEBHOOK_LIMIT}-webhook cap — using plain send`);
        return null;
      }
      const created = await channel.createWebhook({ name: SERVICE_WEBHOOK_NAME });
      const row = this.webhookRepo.create({
        guildId: guild.id,
        channelId: channel.id,
        webhookId: created.id,
        webhookUrl: created.url,
      });
      return this.webhookRepo.save(row);
    } catch (e) {
      this.logger.warn(`Webhook create failed in #${channel.name}: ${(e as Error).message}`);
      return null;
    }
  }

  /**
   * Drop cached webhooks for a guild — used after an avatar change so the next
   * send recreates them (Discord caches webhook avatars aggressively, TZ §8.10).
   */
  async invalidateGuildWebhooks(guildId: string): Promise<void> {
    await this.webhookRepo.delete({ guildId }).catch(() => null);
  }
}

// ── Custom-name validation (TZ §8.5) ───────────────────────

const FORBIDDEN_SUBSTRINGS = ['discord', 'discordapp', '@everyone', '@here'];
const FORBIDDEN_BOT_NAMES = ['mee6', 'dyno', 'probot', 'carl-bot', 'carlbot'];

/** Returns an error string, or null when the name is acceptable. */
export function validateCustomBotName(raw: string): string | null {
  const name = raw.trim();
  if (name.length < 2 || name.length > 32) return 'Name must be 2–32 characters.';
  const lower = name.toLowerCase();
  for (const bad of FORBIDDEN_SUBSTRINGS) {
    if (lower.includes(bad)) return `Name cannot contain "${bad}".`;
  }
  for (const bot of FORBIDDEN_BOT_NAMES) {
    if (lower === bot || lower.replace(/[\s_-]/g, '') === bot.replace(/[\s_-]/g, '')) {
      return 'Name cannot imitate a well-known bot.';
    }
  }
  // Discord verified-checkmark lookalikes.
  if (/[✓✔✅☑]/u.test(name)) return 'Name cannot contain verification markers.';
  return null;
}
