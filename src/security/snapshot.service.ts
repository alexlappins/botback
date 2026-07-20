import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  CategoryChannel,
  ChannelType,
  Client,
  Guild,
  GuildChannel,
  OverwriteType,
  PermissionsBitField,
  TextChannel,
} from 'discord.js';

import { GoodbyeConfig } from '../welcome/entities/goodbye-config.entity';
import { WelcomeConfig } from '../welcome/entities/welcome-config.entity';
import { LogSettings } from '../logs/entities/log-settings.entity';
import { PendingInstall } from '../store/entities/pending-install.entity';
import { ServerSnapshot } from './entities/snapshot.entity';
import { SecuritySettings } from './entities/security.entities';
import { SecurityService } from './security.service';

const KEEP_SNAPSHOTS = 7; // §10.2

/** Overwrite serialised by TARGET NAME — roles are matched by name on restore. */
interface SnapOverwrite {
  targetType: 'role' | 'member' | 'everyone';
  targetName: string; // role name; member overwrites keep the raw id
  allow: string;
  deny: string;
}
interface SnapRole {
  id: string;
  name: string;
  color: number;
  permissions: string;
  position: number;
  hoist: boolean;
  mentionable: boolean;
}
interface SnapChannel {
  id: string;
  name: string;
  type: number;
  topic: string | null;
  position: number;
  parentName: string | null;
  rateLimitPerUser: number;
  overwrites: SnapOverwrite[];
}
interface SnapshotData {
  roles: SnapRole[];
  categories: SnapChannel[];
  channels: SnapChannel[];
}

export interface RestoreProgress {
  status: 'running' | 'completed' | 'failed';
  step: string;
  created: { roles: number; categories: number; channels: number; permissionsFixed: number };
  rebound: string[];
  error: string | null;
  startedAt: number;
}

/**
 * Snapshot & Restore (§10, Premium). Restore is "add what's missing" ONLY —
 * it never deletes anything. Runs in the background with live progress and a
 * per-guild lock shared with the shop deploy engine (§10.3).
 */
@Injectable()
export class SnapshotService {
  private readonly logger = new Logger(SnapshotService.name);
  private restores = new Map<string, RestoreProgress>();

  constructor(
    @InjectRepository(ServerSnapshot)
    private readonly snapRepo: Repository<ServerSnapshot>,
    @InjectRepository(PendingInstall)
    private readonly pendingRepo: Repository<PendingInstall>,
    @InjectRepository(LogSettings)
    private readonly logSettingsRepo: Repository<LogSettings>,
    @InjectRepository(WelcomeConfig)
    private readonly welcomeRepo: Repository<WelcomeConfig>,
    @InjectRepository(GoodbyeConfig)
    private readonly goodbyeRepo: Repository<GoodbyeConfig>,
    private readonly security: SecurityService,
    @Inject(Client) private readonly client: Client,
  ) {}

  // ── Serialisation (§10.1) ───────────────────────────────

  private serialiseOverwrites(channel: GuildChannel): SnapOverwrite[] {
    const guild = channel.guild;
    const out: SnapOverwrite[] = [];
    for (const o of channel.permissionOverwrites.cache.values()) {
      if (o.type === OverwriteType.Role) {
        const role = guild.roles.cache.get(o.id);
        if (!role) continue;
        out.push({
          targetType: o.id === guild.id ? 'everyone' : 'role',
          targetName: o.id === guild.id ? '@everyone' : role.name,
          allow: o.allow.bitfield.toString(),
          deny: o.deny.bitfield.toString(),
        });
      } else {
        out.push({ targetType: 'member', targetName: o.id, allow: o.allow.bitfield.toString(), deny: o.deny.bitfield.toString() });
      }
    }
    return out;
  }

