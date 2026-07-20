import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ChannelType, Client, EmbedBuilder, TextChannel } from 'discord.js';

import { SecurityBridge } from '../common/security-bridge.service';
import { SecurityService } from './security.service';

export const SHIELD_SENSITIVITY = 0.6; // §8.2 default multiplier (alerts_config)

interface ShieldRuntime {
  liveSubs: Set<string>; // subscription ids currently live
  active: boolean;
  savedSlowmodes: Record<string, number>;
}

/**
 * Stream Shield (§8): while a tracked Twitch channel is live, the server runs
 * in heightened-attention mode — detector thresholds ×0.6, optional slowmode
 * and a stricter age filter — plus pretty on/off announcements.
 * Premium: expired guilds keep settings, the shield simply never activates.
 */
@Injectable()
export class StreamShieldService implements OnModuleInit {
  private readonly logger = new Logger(StreamShieldService.name);
  private runtime = new Map<string, ShieldRuntime>();

  constructor(
    private readonly security: SecurityService,
    private readonly bridge: SecurityBridge,
    @Inject(Client) private readonly client: Client,
  ) {}

  onModuleInit(): void {
    this.bridge.onStreamOnline = (guildId, subId, streamer, title) =>
      this.onStreamOnline(guildId, subId, streamer, title);
    this.bridge.onStreamOffline = (guildId, subId, streamer) =>
      this.onStreamOffline(guildId, subId, streamer);
    this.bridge.thresholdMultiplier = (guildId) =>
      this.runtime.get(guildId)?.active ? SHIELD_SENSITIVITY : 1;
    this.security.shieldAgeDays = (guildId) => {
      const rt = this.runtime.get(guildId);
      if (!rt?.active) return 0;
      // Settings are read at join time by SecurityService; cache the flag here.
      return this.shieldAgeCache.get(guildId) ?? 0;
    };
  }

  private shieldAgeCache = new Map<string, number>();

  /** Called from Twitch notifications on stream.online (§8.4). */
  async onStreamOnline(guildId: string, subId: string, streamer: string, streamTitle: string | null): Promise<void> {
    try {
      const settings = await this.security.getSettings(guildId);
      if (!settings.shieldEnabled) return;
      if (settings.shieldTriggerSubs.length && !settings.shieldTriggerSubs.includes(subId)) return;
      if (!(await this.security.isPremium(guildId))) return; // §8.5

      let rt = this.runtime.get(guildId);
      if (!rt) {
        rt = { liveSubs: new Set(), active: false, savedSlowmodes: {} };
        this.runtime.set(guildId, rt);
      }
      rt.liveSubs.add(subId);
      if (rt.active) return; // first live activates; the rest just join the set

      rt.active = true;
      this.shieldAgeCache.set(guildId, settings.shieldAgeFilterEnabled ? settings.shieldAgeFilterDays : 0);

      const guild = this.client.guilds.cache.get(guildId);
      if (guild && settings.shieldSlowmodeEnabled) {
        for (const channelId of settings.shieldSlowmodeChannels) {
          const ch = guild.channels.cache.get(channelId);
          if (ch?.type === ChannelType.GuildText) {
            rt.savedSlowmodes[channelId] = (ch as TextChannel).rateLimitPerUser ?? 0;
            await (ch as TextChannel)
              .setRateLimitPerUser(settings.shieldSlowmodeSeconds, 'Stream Shield')
              .catch(() => null);
          }
        }
      }

      if (settings.shieldPostAnnouncements) {
        await this.announce(guildId, true, streamer, streamTitle).catch(() => null);
      }
      this.logger.log(`Stream Shield ACTIVE in ${guildId} (streamer ${streamer})`);
    } catch (e) {
      this.logger.warn(`shield online failed: ${(e as Error).message}`);
    }
  }

  /** Called on stream.offline — deactivates only when ALL live subs are done (§8.4). */
  async onStreamOffline(guildId: string, subId: string, streamer: string): Promise<void> {
    try {
      const rt = this.runtime.get(guildId);
      if (!rt) return;
      rt.liveSubs.delete(subId);
      if (!rt.active || rt.liveSubs.size > 0) return;

      rt.active = false;
      this.shieldAgeCache.delete(guildId);
      const settings = await this.security.getSettings(guildId);
      const guild = this.client.guilds.cache.get(guildId);
      if (guild) {
        for (const [channelId, seconds] of Object.entries(rt.savedSlowmodes)) {
          const ch = guild.channels.cache.get(channelId);
          if (ch?.type === ChannelType.GuildText) {
            await (ch as TextChannel).setRateLimitPerUser(seconds, 'Stream Shield off').catch(() => null);
          }
        }
      }
      rt.savedSlowmodes = {};

      if (settings.shieldPostAnnouncements) {
        await this.announce(guildId, false, streamer, null).catch(() => null);
      }
      this.logger.log(`Stream Shield OFF in ${guildId}`);
    } catch (e) {
      this.logger.warn(`shield offline failed: ${(e as Error).message}`);
    }
  }

  /** §8.3 — customizable activation/deactivation embeds with defaults. */
  private async announce(guildId: string, on: boolean, streamer: string, streamTitle: string | null): Promise<void> {
    const settings = await this.security.getSettings(guildId);
    if (!settings.shieldChannelId) return;
    const guild = this.client.guilds.cache.get(guildId);
    const channel = guild?.channels.cache.get(settings.shieldChannelId);
    if (!channel?.isTextBased()) return;

    const custom = (on ? settings.shieldEmbedOn : settings.shieldEmbedOff) as
      | { title?: string; description?: string; color?: string; imageUrl?: string }
      | null;
    const subst = (s: string) =>
      s.replaceAll('{streamer}', streamer).replaceAll('{stream_title}', streamTitle ?? '');

    const embed = new EmbedBuilder()
      .setColor(custom?.color ? parseInt(custom.color.replace('#', ''), 16) : on ? 0x9146ff : 0x57f287)
      .setTitle(
        subst(
          custom?.title ??
            (on ? '🛡️ Stream Shield activated' : '🛡️ Stream Shield deactivated'),
        ),
      )
      .setDescription(
        subst(
          custom?.description ??
            (on
              ? '{streamer} is now live. This server is under enhanced protection.'
              : 'Thanks for watching!'),
        ),
      )
      .setTimestamp(new Date());
    if (custom?.imageUrl) embed.setImage(custom.imageUrl);
    await (channel as TextChannel).send({ embeds: [embed] });
  }

  isActive(guildId: string): boolean {
    return this.runtime.get(guildId)?.active ?? false;
  }
}
