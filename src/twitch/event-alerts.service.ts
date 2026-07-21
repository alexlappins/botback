import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AttachmentBuilder, Client, EmbedBuilder, TextChannel } from 'discord.js';
import { createCanvas, loadImage } from '@napi-rs/canvas';

import { PremiumService } from '../premium/premium.service';
import {
  AlertEventType,
  EventAlertSetting,
  TwitchConnection,
} from './entities/twitch-features.entities';
import { PlatformEventSubscription } from './entities/platform-event-subscription.entity';
import { TwitchEventDispatcher } from './twitch-event-dispatcher.service';
import { TwitchHelixService } from './twitch-helix.service';

export const ALERT_EVENT_TYPES: AlertEventType[] = [
  'follow',
  'sub',
  'resub',
  'gift',
  'bits',
  'raid',
  'hype_train',
];

/** EventSub type + condition builder per alert type (streamer token scopes). */
const EVENTSUB_FOR: Record<AlertEventType, { type: string; version: string; cond: (id: string) => Record<string, string> }> = {
  follow: { type: 'channel.follow', version: '2', cond: (id) => ({ broadcaster_user_id: id, moderator_user_id: id }) },
  sub: { type: 'channel.subscribe', version: '1', cond: (id) => ({ broadcaster_user_id: id }) },
  resub: { type: 'channel.subscription.message', version: '1', cond: (id) => ({ broadcaster_user_id: id }) },
  gift: { type: 'channel.subscription.gift', version: '1', cond: (id) => ({ broadcaster_user_id: id }) },
  bits: { type: 'channel.cheer', version: '1', cond: (id) => ({ broadcaster_user_id: id }) },
  raid: { type: 'channel.raid', version: '1', cond: (id) => ({ to_broadcaster_user_id: id }) },
  hype_train: { type: 'channel.hype_train.end', version: '1', cond: (id) => ({ broadcaster_user_id: id }) },
};

const DEFAULT_TEMPLATES: Record<AlertEventType, string> = {
  follow: '💜 {user} just followed {streamer}!',
  sub: '⭐ {user} subscribed to {streamer} (Tier {tier})!',
  resub: '⭐ {user} resubscribed for {months} months! "{message}"',
  gift: '🎁 {user} gifted {amount} subs to {streamer}!',
  bits: '✨ {user} cheered {amount} bits! "{message}"',
  raid: '🚀 {user} raided with {viewers} viewers!',
  hype_train: '🚂 Hype Train finished at level {amount}!',
};

interface AlertVars {
  user: string;
  amount?: number | string;
  tier?: string;
  message?: string;
  streamer: string;
  months?: number;
  viewers?: number;
}

/**
 * Event Alerts (TZ-A §3): Twitch stream events → Discord messages.
 * Tiers (§3.3): Free = plain text only; Premium = embeds + Image Cards.
 * Anti-spam (§3.5): gift-bomb window, follow-storm aggregation, single hype
 * train summary, ≤10 alert posts/min per guild with overflow aggregation.
 */
@Injectable()
export class EventAlertsService implements OnModuleInit {
  private readonly logger = new Logger(EventAlertsService.name);

  // §3.5 aggregation state
  private giftWindows = new Map<string, { count: number; timer: NodeJS.Timeout; vars: AlertVars }>();
  private followWindows = new Map<string, { count: number; users: string[]; windowStart: number; timer: NodeJS.Timeout | null }>();
  private postTimestamps = new Map<string, number[]>(); // guild → post times (rate limit)
  private overflow = new Map<string, number>(); // guild → suppressed count

  // Image render queue (§3.4) — sequential, never blocks the webhook.
  private renderQueue: (() => Promise<void>)[] = [];
  private rendering = false;

  constructor(
    @InjectRepository(EventAlertSetting)
    private readonly settingsRepo: Repository<EventAlertSetting>,
    @InjectRepository(TwitchConnection)
    private readonly connRepo: Repository<TwitchConnection>,
    @InjectRepository(PlatformEventSubscription)
    private readonly platformSubRepo: Repository<PlatformEventSubscription>,
    private readonly dispatcher: TwitchEventDispatcher,
    private readonly helix: TwitchHelixService,
    private readonly premium: PremiumService,
    private readonly config: ConfigService,
    @Inject(Client) private readonly discord: Client,
  ) {}