  private serialise(guild: Guild): SnapshotData {
    const roles: SnapRole[] = [...guild.roles.cache.values()]
      .filter((r) => r.id !== guild.id && !r.managed)
      .map((r) => ({
        id: r.id,
        name: r.name,
        color: r.color,
        permissions: r.permissions.bitfield.toString(),
        position: r.position,
        hoist: r.hoist,
        mentionable: r.mentionable,
      }));

    const categories: SnapChannel[] = [];
    const channels: SnapChannel[] = [];
    for (const ch of guild.channels.cache.values()) {
      if (!('permissionOverwrites' in ch)) continue;
      const g = ch as GuildChannel;
      const snap: SnapChannel = {
        id: g.id,
        name: g.name,
        type: g.type,
        topic: 'topic' in g ? ((g as TextChannel).topic ?? null) : null,
        position: g.position,
        parentName: g.parent?.name ?? null,
        rateLimitPerUser: 'rateLimitPerUser' in g ? ((g as TextChannel).rateLimitPerUser ?? 0) : 0,
        overwrites: this.serialiseOverwrites(g),
      };
      if (g.type === ChannelType.GuildCategory) categories.push(snap);
      else channels.push(snap);
    }
    return { roles, categories, channels };
  }

  // ── §10.2 Create + rotate ───────────────────────────────

