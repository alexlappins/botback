import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  MessageFlags,
  type ColorResolvable,
} from 'discord.js';
import { Repository } from 'typeorm';

import {
  StreamSubscription,
  type EmbedConfig,
} from './entities/stream-subscription.entity';
import { TwitchHelixService, type TwitchStream, type TwitchUser } from './twitch-helix.service';

export interface StreamOnlineEvent {
  broadcasterUserId: string;
  broadcasterUserLogin: string;
  broadcasterUserName: string;
  streamId: string;
  streamType: string;
  startedAt: string;
}

export interface StreamOfflineEvent {
  broadcasterUserId: string;
}

const TWITCH_PURPLE = '#9146FF';
const DISCORD_TITLE_MAX = 256;
const DISCORD_DESCRIPTION_MAX = 4096;
const DISCORD_FIELD_VALUE_MAX = 1024;

/**
 * Renders the Discord embed and ships it to the channel(s) listening for a
 * particular broadcaster. Also owns the per-(stream_subscription) dedup and
 * the offline state reset.
 *
 * Multiple guilds may track the same streamer → we fan out to all of them.
 */
@Injectable()
export class StreamNotificationsService {
  private readonly logger = new Logger(StreamNotificationsService.name);

  constructor(
    @Inject(Client) private readonly discord: Client,
    @InjectRepository(StreamSubscription)
    private readonly streamRepo: Repository<StreamSubscription>,
    private readonly helix: TwitchHelixService,
  ) {}

  async onStreamOnline(event: StreamOnlineEvent): Promise<void> {
    const subs = await this.streamRepo.find({
      where: { platform: 'twitch', platformUserId: event.broadcasterUserId, enabled: true },
    });
    if (!subs.length) {
      // We're getting events for a broadcaster nobody tracks any more — log
      // and let the bootstrap reconciliation drop the subscription.
      this.logger.debug(`stream.online for untracked broadcaster ${event.broadcasterUserId}`);
      return;
    }

    // Pull live stream details once for all guilds tracking this streamer.
    const [stream] = await this.helix.getStreamsByUserIds([event.broadcasterUserId]);
    const [user] = await this.helix.getUsersByLogin([event.broadcasterUserLogin]);

    for (const sub of subs) {
      // Idempotency: Twitch sometimes redelivers stream.online, and a bot
      // restart can replay the same event when we re-subscribe.
      if (sub.currentStreamId === event.streamId) {
        this.logger.debug(
          `Already notified for stream ${event.streamId} in guild ${sub.guildId}`,
        );
        continue;
      }
      try {
        await this.sendNotification(sub, event, stream ?? null, user ?? null);
        sub.isLive = true;
        sub.currentStreamId = event.streamId;
        sub.currentStreamStartedAt = new Date(event.startedAt);
        sub.lastNotifiedAt = new Date();
        await this.streamRepo.save(sub);
      } catch (e) {
        this.logger.warn(
          `Failed to send Twitch notification for ${sub.platformUsername} in ${sub.guildId}: ${(e as Error).message}`,
        );
      }
    }
  }

  async onStreamOffline(event: StreamOfflineEvent): Promise<void> {
    const subs = await this.streamRepo.find({
      where: { platform: 'twitch', platformUserId: event.broadcasterUserId },
    });
    for (const sub of subs) {
      sub.isLive = false;
      sub.currentStreamId = null;
      sub.currentStreamStartedAt = null;
      await this.streamRepo.save(sub);
    }
  }

  // ── Embed render + send ──────────────────────────────────

  private async sendNotification(
    sub: StreamSubscription,
    event: StreamOnlineEvent,
    stream: TwitchStream | null,
    user: TwitchUser | null,
  ): Promise<void> {
    const guild = this.discord.guilds.cache.get(sub.guildId);
    if (!guild) {
      this.logger.warn(`Guild ${sub.guildId} not cached, skipping notification`);
      return;
    }
    const channel = guild.channels.cache.get(sub.discordChannelId);
    if (!channel || !channel.isTextBased()) {
      this.logger.warn(`Channel ${sub.discordChannelId} unusable in ${sub.guildId}`);
      return;
    }

    const vars = this.buildVariables(event, stream, user);
    const cfg = sub.embedConfig ?? {};
    const { embed, button } = this.renderEmbed(cfg, vars, user, stream);
    const content = renderTemplate(sub.contentTemplate ?? cfg.contentTemplate ?? '', vars);
    const row = button
      ? new ActionRowBuilder<ButtonBuilder>().addComponents(button)
      : null;

    // If the admin's content text contains a URL we don't want Discord to add
    // its own auto-unfurl preview underneath our hand-rolled embed.
    const contentHasUrl = /\bhttps?:\/\//.test(content);
    await channel
      .send({
        content: content || undefined,
        embeds: [embed],
        components: row ? [row] : undefined,
        flags: contentHasUrl ? MessageFlags.SuppressEmbeds : undefined,
      })
      .catch((e: Error) => {
        // Most common: bot missing Send Messages / Embed Links in this channel.
        this.logger.warn(`channel.send for ${sub.guildId}/${sub.discordChannelId}: ${e.message}`);
      });
  }