  onModuleInit(): void {
    this.dispatcher.on('channel.follow', (e) => this.onFollow(e));
    this.dispatcher.on('channel.subscribe', (e) => this.onSub(e, 'sub'));
    this.dispatcher.on('channel.subscription.message', (e) => this.onResub(e));
    this.dispatcher.on('channel.subscription.gift', (e) => this.onGift(e));
    this.dispatcher.on('channel.cheer', (e) => this.onBits(e));
    this.dispatcher.on('channel.raid', (e) => this.onRaid(e));
    this.dispatcher.on('channel.hype_train.end', (e) => this.onHypeTrain(e));
  }

  // ── Settings CRUD ───────────────────────────────────────

  async getSettings(guildId: string): Promise<EventAlertSetting[]> {
    const rows = await this.settingsRepo.find({ where: { guildId } });
    const byType = new Map(rows.map((r) => [r.eventType, r]));
    // Materialise defaults for missing types so the UI always sees all 7.
    for (const type of ALERT_EVENT_TYPES) {
      if (!byType.has(type)) {
        byType.set(
          type,
          this.settingsRepo.create({
            guildId,
            eventType: type,
            enabled: false,
            channelId: null,
            format: 'text',
            template: null,
            cardConfig: null,
          }),
        );
      }
    }
    return [...byType.values()];
  }

  async updateSetting(
    guildId: string,
    eventType: AlertEventType,
    patch: Partial<Pick<EventAlertSetting, 'enabled' | 'channelId' | 'format' | 'template' | 'cardConfig'>>,
  ): Promise<EventAlertSetting> {
    let row = await this.settingsRepo.findOne({ where: { guildId, eventType } });
    if (!row) {
      row = this.settingsRepo.create({
        guildId,
        eventType,
        enabled: false,
        channelId: null,
        format: 'text',
        template: null,
        cardConfig: null,
      });
    }
    // §3.3 tier gate: free stays на простом тексте.
    if (patch.format && patch.format !== 'text' && !(await this.premium.isPremium(guildId))) {
      patch.format = 'text';
    }
    Object.assign(row, patch);
    return this.settingsRepo.save(row);
  }

  /** §3.4 — "copy card settings to all event types". */
  async copyCardToAll(guildId: string, fromType: AlertEventType): Promise<void> {
    const src = await this.settingsRepo.findOne({ where: { guildId, eventType: fromType } });
    if (!src?.cardConfig) return;
    for (const type of ALERT_EVENT_TYPES) {
      if (type === fromType) continue;
      await this.updateSetting(guildId, type, { cardConfig: src.cardConfig });
    }
  }

  // ── EventSub subscriptions on connect (TZ-A §1.4/§3.1) ──

  /** Create the 7 event subscriptions for a freshly connected streamer. */
  async ensureEventSubscriptions(conn: TwitchConnection): Promise<void> {
    const callback = this.config.get<string>('TWITCH_WEBHOOK_CALLBACK_URL');
    const secret = this.config.get<string>('TWITCH_WEBHOOK_SECRET');
    if (!callback || !secret) return;
    for (const type of ALERT_EVENT_TYPES) {
      const spec = EVENTSUB_FOR[type];
      const existing = await this.platformSubRepo.findOne({
        where: { streamSubscriptionId: conn.id, eventType: spec.type },
      });
      if (existing?.platformSubscriptionId) continue;
      try {
        const created = await this.helix.createWebhookSubscription({
          type: spec.type,
          version: spec.version,
          condition: spec.cond(conn.twitchUserId),
          callback,
          secret,
        });
        await this.platformSubRepo.save(
          this.platformSubRepo.create({
            // Reusing the bookkeeping table: for alert subs the "stream
            // subscription id" slot holds the twitch_connections row id.
            streamSubscriptionId: conn.id,
            platform: 'twitch',
            eventType: spec.type,
            platformSubscriptionId: created.id,
          }),
        );
      } catch (e) {
        this.logger.warn(`EventSub ${spec.type} for ${conn.twitchLogin} failed: ${(e as Error).message}`);
      }
    }
  }

