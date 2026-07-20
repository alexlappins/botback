import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Guild, GuildMember } from 'discord.js';

import { SecurityBridge, type JoinVerdict } from '../common/security-bridge.service';
import { PremiumService } from '../premium/premium.service';
import {
  SecuritySettings,
  SecurityWhitelistEntry,
  type SecurityPreset,
} from './entities/security.entities';

const DEFAULT_KICK_MESSAGE =
  'This server requires accounts older than {days} days. Please try again later.';

/**
 * Security Suite core (Security TZ): settings, whitelist (§1), Age Filter
 * join gate (§2), presets (§9). Registers itself on the SecurityBridge so
 * welcome/leveling/logs consume it without module cycles.
 */
@Injectable()
export class SecurityService implements OnModuleInit {
  private readonly logger = new Logger(SecurityService.name);
  /** Memoized join verdicts: `${guildId}:${userId}:${joinTs}` → promise (§2.2). */
  private joinGates = new Map<string, Promise<JoinVerdict>>();
  /** Set by QuarantineService to avoid a service cycle. */
  quarantineHook: ((member: GuildMember, reason: string, source: string) => Promise<boolean>) | null = null;

  constructor(
    @InjectRepository(SecuritySettings)
    private readonly settingsRepo: Repository<SecuritySettings>,
    @InjectRepository(SecurityWhitelistEntry)
    private readonly whitelistRepo: Repository<SecurityWhitelistEntry>,
    private readonly premium: PremiumService,
    private readonly bridge: SecurityBridge,
  ) {}

  onModuleInit(): void {
    this.bridge.isWhitelisted = (guildId, userId) => this.isWhitelisted(guildId, userId);
    this.bridge.gateJoin = (member) => this.gateJoin(member);
  }

  // ── Settings ────────────────────────────────────────────

  async getSettings(guildId: string): Promise<SecuritySettings> {
    let row = await this.settingsRepo.findOne({ where: { guildId } });
    if (!row) row = this.settingsRepo.create({ guildId });
    return row;
  }

  async saveSettings(row: SecuritySettings): Promise<SecuritySettings> {
    return this.settingsRepo.save(row);
  }

  async updateSettings(guildId: string, patch: Partial<SecuritySettings>): Promise<SecuritySettings> {
    const row = await this.getSettings(guildId);
    Object.assign(row, patch, { guildId });
    return this.settingsRepo.save(row);
  }

  // ── §1 Whitelist ────────────────────────────────────────

  listWhitelist(guildId: string): Promise<SecurityWhitelistEntry[]> {
    return this.whitelistRepo.find({ where: { guildId }, order: { createdAt: 'ASC' } });
  }

  async addWhitelist(guildId: string, entityType: 'user' | 'role', entityId: string): Promise<SecurityWhitelistEntry> {
    const existing = await this.whitelistRepo.findOne({ where: { guildId, entityType, entityId } });
    if (existing) return existing;
    return this.whitelistRepo.save(this.whitelistRepo.create({ guildId, entityType, entityId }));
  }

  async removeWhitelist(guildId: string, id: string): Promise<void> {
    await this.whitelistRepo.delete({ id, guildId });
  }

  /** Owner is always whitelisted (§1.1); users match directly or via role. */
  async isWhitelisted(guildId: string, userId: string, member?: GuildMember | null): Promise<boolean> {
    const m = member ?? null;
    const guild = m?.guild;
    if (guild?.ownerId === userId) return true;
    const entries = await this.whitelistRepo.find({ where: { guildId } });
    if (!entries.length) return guild ? guild.ownerId === userId : false;
    for (const e of entries) {
      if (e.entityType === 'user' && e.entityId === userId) return true;
      if (e.entityType === 'role' && m?.roles.cache.has(e.entityId)) return true;
    }
    return false;
  }

  // ── §2 Age Filter join gate ─────────────────────────────

  gateJoin(member: GuildMember): Promise<JoinVerdict> {
    const key = `${member.guild.id}:${member.id}:${member.joinedTimestamp ?? 0}`;
    let gate = this.joinGates.get(key);
    if (!gate) {
      gate = this.decideJoin(member).catch((e) => {
        this.logger.warn(`age filter failed: ${(e as Error).message}`);
        return 'allow' as JoinVerdict;
      });
      this.joinGates.set(key, gate);
      setTimeout(() => this.joinGates.delete(key), 5 * 60 * 1000).unref?.();
    }
    return gate;
  }

