import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Guild,
  PermissionFlagsBits,
} from 'discord.js';
import { ConfigService } from '@nestjs/config';
import { Button, Context } from 'necord';
import type { ButtonContext } from 'necord';

import { SecurityBridge } from '../common/security-bridge.service';
import { NukeIncident } from './entities/security.entities';
import { PanicService } from './panic.service';
import { QuarantineService } from './quarantine.service';
import { SecurityService } from './security.service';

/** §5.1 — roles carrying any of these are "dangerous" and get stripped. */
const STRIP_PERMISSIONS = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.ManageWebhooks,
];

/**
 * Anti-Raid (§4) & Anti-Nuke (§5) auto-actions on top of detectors D1-D3,
 * plus the alert action buttons (§7). Registered on the SecurityBridge so
 * AlertsService triggers them without importing this module.
 */
@Injectable()
export class SecurityActionsService implements OnModuleInit {
  private readonly logger = new Logger(SecurityActionsService.name);
  /** Guilds with an open raid incident (auto-action new joins until it settles). */
  private raidIncidents = new Map<string, { startedAt: number }>();

  constructor(
    @InjectRepository(NukeIncident)
    private readonly nukeRepo: Repository<NukeIncident>,
    private readonly security: SecurityService,
    private readonly panic: PanicService,
    private readonly quarantine: QuarantineService,
    private readonly bridge: SecurityBridge,
    private readonly config: ConfigService,
    @Inject(Client) private readonly client: Client,
  ) {}

  onModuleInit(): void {
    this.bridge.onRaidStart = (guild) => this.onRaidStart(guild);
    this.bridge.onRaidJoin = (guild, userId) => this.onRaidJoin(guild, userId);
    this.bridge.onNukeExecutor = (guild, detector, executorId) =>
      this.onNukeExecutor(guild, detector, executorId);
    this.bridge.alertComponents = (guildId, detector, incidentId, actorUserId) =>
      this.buildAlertComponents(guildId, detector, incidentId, actorUserId);
  }

  raidIncidentOpen(guildId: string): boolean {
    return this.raidIncidents.has(guildId);
  }

  closeRaidIncident(guildId: string): void {
    this.raidIncidents.delete(guildId);
  }

  // ── §4 Anti-Raid ────────────────────────────────────────

  private async onRaidStart(guild: Guild): Promise<string[]> {
    if (!(await this.security.isPremium(guild.id))) return [];
    const settings = await this.security.getSettings(guild.id);
    this.raidIncidents.set(guild.id, { startedAt: Date.now() });
    const notes: string[] = [];
    if (settings.antiRaidAutoPanic && !(await this.panic.isActive(guild.id))) {
      const res = await this.panic.activate(guild, this.client.user?.id ?? 'bot');
      notes.push('Auto-activated Panic Mode.', ...res.notes);
    }
    if (settings.antiRaidAction !== 'alert') {
      notes.push(`Auto-action for raid joins: **${settings.antiRaidAction}**.`);
    }
    return notes;
  }

  /** Applied to each join inside an open raid incident (§4.1-4.3). */
  private async onRaidJoin(guild: Guild, userId: string): Promise<string[]> {
    if (!this.raidIncidents.has(guild.id)) return [];
    if (!(await this.security.isPremium(guild.id))) return [];
    const settings = await this.security.getSettings(guild.id);
    if (settings.antiRaidAction === 'alert') return [];

    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return [];
    if (member.user.bot) return []; // §4.3 — bots are D7's business
    if (await this.security.isWhitelisted(guild.id, userId, member)) {
      return [`↳ ${member.user.tag}: whitelisted — skipped`];
    }

    try {
      if (settings.antiRaidAction === 'quarantine') {
        const res = await this.quarantine.quarantine(member, 'Raid auto-action', 'auto_raid');
        return [res.ok ? `↳ ${member.user.tag}: quarantined` : `↳ ⚠️ ${member.user.tag}: quarantine failed (${res.note})`];
      }
      if (settings.antiRaidAction === 'kick') {
        await member.kick('Anti-raid auto-action');
        return [`↳ ${member.user.tag}: kicked`];
      }
      await guild.members.ban(userId, { reason: 'Anti-raid auto-action' });
      return [`↳ ${member.user.tag}: banned`];
    } catch (e) {
      // §4.4 — do what's possible, mark the rest.
      return [`↳ ⚠️ ${member.user.tag}: action failed — missing permissions (${(e as Error).message})`];
    }
  }

