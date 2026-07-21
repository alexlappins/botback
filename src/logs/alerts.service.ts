import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Client, EmbedBuilder, Guild, Message, TextChannel } from 'discord.js';

import { PremiumService } from '../premium/premium.service';
import { SecurityBridge } from '../common/security-bridge.service';
import { AlertLog } from './entities/alert-log.entity';
import { AlertSettings } from './entities/alert-settings.entity';
import { ALERTS_CONFIG, DETECTOR_SEVERITY } from './alerts.config';
import { LogSettingsService } from './log-settings.service';

type DetectorId = 'd1' | 'd2' | 'd3' | 'd4' | 'd5' | 'd6' | 'd7' | 'd8' | 'd9';

interface AlertPayload {
  title: string;
  lines: string[];
  whyItMatters: string;
  actorUserId?: string | null;
}

/** One live aggregated alert (edited in place as the situation develops). */
interface ActiveAlert {
  firstFiredAt: number;
  lastUpdateAt: number;
  count: number;
  messages: { channelId?: string; messageId: string; dm?: boolean; userId?: string }[];
  settleTimer?: NodeJS.Timeout;
}

/** Sliding window of timestamps with per-key metadata. */
class Window {
  private items = new Map<string, { ts: number; meta?: Record<string, unknown> }[]>();

  push(key: string, windowMs: number, meta?: Record<string, unknown>): number {
    const now = Date.now();
    const arr = (this.items.get(key) ?? []).filter((e) => now - e.ts < windowMs);
    arr.push({ ts: now, meta });
    this.items.set(key, arr);
    return arr.length;
  }

  entries(key: string, windowMs: number) {
    const now = Date.now();
    return (this.items.get(key) ?? []).filter((e) => now - e.ts < windowMs);
  }
}

/**
 * Server Alerts watchdog (TZ §4-§5). PREMIUM feature: every entry point
 * checks PremiumService.isPremium() — free guilds keep their settings but
 * detectors are inert (standard project principle).
 *
 * Detectors are fed by LogsListeners (the ONE gateway stream, TZ §7) via the
 * public `on*` methods below. Every handler is wrapped so a detector crash
 * can never break logging.
 */