  private async decideJoin(member: GuildMember): Promise<JoinVerdict> {
    if (member.user.bot) return 'allow'; // §2.3 — bots are D7's business
    const s = await this.getSettings(member.guild.id);
    let minDays = s.ageFilterEnabled ? s.ageFilterMinDays : 0;
    // §8.2 — Stream Shield can tighten the age filter while live.
    const shieldDays = this.shieldAgeDays?.(member.guild.id) ?? 0;
    minDays = Math.max(minDays, shieldDays);
    if (minDays <= 0) return 'allow';

    const ageDays = (Date.now() - member.user.createdTimestamp) / 86_400_000;
    if (ageDays >= minDays) return 'allow';

    if (await this.isWhitelisted(member.guild.id, member.id, member)) return 'allow';

    const action = s.ageFilterEnabled ? s.ageFilterAction : 'alert';
    if (action === 'kick') {
      const text = (s.ageFilterKickMessage?.trim() || DEFAULT_KICK_MESSAGE).replaceAll(
        '{days}',
        String(minDays),
      );
      await member.user.send(text).catch(() => null); // DM first — unreachable after kick
      const kicked = await member
        .kick(`Age filter: account younger than ${minDays} days`)
        .then(() => true)
        .catch(() => false);
      this.notify(member.guild.id, 'Age Filter: member kicked', [
        `**${member.user.tag}** — account age ${Math.floor(ageDays)} day(s), minimum ${minDays}.`,
        kicked ? 'Kicked with a DM explanation.' : '⚠️ Kick failed — missing permissions.',
      ]);
      return kicked ? 'kick' : 'allow';
    }

    if (action === 'quarantine' && (await this.premium.isPremium(member.guild.id)) && this.quarantineHook) {
      const ok = await this.quarantineHook(
        member,
        `Account younger than ${minDays} days`,
        'age_filter',
      );
      this.notify(member.guild.id, 'Age Filter: member quarantined', [
        `**${member.user.tag}** — account age ${Math.floor(ageDays)} day(s), minimum ${minDays}.`,
        ok ? 'Moved to quarantine for review.' : '⚠️ Quarantine failed — is it set up?',
      ]);
      return ok ? 'quarantine' : 'allow';
    }

    // Alert only (default).
    this.notify(member.guild.id, 'Age Filter: young account joined', [
      `**${member.user.tag}** — account age ${Math.floor(ageDays)} day(s), minimum ${minDays}.`,
      'Action: alert only.',
    ]);
    return 'allow';
  }

  /** Registered by StreamShieldService (avoids a service cycle). */
  shieldAgeDays: ((guildId: string) => number) | null = null;

  private notify(guildId: string, title: string, lines: string[]): void {
    void this.bridge.notifyRecipients?.(guildId, title, lines, 'warning').catch(() => null);
  }

  // ── §9 Presets ──────────────────────────────────────────

  /**
   * Apply a preset: overwrite the relevant fields (§9). For free guilds only
   * the free-tier fields are applied; premium fields stay untouched (the UI
   * shows them locked anyway).
   */
  async applyPreset(guildId: string, preset: SecurityPreset): Promise<SecuritySettings> {
    const row = await this.getSettings(guildId);
    const isPremium = await this.premium.isPremium(guildId);

    if (preset === 'relaxed') {
      row.ageFilterEnabled = false;
      row.panicSlowmodeEnabled = false;
      if (isPremium) {
        row.antiRaidAction = 'alert';
        row.antiNukeAction = 'alert';
        row.antiRaidAutoPanic = false;
      }
    } else if (preset === 'standard') {
      row.ageFilterEnabled = true;
      row.ageFilterMinDays = 7;
      row.ageFilterAction = 'alert';
      row.panicSlowmodeEnabled = false;
      if (isPremium) {
        row.antiRaidAction = 'quarantine';
        row.antiNukeAction = 'strip';
        row.antiRaidAutoPanic = false;
      }
    } else {
      row.ageFilterEnabled = true;
      row.ageFilterMinDays = 14;
      row.ageFilterAction = isPremium ? 'quarantine' : 'alert';
      row.panicSlowmodeEnabled = true;
      if (isPremium) {
        row.antiRaidAction = 'ban';
        row.antiNukeAction = 'strip_quarantine';
        row.antiRaidAutoPanic = true;
      }
    }
    row.preset = preset;
    return this.settingsRepo.save(row);
  }

  /** Convenience for services needing the premium flag. */
  isPremium(guildId: string): Promise<boolean> {
    return this.premium.isPremium(guildId);
  }

  /** Owner-or-whitelist permission check for buttons (§3.4, §7). */
  async canUseButtons(guild: Guild, userId: string): Promise<boolean> {
    if (guild.ownerId === userId) return true;
    const member = guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null));
    return this.isWhitelisted(guild.id, userId, member);
  }
}