  // ── §5 Anti-Nuke ────────────────────────────────────────

  private async onNukeExecutor(
    guild: Guild,
    detector: string,
    executorId: string,
  ): Promise<{ notes: string[]; incidentId: string | null }> {
    if (!(await this.security.isPremium(guild.id))) return { notes: [], incidentId: null };
    const settings = await this.security.getSettings(guild.id);
    if (settings.antiNukeAction === 'alert') return { notes: [], incidentId: null };

    if (executorId === guild.ownerId) {
      return { notes: ['Executor is the server owner — alert only (§5.3).'], incidentId: null };
    }
    const member = await guild.members.fetch(executorId).catch(() => null);
    if (!member) return { notes: ['Executor is no longer on the server.'], incidentId: null };
    if (await this.security.isWhitelisted(guild.id, executorId, member)) {
      return { notes: ['Executor is whitelisted — no auto-action taken (§1.2).'], incidentId: null };
    }

    const me = guild.members.me;
    const dangerous = member.roles.cache.filter(
      (r) => r.id !== guild.id && STRIP_PERMISSIONS.some((p) => r.permissions.has(p)),
    );
    const strippable = dangerous.filter((r) => !me || r.position < me.roles.highest.position);
    const blocked = dangerous.filter((r) => me && r.position >= me.roles.highest.position);

    const notes: string[] = [];
    let incidentId: string | null = null;
    if (strippable.size) {
      try {
        await member.roles.remove([...strippable.keys()], `Anti-nuke (${detector})`);
        const incident = await this.nukeRepo.save(
          this.nukeRepo.create({
            guildId: guild.id,
            userId: executorId,
            strippedRoleIds: [...strippable.keys()],
            detector,
          }),
        );
        incidentId = incident.id;
        notes.push(`Stripped dangerous roles from **${member.user.tag}**: ${[...strippable.values()].map((r) => r.name).join(', ')}.`);
      } catch (e) {
        notes.push(`⚠️ Role strip failed: ${(e as Error).message}`);
      }
    }
    if (blocked.size) {
      notes.push(`⚠️ Role hierarchy prevented full action: ${[...blocked.values()].map((r) => r.name).join(', ')}.`);
    }
    if (!dangerous.size) notes.push('Executor had no dangerous roles to strip.');

    if (settings.antiNukeAction === 'strip_quarantine') {
      const res = await this.quarantine.quarantine(member, `Anti-nuke (${detector})`, 'auto_nuke');
      notes.push(res.ok ? 'Executor quarantined.' : `⚠️ Quarantine failed: ${res.note}`);
    }
    return { notes, incidentId };
  }

  /** §5.2 — one-click restore of stripped roles (false alarm). */
  async restoreStripped(guildId: string, incidentId: string): Promise<{ ok: boolean; note: string }> {
    const incident = await this.nukeRepo.findOne({ where: { id: incidentId, guildId } });
    if (!incident) return { ok: false, note: 'Incident not found' };
    if (incident.restored) return { ok: true, note: 'Already restored' };
    const guild = this.client.guilds.cache.get(guildId);
    const member = guild ? await guild.members.fetch(incident.userId).catch(() => null) : null;
    if (!guild || !member) return { ok: false, note: 'Member not on the server' };
    const roles = incident.strippedRoleIds.filter((id) => guild.roles.cache.has(id));
    try {
      await member.roles.add(roles, 'Anti-nuke: false alarm, roles restored');
    } catch (e) {
      return { ok: false, note: `Restore failed: ${(e as Error).message}` };
    }
    incident.restored = true;
    await this.nukeRepo.save(incident);
    return { ok: true, note: `Restored ${roles.length} role(s) to ${member.user.tag}` };
  }