  /** §1.4 Disconnect: drop the alert subscriptions of this connection. */
  async removeEventSubscriptions(connectionId: string): Promise<void> {
    const rows = await this.platformSubRepo.find({ where: { streamSubscriptionId: connectionId } });
    for (const row of rows) {
      if (row.platformSubscriptionId) {
        await this.helix.deleteEventSubSubscription(row.platformSubscriptionId).catch(() => null);
      }
      await this.platformSubRepo.delete({ id: row.id });
    }
  }

  // ── Event handlers ──────────────────────────────────────

  private async guildsFor(broadcasterId: string): Promise<TwitchConnection[]> {
    return this.connRepo.find({ where: { twitchUserId: broadcasterId, status: 'active' } });
  }

  private async onFollow(e: Record<string, unknown>) {
    for (const conn of await this.guildsFor(String(e.broadcaster_user_id ?? ''))) {
      // §3.5 follow storm: aggregate if >10/min.
      const key = conn.guildId;
      let w = this.followWindows.get(key);
      const now = Date.now();
      if (!w || now - w.windowStart > 60_000) {
        w = { count: 0, users: [], windowStart: now, timer: null };
        this.followWindows.set(key, w);
      }
      w.count += 1;
      if (w.users.length < 10) w.users.push(String(e.user_name ?? 'Someone'));
      if (w.count <= 10) {
        await this.deliver(conn.guildId, 'follow', {
          user: String(e.user_name ?? 'Someone'),
          streamer: String(e.broadcaster_user_name ?? conn.twitchLogin),
        });
      } else if (!w.timer) {
        const snapshot = w;
        snapshot.timer = setTimeout(() => {
          this.followWindows.delete(key);
          void this.deliver(conn.guildId, 'follow', {
            user: `${snapshot.count} new followers`,
            streamer: conn.twitchLogin,
          });
        }, 60_000);
        snapshot.timer.unref?.();
      }
    }
  }

  private async onSub(e: Record<string, unknown>, type: 'sub') {
    if (e.is_gift) return; // gifts are announced by the gift handler
    for (const conn of await this.guildsFor(String(e.broadcaster_user_id ?? ''))) {
      await this.deliver(conn.guildId, type, {
        user: String(e.user_name ?? 'Someone'),
        tier: tierLabel(String(e.tier ?? '1000')),
        streamer: String(e.broadcaster_user_name ?? conn.twitchLogin),
      });
    }
  }

  private async onResub(e: Record<string, unknown>) {
    for (const conn of await this.guildsFor(String(e.broadcaster_user_id ?? ''))) {
      await this.deliver(conn.guildId, 'resub', {
        user: String(e.user_name ?? 'Someone'),
        tier: tierLabel(String(e.tier ?? '1000')),
        months: Number(e.cumulative_months ?? 1),
        message: String((e.message as { text?: string } | undefined)?.text ?? ''),
        streamer: String(e.broadcaster_user_name ?? conn.twitchLogin),
      });
    }
  }

  private async onGift(e: Record<string, unknown>) {
    for (const conn of await this.guildsFor(String(e.broadcaster_user_id ?? ''))) {
      // §3.5 gift bomb: aggregate per gifter in a 60s window → ONE message.
      const gifter = String(e.user_name ?? 'Anonymous');
      const key = `${conn.guildId}:${gifter}`;
      const total = Number(e.total ?? 1);
      const existing = this.giftWindows.get(key);
      if (existing) {
        existing.count += total;
        existing.vars.amount = existing.count;
        return;
      }
      const vars: AlertVars = {
        user: gifter,
        amount: total,
        tier: tierLabel(String(e.tier ?? '1000')),
        streamer: String(e.broadcaster_user_name ?? conn.twitchLogin),
      };
      const timer = setTimeout(() => {
        const w = this.giftWindows.get(key);
        this.giftWindows.delete(key);
        if (w) void this.deliver(conn.guildId, 'gift', w.vars);
      }, 60_000);
      timer.unref?.();
      this.giftWindows.set(key, { count: total, timer, vars });
    }
  }