  /**
   * Build the variable map fed into title/description/content templates.
   * Fall back to event data when Helix detail fetch fails (e.g. Twitch lag
   * between stream.online and Get Streams returning the row).
   */
  private buildVariables(
    event: StreamOnlineEvent,
    stream: TwitchStream | null,
    user: TwitchUser | null,
  ): Record<string, string> {
    const displayName = stream?.user_name || event.broadcasterUserName || event.broadcasterUserLogin;
    const login = stream?.user_login || event.broadcasterUserLogin;
    return {
      streamer: displayName,
      title: stream?.title ?? '',
      game: stream?.game_name ?? '',
      url: `https://twitch.tv/${login}`,
      viewers: String(stream?.viewer_count ?? 0),
      started_at: stream?.started_at ?? event.startedAt,
    };
    void user; // currently only used for the embed renderer below
  }

  private renderEmbed(
    cfg: EmbedConfig,
    vars: Record<string, string>,
    user: TwitchUser | null,
    stream: TwitchStream | null,
  ): { embed: EmbedBuilder; button: ButtonBuilder | null } {
    const embed = new EmbedBuilder();

    const color = isHex(cfg.color) ? (cfg.color as ColorResolvable) : (TWITCH_PURPLE as ColorResolvable);
    embed.setColor(color);

    const titleTpl = cfg.titleTemplate?.trim() || '{streamer} is live on Twitch!';
    embed.setTitle(truncate(renderTemplate(titleTpl, vars), DISCORD_TITLE_MAX));

    const descTpl = cfg.descriptionTemplate?.trim() || '**{title}**';
    const rendered = renderTemplate(descTpl, vars).trim();
    if (rendered) embed.setDescription(truncate(rendered, DISCORD_DESCRIPTION_MAX));

    embed.setURL(vars.url);

    // Author block = streamer avatar + display name + clickable link.
    if (cfg.showStreamerAvatar !== false && user) {
      embed.setAuthor({
        name: vars.streamer,
        iconURL: user.profile_image_url,
        url: vars.url,
      });
    } else {
      embed.setAuthor({ name: vars.streamer, url: vars.url });
    }

    if (cfg.showGame !== false && vars.game) {
      embed.addFields({
        name: 'Playing',
        value: truncate(vars.game, DISCORD_FIELD_VALUE_MAX),
        inline: true,
      });
    }
    if (vars.viewers && Number(vars.viewers) > 0) {
      embed.addFields({ name: 'Viewers', value: vars.viewers, inline: true });
    }

    // Thumbnail (stream preview) — Twitch templates the URL with literal
    // {width}/{height} placeholders. Substitute and add a cache-buster so
    // Discord doesn't show last week's frame.
    if (cfg.showThumbnail !== false && stream?.thumbnail_url) {
      const url = stream.thumbnail_url
        .replace('{width}', '1280')
        .replace('{height}', '720');
      embed.setImage(`${url}?t=${Date.now()}`);
    }

    embed.setTimestamp(new Date(vars.started_at));
    embed.setFooter({ text: 'Twitch' });

    // Total-budget safety: Discord enforces 6000 chars across the whole embed.
    // EmbedBuilder doesn't pre-validate; if we overflow, drop the description
    // to keep title+fields visible.
    const totalLen =
      (embed.data.title?.length ?? 0) +
      (embed.data.description?.length ?? 0) +
      (embed.data.footer?.text.length ?? 0) +
      (embed.data.author?.name.length ?? 0) +
      (embed.data.fields ?? []).reduce(
        (acc, f) => acc + f.name.length + f.value.length,
        0,
      );
    if (totalLen > 6000 && embed.data.description) {
      embed.setDescription(truncate(embed.data.description, 4096 - (totalLen - 6000) - 1));
    }

    const button = new ButtonBuilder()
      .setLabel((cfg.buttonLabel?.trim() || 'Watch on Twitch').slice(0, 80))
      .setStyle(ButtonStyle.Link)
      .setURL(vars.url);

    return { embed, button };
  }
}

// ── Helpers ────────────────────────────────────────────────

function renderTemplate(tpl: string, vars: Record<string, string>): string {
  if (!tpl) return '';
  return tpl.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? vars[k] : `{${k}}`));
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

function isHex(v: string | undefined): v is string {
  return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
}