  async takeSnapshot(guildId: string, type: 'auto' | 'manual'): Promise<ServerSnapshot> {
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) throw new Error('Guild not available');
    const row = await this.snapRepo.save(
      this.snapRepo.create({ guildId, type, data: this.serialise(guild) as never }),
    );
    // Rotation: keep the newest KEEP_SNAPSHOTS.
    const all = await this.snapRepo.find({ where: { guildId }, order: { createdAt: 'DESC' } });
    const excess = all.slice(KEEP_SNAPSHOTS).map((s) => s.id);
    if (excess.length) await this.snapRepo.delete({ id: In(excess) });
    return row;
  }

  /** Daily auto-snapshot for every premium guild (§10.2). */
  @Cron(CronExpression.EVERY_DAY_AT_4AM, { name: 'security.snapshots' })
  async dailySnapshots(): Promise<void> {
    for (const guild of this.client.guilds.cache.values()) {
      try {
        if (!(await this.security.isPremium(guild.id))) continue;
        await this.takeSnapshot(guild.id, 'auto');
      } catch (e) {
        this.logger.warn(`auto snapshot failed for ${guild.id}: ${(e as Error).message}`);
      }
    }
  }

  list(guildId: string): Promise<ServerSnapshot[]> {
    return this.snapRepo.find({ where: { guildId }, order: { createdAt: 'DESC' } });
  }

  // ── §10.3 Preview + restore ─────────────────────────────

  async preview(guildId: string, snapshotId: string) {
    const snap = await this.snapRepo.findOne({ where: { id: snapshotId, guildId } });
    if (!snap) throw new Error('Snapshot not found');
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) throw new Error('Guild not available');
    const data = snap.data as unknown as SnapshotData;

    const roleNames = new Set(guild.roles.cache.map((r) => r.name));
    const catNames = new Set(
      guild.channels.cache.filter((c) => c.type === ChannelType.GuildCategory).map((c) => c.name),
    );
    const chNames = new Set(
      guild.channels.cache.filter((c) => c.type !== ChannelType.GuildCategory).map((c) => c.name),
    );

    return {
      snapshot: { id: snap.id, createdAt: snap.createdAt, type: snap.type },
      counts: {
        roles: data.roles.length,
        categories: data.categories.length,
        channels: data.channels.length,
      },
      missingRoles: data.roles.filter((r) => !roleNames.has(r.name)).map((r) => r.name),
      missingCategories: data.categories.filter((c) => !catNames.has(c.name)).map((c) => c.name),
      missingChannels: data.channels.filter((c) => !chNames.has(c.name)).map((c) => c.name),
    };
  }

  getRestoreProgress(guildId: string): RestoreProgress | null {
    return this.restores.get(guildId) ?? null;
  }

  /** Start a background restore. Throws when locked (§10.3). */
  async startRestore(guildId: string, snapshotId: string): Promise<void> {
    if (this.restores.get(guildId)?.status === 'running') throw new Error('A restore is already running');
    const deploying = await this.pendingRepo.findOne({ where: { guildId, status: 'deploying' } });
    if (deploying) throw new Error('A shop deploy is running on this server — try again later');
    if (!(await this.security.isPremium(guildId))) throw new Error('Premium required');

    const snap = await this.snapRepo.findOne({ where: { id: snapshotId, guildId } });
    if (!snap) throw new Error('Snapshot not found');
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) throw new Error('Guild not available');

    const progress: RestoreProgress = {
      status: 'running',
      step: 'roles',
      created: { roles: 0, categories: 0, channels: 0, permissionsFixed: 0 },
      rebound: [],
      error: null,
      startedAt: Date.now(),
    };
    this.restores.set(guildId, progress);
    void this.runRestore(guild, snap.data as unknown as SnapshotData, progress).catch((e) => {
      progress.status = 'failed';
      progress.error = (e as Error).message;
      this.logger.error(`restore failed for ${guildId}: ${(e as Error).message}`);
    });
  }

  /** Sequential ops with small pauses — mirrors the deploy engine's pacing. */
  private async runRestore(guild: Guild, data: SnapshotData, p: RestoreProgress): Promise<void> {
    const pause = () => new Promise((r) => setTimeout(r, 350));

    // 1. Roles (missing only), ordered as in the snapshot.
    p.step = 'roles';
    const roleByName = new Map(guild.roles.cache.map((r) => [r.name, r]));
    for (const r of [...data.roles].sort((a, b) => a.position - b.position)) {
      if (roleByName.has(r.name)) continue;
      const created = await guild.roles
        .create({
          name: r.name,
          color: r.color,
          permissions: BigInt(r.permissions) as never,
          hoist: r.hoist,
          mentionable: r.mentionable,
          reason: 'Snapshot restore',
        })
        .catch(() => null);
      if (created) {
        roleByName.set(created.name, created);
        p.created.roles += 1;
        await pause();
      }
    }

    const overwritesFor = (snap: SnapChannel) =>
      snap.overwrites
        .map((o) => {
          const id =
            o.targetType === 'everyone'
              ? guild.roles.everyone.id
              : o.targetType === 'role'
                ? roleByName.get(o.targetName)?.id
                : o.targetName;
          if (!id) return null;
          return { id, allow: BigInt(o.allow), deny: BigInt(o.deny) };
        })
        .filter(Boolean) as { id: string; allow: bigint; deny: bigint }[];

    // 2. Categories (missing only).
    p.step = 'categories';
    const catByName = new Map(
      guild.channels.cache.filter((c) => c.type === ChannelType.GuildCategory).map((c) => [c.name, c as CategoryChannel]),
    );
    for (const c of [...data.categories].sort((a, b) => a.position - b.position)) {
      if (catByName.has(c.name)) continue;
      const created = await guild.channels
        .create({ name: c.name, type: ChannelType.GuildCategory, permissionOverwrites: overwritesFor(c) as never, reason: 'Snapshot restore' })
        .catch(() => null);
      if (created) {
        catByName.set(created.name, created as CategoryChannel);
        p.created.categories += 1;
        await pause();
      }
    }

    // 3. Channels (missing only).
    p.step = 'channels';
    const chByName = new Map(
      guild.channels.cache.filter((c) => c.type !== ChannelType.GuildCategory).map((c) => [c.name, c as GuildChannel]),
    );
    for (const c of [...data.channels].sort((a, b) => a.position - b.position)) {
      if (chByName.has(c.name)) continue;
      const type = ([ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildAnnouncement].includes(c.type)
        ? c.type
        : ChannelType.GuildText) as ChannelType.GuildText;
      const created = await guild.channels
        .create({
          name: c.name,
          type,
          topic: c.topic ?? undefined,
          parent: c.parentName ? (catByName.get(c.parentName)?.id ?? undefined) : undefined,
          rateLimitPerUser: c.rateLimitPerUser || undefined,
          permissionOverwrites: overwritesFor(c) as never,
          reason: 'Snapshot restore',
        })
        .catch(() => null);
      if (created) {
        chByName.set(created.name, created as GuildChannel);
        p.created.channels += 1;
        await pause();
      }
    }

    // 4. Fix permissions of EXISTING channels to match the snapshot (§10.3).
    p.step = 'permissions';
    for (const c of [...data.categories, ...data.channels]) {
      const live = (c.type === ChannelType.GuildCategory ? catByName.get(c.name) : chByName.get(c.name)) as
        | GuildChannel
        | undefined;
      if (!live) continue;
      const wanted = overwritesFor(c);
      const current = new Map(
        live.permissionOverwrites.cache.map((o) => [o.id, `${o.allow.bitfield}/${o.deny.bitfield}`]),
      );
      const differs =
        wanted.some((w) => current.get(w.id) !== `${w.allow}/${w.deny}`) || wanted.length !== current.size;
      if (!differs) continue;
      const ok = await live.permissionOverwrites
        .set(wanted as never, 'Snapshot restore: permissions')
        .then(() => true)
        .catch(() => false);
      if (ok) {
        p.created.permissionsFixed += 1;
        await pause();
      }
    }

    // 5. §10.4 — rebind bot settings whose channels died, by old-id → name.
    p.step = 'rebinding';
    const idToName = new Map<string, string>([
      ...data.channels.map((c) => [c.id, c.name] as const),
      ...data.categories.map((c) => [c.id, c.name] as const),
    ]);
    const resolve = (oldId: string | null): string | null => {
      if (!oldId) return null;
      if (guild.channels.cache.has(oldId)) return null; // still valid — leave as is
      const name = idToName.get(oldId);
      if (!name) return null;
      return chByName.get(name)?.id ?? null;
    };

    const logs = await this.logSettingsRepo.findOne({ where: { guildId: guild.id } });
    if (logs) {
      let changed = false;
      for (const key of [
        'singleChannelId',
        'banChannelId',
        'joinLeaveChannelId',
        'messagesChannelId',
        'moderationChannelId',
        'channelChannelId',
        'serverChannelId',
        'voiceChannelId',
      ] as const) {
        const next = resolve(logs[key]);
        if (next) {
          (logs as unknown as Record<string, unknown>)[key] = next;
          changed = true;
        }
      }
      if (changed) {
        await this.logSettingsRepo.save(logs);
        p.rebound.push('log channels');
      }
    }

    const welcome = await this.welcomeRepo.findOne({ where: { guildId: guild.id } }).catch(() => null);
    if (welcome) {
      const next = resolve(welcome.channelId);
      if (next) {
        welcome.channelId = next;
        await this.welcomeRepo.save(welcome);
        p.rebound.push('welcome channel');
      }
    }
    const goodbye = await this.goodbyeRepo.findOne({ where: { guildId: guild.id } }).catch(() => null);
    if (goodbye) {
      const next = resolve(goodbye.channelId);
      if (next) {
        goodbye.channelId = next;
        await this.goodbyeRepo.save(goodbye);
        p.rebound.push('goodbye channel');
      }
    }
    const sec = await this.security.getSettings(guild.id);
    let secChanged = false;
    for (const key of ['quarantineChannelId', 'panelChannelId', 'shieldChannelId'] as const) {
      const next = resolve(sec[key]);
      if (next) {
        (sec as unknown as Record<string, unknown>)[key] = next;
        secChanged = true;
      }
    }
    if (secChanged) {
      await this.security.saveSettings(sec);
      p.rebound.push('security channels');
    }

    p.step = 'done';
    p.status = 'completed';
    this.logger.log(
      `Restore OK guild=${guild.id}: +${p.created.roles} roles, +${p.created.categories} categories, +${p.created.channels} channels, ${p.created.permissionsFixed} permission fixes, rebound: ${p.rebound.join(', ') || 'none'}`,
    );
    setTimeout(() => {
      if (this.restores.get(guild.id)?.status !== 'running') this.restores.delete(guild.id);
    }, 15 * 60 * 1000).unref?.();
  }
}