  listNukeIncidents(guildId: string): Promise<NukeIncident[]> {
    return this.nukeRepo.find({ where: { guildId }, order: { createdAt: 'DESC' }, take: 50 });
  }

  // ── §7 Alert action buttons ─────────────────────────────

  private buildAlertComponents(
    guildId: string,
    detector: string,
    incidentId: string,
    actorUserId: string | null,
  ): unknown[] {
    const mk = (action: string, label: string, style: ButtonStyle, target = actorUserId ?? '-') =>
      new ButtonBuilder()
        .setCustomId(`sec/alert/${action}/${guildId}/${incidentId}/${target}`)
        .setLabel(label)
        .setStyle(style);

    const row = new ActionRowBuilder<ButtonBuilder>();
    if (detector === 'd1') {
      row.addComponents(
        mk('panic', '🔒 Panic Mode', ButtonStyle.Danger),
        mk('qjoins', '🧪 Quarantine recent joins', ButtonStyle.Primary),
        mk('ignore', 'Ignore', ButtonStyle.Secondary),
      );
    } else if (detector === 'd2' || detector === 'd3') {
      row.addComponents(
        mk('strip', '🛑 Strip roles', ButtonStyle.Danger),
        mk('quser', '🧪 Quarantine user', ButtonStyle.Primary),
        mk('restore', '↩️ Restore stripped roles', ButtonStyle.Secondary),
        mk('ignore', 'Ignore', ButtonStyle.Secondary),
      );
      if (detector === 'd2') {
        // §10.5 — jump straight to the latest snapshot preview in the dashboard.
        const frontend = this.config.get<string>('FRONTEND_URL', 'http://localhost:5173');
        row.addComponents(
          new ButtonBuilder()
            .setLabel('♻️ Restore from snapshot')
            .setStyle(ButtonStyle.Link)
            .setURL(`${frontend}/security?tab=snapshots`),
        );
      }
    } else if (detector === 'd4') {
      row.addComponents(
        mk('revert', '↩️ Revert role change', ButtonStyle.Danger),
        mk('ignore', 'Ignore', ButtonStyle.Secondary),
      );
    } else {
      row.addComponents(mk('ignore', 'Ignore', ButtonStyle.Secondary));
    }
    return [row];
  }

  @Button('sec/alert/:action/:guildId/:incidentId/:target')
  async onAlertButton(@Context() [interaction]: ButtonContext) {
    const [, , action, guildId, incidentId, target] = interaction.customId.split('/');
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) {
      await interaction.reply({ content: 'Server unavailable.', ephemeral: true });
      return;
    }
    if (!(await this.security.canUseButtons(guild, interaction.user.id))) {
      await interaction.reply({ content: "You don't have permission.", ephemeral: true });
      return;
    }
    await interaction.deferUpdate();