  private async onBits(e: Record<string, unknown>) {
    for (const conn of await this.guildsFor(String(e.broadcaster_user_id ?? ''))) {
      await this.deliver(conn.guildId, 'bits', {
        user: e.is_anonymous ? 'Anonymous' : String(e.user_name ?? 'Someone'),
        amount: Number(e.bits ?? 0),
        message: String(e.message ?? ''),
        streamer: String(e.broadcaster_user_name ?? conn.twitchLogin),
      });
    }
  }

  private async onRaid(e: Record<string, unknown>) {
    for (const conn of await this.guildsFor(String(e.to_broadcaster_user_id ?? ''))) {
      await this.deliver(conn.guildId, 'raid', {
        user: String(e.from_broadcaster_user_name ?? 'Someone'),
        viewers: Number(e.viewers ?? 0),
        streamer: String(e.to_broadcaster_user_name ?? conn.twitchLogin),
      });
    }
  }

  private async onHypeTrain(e: Record<string, unknown>) {
    for (const conn of await this.guildsFor(String(e.broadcaster_user_id ?? ''))) {
      const top = (e.top_contributions as { user_name?: string; type?: string; total?: number }[] | undefined) ?? [];
      const topLine = top
        .slice(0, 3)
        .map((c) => `${c.user_name} (${c.total} ${c.type})`)
        .join(', ');
      await this.deliver(conn.guildId, 'hype_train', {
        user: topLine || '—',
        amount: Number(e.level ?? 1),
        streamer: conn.twitchLogin,
      });
    }
  }

  // ── Delivery (§3.2-3.5) ─────────────────────────────────

  private renderTemplate(template: string, vars: AlertVars): string {
    return template
      .replaceAll('{user}', String(vars.user ?? ''))
      .replaceAll('{amount}', String(vars.amount ?? ''))
      .replaceAll('{tier}', String(vars.tier ?? ''))
      .replaceAll('{message}', String(vars.message ?? ''))
      .replaceAll('{streamer}', String(vars.streamer ?? ''))
      .replaceAll('{months}', String(vars.months ?? ''))
      .replaceAll('{viewers}', String(vars.viewers ?? ''));
  }

  /** Rate limit: ≤10 alert posts/min per guild; overflow → one aggregate. */
  private allowPost(guildId: string): boolean {
    const now = Date.now();
    const times = (this.postTimestamps.get(guildId) ?? []).filter((t) => now - t < 60_000);
    if (times.length >= 10) {
      this.overflow.set(guildId, (this.overflow.get(guildId) ?? 0) + 1);
      return false;
    }
    times.push(now);
    this.postTimestamps.set(guildId, times);
    return true;
  }

  async deliver(guildId: string, type: AlertEventType, vars: AlertVars, test = false): Promise<void> {
    const setting = await this.settingsRepo.findOne({ where: { guildId, eventType: type } });
    if (!test && (!setting?.enabled || !setting.channelId)) return;
    const channelId = setting?.channelId;
    if (!channelId) return;
    const guild = this.discord.guilds.cache.get(guildId);
    const channel = guild?.channels.cache.get(channelId);
    if (!channel?.isTextBased()) return;

    if (!test && !this.allowPost(guildId)) return;
    const suppressed = this.overflow.get(guildId) ?? 0;
    if (suppressed > 0 && !test) this.overflow.delete(guildId);

    const isPremium = await this.premium.isPremium(guildId);
    const format = isPremium ? (setting?.format ?? 'text') : 'text'; // §3.3
    const text = this.renderTemplate(setting?.template?.trim() || DEFAULT_TEMPLATES[type], vars);
    const suffix = suppressed > 0 ? `\n(+${suppressed} more events aggregated)` : '';

    const send = async () => {
      if (format === 'card' && setting?.cardConfig) {
        const buffer = await this.renderCard(setting.cardConfig, text).catch(() => null);
        if (buffer) {
          await (channel as TextChannel).send({
            files: [new AttachmentBuilder(buffer, { name: 'alert.png' })],
            content: suffix || undefined,
          });
          return;
        }
        // §3.4 fallback → embed on render failure.
      }
      if (format === 'embed' || format === 'card') {
        const embed = new EmbedBuilder().setColor(0x9146ff).setDescription(text + suffix).setTimestamp(new Date());
        await (channel as TextChannel).send({ embeds: [embed] });
        return;
      }
      await (channel as TextChannel).send({ content: text + suffix });
    };

    // §3.4: render/post through a queue — never block the webhook handler.
    this.renderQueue.push(async () => {
      try {
        await send();
      } catch (e) {
        this.logger.warn(`alert delivery failed (${guildId}/${type}): ${(e as Error).message}`);
      }
    });
    void this.drainQueue();
  }