@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);

  private joins = new Window(); // d1
  private deletions = new Window(); // d2
  private modActions = new Window(); // d3
  private leaves = new Window(); // d5
  private selfDeletes = new Window(); // d8
  private cooldowns = new Map<string, number>(); // `${guildId}:${detector}` → last fired
  private active = new Map<string, ActiveAlert>(); // aggregation (TZ §4.3)

  constructor(
    @InjectRepository(AlertSettings)
    private readonly settingsRepo: Repository<AlertSettings>,
    @InjectRepository(AlertLog)
    private readonly logRepo: Repository<AlertLog>,
    private readonly premium: PremiumService,
    private readonly logSettings: LogSettingsService,
    private readonly bridge: SecurityBridge,
    @Inject(Client) private readonly client: Client,
  ) {
    // Security Suite (§3.5 etc.) notifies alert recipients through us.
    this.bridge.notifyRecipients = (guildId, title, lines, severity) =>
      this.notifyFromSecurity(guildId, title, lines, severity);
  }

  /** Direct notification path for the Security Suite (no detector/cooldown). */
  private async notifyFromSecurity(
    guildId: string,
    title: string,
    lines: string[],
    severity: 'critical' | 'warning',
  ): Promise<void> {
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) return;
    const settings = await this.getSettings(guildId);
    const emoji = severity === 'critical' ? '🚨' : '⚠️';
    const embed = new EmbedBuilder()
      .setColor(severity === 'critical' ? 0xed4245 : 0xfee75c)
      .setTitle(`${emoji} ${title}`)
      .setDescription(lines.join('\n'))
      .addFields({ name: 'Server', value: guild.name, inline: true })
      .setTimestamp(new Date());
    const recipientIds = [...new Set([guild.ownerId, ...settings.recipients])];
    for (const userId of recipientIds) {
      const viaDm = await this.tryDm(userId, embed);
      if (!viaDm) await this.tryChannelPing(guild, userId, embed);
    }
  }

  // ── Settings API (used by the controller) ───────────────

  async getSettings(guildId: string): Promise<AlertSettings> {
    let row = await this.settingsRepo.findOne({ where: { guildId } });
    // repo.create() does NOT apply column defaults (they're DB-side, applied
    // on INSERT) — spell them out or `recipients.map` crashes on fresh guilds.
    if (!row) {
      row = this.settingsRepo.create({
        guildId,
        enabled: false,
        recipients: [],
        d1Enabled: true,
        d2Enabled: true,
        d3Enabled: true,
        d4Enabled: true,
        d5Enabled: true,
        d6Enabled: true,
        d7Enabled: true,
        d8Enabled: true,
        d9Enabled: true,
      });
    }
    return row;
  }

  async updateSettings(
    guildId: string,
    patch: Partial<Pick<AlertSettings, 'enabled' | 'recipients'>> &
      Partial<Record<`d${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}Enabled`, boolean>>,
  ): Promise<AlertSettings> {
    const row = await this.getSettings(guildId);
    if (patch.enabled !== undefined) row.enabled = patch.enabled;
    if (patch.recipients !== undefined) row.recipients = patch.recipients.slice(0, 3);
    for (const i of [1, 2, 3, 4, 5, 6, 7, 8, 9] as const) {
      const key = `d${i}Enabled` as const;
      if (patch[key] !== undefined) (row as unknown as Record<string, unknown>)[key] = patch[key];
    }
    return this.settingsRepo.save(row);
  }

  // ── Event intake (called from LogsListeners; never throws) ─

  onMemberJoin(guild: Guild, userId: string, userTag: string, accountCreatedAt: number, isBot: boolean, inviterTag?: string | null) {
    void this.safe(async () => {
      if (isBot) {
        await this.detectBotAdded(guild, userId, userTag, inviterTag ?? null); // d7
        return;
      }
      await this.detectRaid(guild, userId, userTag, accountCreatedAt); // d1
    });
  }

  onMemberLeave(guild: Guild) {
    void this.safe(() => this.detectLeaveWave(guild)); // d5
  }

  onDestructiveAction(guild: Guild, kind: 'channel_delete' | 'role_delete', executorId: string | null, executorTag: string | null) {
    void this.safe(() => this.detectNuke(guild, kind, executorId, executorTag)); // d2
  }

  onModPunishment(guild: Guild, kind: 'ban' | 'kick', executorId: string | null, executorTag: string | null) {
    void this.safe(() => this.detectMassModeration(guild, kind, executorId, executorTag)); // d3
  }

  onDangerousGrant(guild: Guild, summary: string, actorId: string | null, actorTag: string | null) {
    void this.safe(() =>
      this.fire(guild, 'd4', {
        title: 'Dangerous permissions granted',
        lines: [summary, actorTag ? `By: **${actorTag}**` : 'By: unknown (no audit access)'],
        whyItMatters: 'These permissions allow full control over the server — verify this was intended.',
        actorUserId: actorId,
      }),
    );
  }

  onForeignWebhook(guild: Guild, channelName: string, webhookName: string, actorId: string | null, actorTag: string | null) {
    void this.safe(() =>
      this.fire(guild, 'd6', {
        title: 'New webhook created',
        lines: [
          `Webhook **${webhookName}** in #${channelName}`,
          actorTag ? `Created by: **${actorTag}**` : 'Created by: unknown (no audit access)',
        ],
        whyItMatters: 'Webhooks can post as anyone in your server — delete it if you don’t recognise it.',
        actorUserId: actorId,
      }),
    );
  }

  onSelfMessageDelete(guild: Guild, authorId: string, authorTag: string) {
    void this.safe(async () => {
      const count = this.selfDeletes.push(`${guild.id}:${authorId}`, ALERTS_CONFIG.d8.windowMs);
      if (count === ALERTS_CONFIG.d8.deletions) {
        await this.fire(guild, 'd8', {
          title: 'Mass self-deletion of messages',
          lines: [`**${authorTag}** deleted ${count}+ of their own messages within 5 minutes.`],
          whyItMatters: 'Users wiping their history may be covering tracks after scam/spam.',
          actorUserId: authorId,
        });
      }
    });
  }

  onGuildSettingsChange(guild: Guild, changes: string[], verificationLowered: boolean, actorId: string | null, actorTag: string | null) {
    void this.safe(async () => {
      if (changes.length === 0 && !verificationLowered) return;
      const lines = [...changes];
      if (verificationLowered) lines.push('⚠️ Verification level was **lowered**.');
      lines.push(actorTag ? `By: **${actorTag}**` : 'By: unknown (no audit access)');
      await this.fire(guild, 'd9', {
        title: 'Critical server settings changed',
        lines,
        whyItMatters: 'Name/vanity/verification changes are a common defacement or takeover sign.',
        actorUserId: actorId,
      });
    });
  }

  // ── Detectors ───────────────────────────────────────────

  private async detectRaid(guild: Guild, userId: string, userTag: string, accountCreatedAt: number) {
    const cfg = ALERTS_CONFIG.d1;
    const mult = this.bridge.thresholdMultiplier(guild.id);
    this.joins.push(guild.id, cfg.windowMs, { userId, userTag, accountCreatedAt });
    const entries = this.joins.entries(guild.id, cfg.windowMs);
    const young = entries.filter(
      (e) => Date.now() - ((e.meta?.accountCreatedAt as number) ?? 0) < cfg.youngAccountDays * 86_400_000,
    );
    const minJoins = Math.max(3, Math.ceil(cfg.minJoins * mult));
    const hardJoins = Math.max(5, Math.ceil(cfg.hardJoins * mult));
    const trigA = entries.length >= minJoins && young.length / entries.length >= cfg.youngShare;
    const trigB = entries.length >= hardJoins;

    // §4: inside an open incident every new join gets the auto-action.
    const actionNotes: string[] = [];
    if (trigA || trigB) {
      if (this.raidIncidentJustOpened(guild.id)) {
        const startNotes = (await this.bridge.onRaidStart?.(guild)) ?? [];
        actionNotes.push(...startNotes);
      }
      const joinNotes = (await this.bridge.onRaidJoin?.(guild, userId)) ?? [];
      actionNotes.push(...joinNotes);
    }
    if (!trigA && !trigB) return;

    const avgAgeDays = Math.round(
      entries.reduce((s, e) => s + (Date.now() - ((e.meta?.accountCreatedAt as number) ?? Date.now())), 0) /
        entries.length /
        86_400_000,
    );
    const firstTen = entries
      .slice(0, 10)
      .map((e) => `• ${(e.meta?.userTag as string) ?? 'unknown'}`)
      .join('\n');
    await this.fire(
      guild,
      'd1',
      {
        title: 'Possible raid in progress',
        lines: [
          `**${entries.length} accounts** joined within 10 minutes.`,
          `Average account age: ~${avgAgeDays} day(s).`,
          `First joins:\n${firstTen}`,
          ...actionNotes.slice(-12),
        ],
        whyItMatters: 'Coordinated joins of fresh accounts usually precede spam or a takeover attempt.',
      },
      { aggregateCount: entries.length, settleMs: cfg.settleMs },
    );
  }

  /** True exactly once per raid incident (until settle clears the active alert). */
  private openRaids = new Set<string>();
  private raidIncidentJustOpened(guildId: string): boolean {
    if (this.openRaids.has(guildId)) return false;
    this.openRaids.add(guildId);
    setTimeout(() => this.openRaids.delete(guildId), ALERTS_CONFIG.d1.settleMs + ALERTS_CONFIG.d1.windowMs).unref?.();
    return true;
  }

  private async detectNuke(guild: Guild, kind: string, executorId: string | null, executorTag: string | null) {
    if (!executorId || executorId === this.client.user?.id) return; // own actions ignored
    // §1.2 Whitelist: not counted, but the owner still gets a low-key alert.
    if (await this.bridge.isWhitelisted(guild.id, executorId)) {
      await this.notifyFromSecurity(
        guild.id,
        'Whitelisted user activity',
        [`**${executorTag ?? executorId}** (whitelisted) performed a ${kind.replace('_', ' ')}.`],
        'warning',
      ).catch(() => null);
      return;
    }
    const cfg = ALERTS_CONFIG.d2;
    const mult = this.bridge.thresholdMultiplier(guild.id);
    const count = this.deletions.push(`${guild.id}:${executorId}`, cfg.windowMs, { kind });
    if (count < Math.max(2, Math.ceil(cfg.deletions * mult))) return;
    const auto = (await this.bridge.onNukeExecutor?.(guild, 'd2', executorId)) ?? { notes: [], incidentId: null };
    await this.fire(
      guild,
      'd2',
      {
        title: 'Mass deletion of channels/roles',
        lines: [
          `**${executorTag ?? executorId}** deleted **${count}** channels/roles within 10 minutes.`,
          ...auto.notes,
        ],
        whyItMatters: 'This is the signature of a nuke attack — consider removing their permissions NOW.',
        actorUserId: executorId,
      },
      { aggregateCount: count },
    );
  }

  private async detectMassModeration(guild: Guild, kind: string, executorId: string | null, executorTag: string | null) {
    if (!executorId || executorId === this.client.user?.id) return;
    if (await this.bridge.isWhitelisted(guild.id, executorId)) {
      await this.notifyFromSecurity(
        guild.id,
        'Whitelisted user activity',
        [`**${executorTag ?? executorId}** (whitelisted) performed a ${kind}.`],
        'warning',
      ).catch(() => null);
      return;
    }
    const cfg = ALERTS_CONFIG.d3;
    const mult = this.bridge.thresholdMultiplier(guild.id);
    const count = this.modActions.push(`${guild.id}:${executorId}`, cfg.windowMs, { kind });
    if (count < Math.max(2, Math.ceil(cfg.actions * mult))) return;
    const auto = (await this.bridge.onNukeExecutor?.(guild, 'd3', executorId)) ?? { notes: [], incidentId: null };
    await this.fire(
      guild,
      'd3',
      {
        title: 'Mass bans/kicks by one moderator',
        lines: [
          `**${executorTag ?? executorId}** performed **${count}** bans/kicks within 10 minutes.`,
          ...auto.notes,
        ],
        whyItMatters: 'A compromised or rogue moderator account can empty a server in minutes.',
        actorUserId: executorId,
      },
      { aggregateCount: count },
    );
  }

  private async detectLeaveWave(guild: Guild) {
    const cfg = ALERTS_CONFIG.d5;
    const count = this.leaves.push(guild.id, cfg.windowMs);
    const threshold = Math.max(cfg.minLeaves, Math.ceil(cfg.leaveShare * guild.memberCount));
    if (count < threshold) return;
    await this.fire(
      guild,
      'd5',
      {
        title: 'Unusual wave of members leaving',
        lines: [`**${count} members** left within the last hour (threshold: ${threshold}).`],
        whyItMatters: 'Mass exits often follow drama, raids or a scam post — worth checking what happened.',
      },
      { cooldownMs: cfg.cooldownMs, aggregateCount: count },
    );
  }

  private async detectBotAdded(guild: Guild, botId: string, botTag: string, inviterTag: string | null) {
    if (botId === this.client.user?.id) return;
    const member = guild.members.cache.get(botId);
    const perms = member?.permissions.toArray().slice(0, 8).join(', ') ?? 'unknown';
    await this.fire(guild, 'd7', {
      title: 'A bot was added to the server',
      lines: [
        `Bot: **${botTag}**`,
        inviterTag ? `Added by: **${inviterTag}**` : 'Added by: unknown (no audit access)',
        `Permissions: ${perms}`,
      ],
      whyItMatters: 'Malicious bots are the #1 server takeover vector — verify you trust this one.',
    });
  }

  // ── Firing / delivery / aggregation ─────────────────────

  private async safe(fn: () => Promise<unknown> | unknown): Promise<void> {
    try {
      await fn();
    } catch (e) {
      // TZ §7: a detector crash must never break logging.
      this.logger.error(`alert detector failed: ${(e as Error).message}`);
    }
  }

  private async isArmed(guild: Guild, detector: DetectorId): Promise<AlertSettings | null> {
    if (!(await this.premium.isPremium(guild.id))) return null;
    const settings = await this.getSettings(guild.id);
    if (!settings.enabled) return null;
    const key = `${detector}Enabled` as keyof AlertSettings;
    if (!(settings[key] as boolean)) return null;
    return settings;
  }

  private async fire(
    guild: Guild,
    detector: DetectorId,
    payload: AlertPayload,
    opts: { cooldownMs?: number; aggregateCount?: number; settleMs?: number } = {},
  ): Promise<void> {
    const settings = await this.isArmed(guild, detector);
    if (!settings) return;

    const key = `${guild.id}:${detector}`;
    const activeAlert = this.active.get(key);

    // Aggregation (TZ §4.3): while an alert of this type is live, UPDATE it.
    if (activeAlert && opts.aggregateCount !== undefined) {
      activeAlert.count = opts.aggregateCount;
      activeAlert.lastUpdateAt = Date.now();
      await this.editAlertMessages(guild, detector, payload, activeAlert);
      if (opts.settleMs) this.armSettleTimer(key, guild, detector, payload, opts.settleMs);
      return;
    }

    // Cooldown (TZ §4.3): same type on same guild ≤ 30 min → suppress.
    const cooldown = opts.cooldownMs ?? ALERTS_CONFIG.cooldownMs;
    const last = this.cooldowns.get(key) ?? 0;
    if (Date.now() - last < cooldown) return;
    this.cooldowns.set(key, Date.now());

    const embed = this.buildEmbed(guild, detector, payload);
    // §7 — action buttons; incident id = a fresh uuid-ish key.
    const incidentId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const components = (this.bridge.alertComponents?.(guild.id, detector, incidentId, payload.actorUserId ?? null) ??
      []) as never[];
    const sent: ActiveAlert = {
      firstFiredAt: Date.now(),
      lastUpdateAt: Date.now(),
      count: opts.aggregateCount ?? 1,
      messages: [],
    };

    // Recipients: owner ALWAYS + up to 3 picked members (TZ §4.1).
    const recipientIds = [...new Set([guild.ownerId, ...settings.recipients])];
    for (const userId of recipientIds) {
      const viaDm = await this.tryDm(userId, embed, components);
      if (viaDm) {
        sent.messages.push({ messageId: viaDm.id, dm: true, userId });
      } else {
        // Fallback: ping in the Server preset log channel (TZ §4.2).
        const fallback = await this.tryChannelPing(guild, userId, embed, components);
        if (fallback) sent.messages.push({ channelId: fallback.channelId, messageId: fallback.id });
      }
    }

    this.active.set(key, sent);
    if (opts.settleMs) this.armSettleTimer(key, guild, detector, payload, opts.settleMs);
    else setTimeout(() => this.active.delete(key), 15 * 60 * 1000).unref?.();

    await this.logRepo
      .save(
        this.logRepo.create({
          guildId: guild.id,
          detector,
          severity: DETECTOR_SEVERITY[detector],
          summary: `${payload.title} — ${payload.lines[0] ?? ''}`.slice(0, 900),
          actorUserId: payload.actorUserId ?? null,
        }),
      )
      .catch(() => null);
  }

  /** d1: after N quiet minutes, append the final summary and close aggregation. */
  private armSettleTimer(key: string, guild: Guild, detector: DetectorId, payload: AlertPayload, settleMs: number) {
    const alert = this.active.get(key);
    if (!alert) return;
    if (alert.settleTimer) clearTimeout(alert.settleTimer);
    alert.settleTimer = setTimeout(() => {
      void this.safe(async () => {
        const a = this.active.get(key);
        if (!a) return;
        this.active.delete(key);
        const final: AlertPayload = {
          ...payload,
          title: `${payload.title} — situation settled`,
          lines: [`Final count: **${a.count}** events.`, ...payload.lines.slice(1)],
        };
        await this.editAlertMessages(guild, detector, final, a);
      });
    }, settleMs);
    alert.settleTimer.unref?.();
  }

  private buildEmbed(guild: Guild, detector: DetectorId, payload: AlertPayload): EmbedBuilder {
    const severity = DETECTOR_SEVERITY[detector];
    const emoji = severity === 'critical' ? '🚨' : '⚠️';
    return new EmbedBuilder()
      .setColor(severity === 'critical' ? 0xed4245 : 0xfee75c)
      .setTitle(`${emoji} ${payload.title}`)
      .setDescription(payload.lines.join('\n'))
      .addFields(
        { name: 'Server', value: guild.name, inline: true },
        { name: 'When', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true },
        { name: 'Why it matters', value: payload.whyItMatters, inline: false },
      );
  }

  private async editAlertMessages(guild: Guild, detector: DetectorId, payload: AlertPayload, alert: ActiveAlert) {
    const embed = this.buildEmbed(guild, detector, payload);
    for (const ref of alert.messages) {
      try {
        if (ref.dm && ref.userId) {
          const user = await this.client.users.fetch(ref.userId);
          const dm = await user.createDM();
          const msg = await dm.messages.fetch(ref.messageId);
          await msg.edit({ embeds: [embed] });
        } else if (ref.channelId) {
          const channel = guild.channels.cache.get(ref.channelId);
          if (channel?.isTextBased()) {
            const msg = await (channel as TextChannel).messages.fetch(ref.messageId);
            await msg.edit({ embeds: [embed] });
          }
        }
      } catch {
        // message gone / DM closed since — nothing to update
      }
    }
  }

  private async tryDm(userId: string, embed: EmbedBuilder, components: never[] = []): Promise<Message | null> {
    try {
      const user = await this.client.users.fetch(userId);
      return await user.send({ embeds: [embed], components });
    } catch {
      return null; // DMs closed
    }
  }

  private async tryChannelPing(
    guild: Guild,
    userId: string,
    embed: EmbedBuilder,
    components: never[] = [],
  ): Promise<{ id: string; channelId: string } | null> {
    const channelId = this.logSettings.channelFor(guild.id, 'server');
    if (!channelId) return null;
    const channel = guild.channels.cache.get(channelId);
    if (!channel?.isTextBased()) return null;
    try {
      const msg = await (channel as TextChannel).send({ content: `<@${userId}>`, embeds: [embed], components });
      return { id: msg.id, channelId };
    } catch {
      return null;
    }
  }
}