    let note = '';
    try {
      switch (action) {
        case 'panic': {
          const res = await this.panic.activate(guild, interaction.user.id);
          note = `Panic Mode activated. ${res.notes[0] ?? ''}`;
          break;
        }
        case 'qjoins': {
          // Quarantine everyone who joined in the last 10 minutes (§7 D1).
          let count = 0;
          for (const member of guild.members.cache.values()) {
            if (member.user.bot) continue;
            if (!member.joinedTimestamp || Date.now() - member.joinedTimestamp > 10 * 60 * 1000) continue;
            if (await this.security.isWhitelisted(guild.id, member.id, member)) continue;
            const res = await this.quarantine.quarantine(member, 'Raid: recent join', 'alert_button');
            if (res.ok) count += 1;
          }
          note = `Quarantined ${count} recent join(s).`;
          break;
        }
        case 'strip': {
          if (target === '-') {
            note = 'No executor identified.';
            break;
          }
          const res = await this.onNukeExecutorForce(guild, target);
          note = res.join(' ');
          break;
        }
        case 'quser': {
          if (target === '-') {
            note = 'No executor identified.';
            break;
          }
          const member = await guild.members.fetch(target).catch(() => null);
          if (!member) {
            note = 'User is no longer on the server.';
            break;
          }
          const res = await this.quarantine.quarantine(member, 'Alert action', 'alert_button');
          note = res.ok ? `Quarantined ${member.user.tag}.` : `⚠️ ${res.note}`;
          break;
        }
        case 'restore': {
          const latest = await this.nukeRepo.findOne({
            where: { guildId, userId: target, restored: false },
            order: { createdAt: 'DESC' },
          });
          const res = latest
            ? await this.restoreStripped(guildId, latest.id)
            : { ok: false, note: 'Nothing to restore' };
          note = res.note;
          break;
        }
        case 'revert': {
          note = await this.revertDangerousGrant(guild, target);
          break;
        }
        default:
          note = 'Dismissed.';
      }
    } catch (e) {
      note = `⚠️ Action failed: ${(e as Error).message}`;
    }

    // Disable buttons + append "Action taken by X at [time]" (§7).
    const msg = interaction.message;
    try {
      const embed = EmbedBuilder.from(msg.embeds[0]).addFields({
        name: 'Action',
        value: `${note}\nAction taken by ${interaction.user.tag} at <t:${Math.floor(Date.now() / 1000)}:f>`,
      });
      await msg.edit({ embeds: [embed], components: [] });
    } catch {
      /* DM message might be uneditable in edge cases */
    }
  }

  /** Manual strip via button — same rules as auto, minus the action setting. */
  private async onNukeExecutorForce(guild: Guild, executorId: string): Promise<string[]> {
    if (executorId === guild.ownerId) return ['Cannot act on the server owner.'];
    const member = await guild.members.fetch(executorId).catch(() => null);
    if (!member) return ['User is no longer on the server.'];
    const me = guild.members.me;
    const dangerous = member.roles.cache.filter(
      (r) => r.id !== guild.id && STRIP_PERMISSIONS.some((p) => r.permissions.has(p)),
    );
    const strippable = dangerous.filter((r) => !me || r.position < me.roles.highest.position);
    if (!strippable.size) return ['No strippable dangerous roles.'];
    await member.roles.remove([...strippable.keys()], 'Manual strip from alert');
    await this.nukeRepo.save(
      this.nukeRepo.create({
        guildId: guild.id,
        userId: executorId,
        strippedRoleIds: [...strippable.keys()],
        detector: 'manual',
      }),
    );
    return [`Stripped: ${[...strippable.values()].map((r) => r.name).join(', ')}.`];
  }

  /** D4 revert: remove dangerous roles granted to the target member. */
  private async revertDangerousGrant(guild: Guild, target: string): Promise<string> {
    if (target === '-') return 'No target identified.';
    const member = await guild.members.fetch(target).catch(() => null);
    if (!member) return 'User is no longer on the server.';
    const me = guild.members.me;
    const dangerous = member.roles.cache.filter(
      (r) =>
        r.id !== guild.id &&
        STRIP_PERMISSIONS.some((p) => r.permissions.has(p)) &&
        (!me || r.position < me.roles.highest.position),
    );
    if (!dangerous.size) return 'No dangerous roles to revert (or hierarchy prevents it).';
    await member.roles.remove([...dangerous.keys()], 'Revert dangerous grant (D4)');
    return `Removed from ${member.user.tag}: ${[...dangerous.values()].map((r) => r.name).join(', ')}.`;
  }
}