  private async drainQueue(): Promise<void> {
    if (this.rendering) return;
    this.rendering = true;
    while (this.renderQueue.length) {
      const job = this.renderQueue.shift()!;
      await job();
    }
    this.rendering = false;
  }

  /** §3.6 — test alert with fake data. */
  async sendTest(guildId: string, type: AlertEventType): Promise<void> {
    const fake: Record<AlertEventType, AlertVars> = {
      follow: { user: 'TestUser', streamer: 'YourChannel' },
      sub: { user: 'TestUser', tier: '1', streamer: 'YourChannel' },
      resub: { user: 'TestUser', tier: '2', months: 7, message: 'Love this stream!', streamer: 'YourChannel' },
      gift: { user: 'GenerousViewer', amount: 5, tier: '1', streamer: 'YourChannel' },
      bits: { user: 'TestUser', amount: 500, message: 'PogChamp', streamer: 'YourChannel' },
      raid: { user: 'FriendlyStreamer', viewers: 123, streamer: 'YourChannel' },
      hype_train: { user: 'Fan1 (500 bits), Fan2 (3 subs)', amount: 3, streamer: 'YourChannel' },
    };
    await this.deliver(guildId, type, fake[type], true);
  }

  // ── Image Card renderer (§3.4, welcome-engine style canvas) ─

  private async renderCard(cardConfig: Record<string, unknown>, text: string): Promise<Buffer> {
    const W = 900;
    const H = 300;
    const cfg = cardConfig as { backgroundUrl?: string; textColor?: string; font?: string };
    // GIF backgrounds can't take text overlay (§ test checklist) — the caller
    // falls back before we get here if the URL ends with .gif.
    if (cfg.backgroundUrl?.toLowerCase().endsWith('.gif')) throw new Error('gif background — no overlay');

    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#18181b';
    ctx.fillRect(0, 0, W, H);
    if (cfg.backgroundUrl) {
      try {
        const img = await loadImage(cfg.backgroundUrl);
        ctx.drawImage(img, 0, 0, W, H);
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fillRect(0, 0, W, H);
      } catch {
        /* keep solid background */
      }
    }
    const family = ['sans-serif', 'serif', 'monospace'].includes(cfg.font ?? '') ? cfg.font! : 'sans-serif';
    ctx.fillStyle = cfg.textColor ?? '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Wrap the text across up to 3 lines.
    const words = text.split(' ');
    const lines: string[] = [];
    let line = '';
    ctx.font = `bold 42px ${family}`;
    for (const wrd of words) {
      const probe = line ? `${line} ${wrd}` : wrd;
      if (ctx.measureText(probe).width > W - 120 && line) {
        lines.push(line);
        line = wrd;
      } else line = probe;
      if (lines.length === 2) break;
    }
    if (line) lines.push(line);
    const startY = H / 2 - ((lines.length - 1) * 50) / 2;
    ctx.shadowColor = 'rgba(0,0,0,0.7)';
    ctx.shadowBlur = 8;
    lines.forEach((l, i) => ctx.fillText(l, W / 2, startY + i * 50));
    return canvas.toBuffer('image/png');
  }
}

function tierLabel(tier: string): string {
  return tier === '3000' ? '3' : tier === '2000' ? '2' : '1';
}
