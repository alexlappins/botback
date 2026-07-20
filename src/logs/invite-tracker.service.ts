import { Inject, Injectable, Logger } from '@nestjs/common';
import { Client, Guild } from 'discord.js';
import { Once, On, Context } from 'necord';
import type { ContextOf } from 'necord';

/**
 * "Which invite did they use" (TZ §1 preset 2): keep a snapshot of invite
 * use-counters per guild; after each join, re-fetch and diff. Needs the
 * Manage Server permission — silently disabled where it's missing.
 */
@Injectable()
export class InviteTrackerService {
  private readonly logger = new Logger(InviteTrackerService.name);
  /** guildId → (inviteCode → uses) */
  private snapshots = new Map<string, Map<string, number>>();

  constructor(@Inject(Client) private readonly client: Client) {}

  @Once('ready')
  async onReady() {
    for (const guild of this.client.guilds.cache.values()) {
      await this.snapshot(guild).catch(() => null);
    }
  }

  @On('guildCreate')
  async onGuildCreate(@Context() [guild]: ContextOf<'guildCreate'>) {
    await this.snapshot(guild).catch(() => null);
  }

  @On('inviteCreate')
  async onInviteCreate(@Context() [invite]: ContextOf<'inviteCreate'>) {
    if (invite.guild && 'id' in invite.guild) {
      this.snapshots.get(invite.guild.id)?.set(invite.code, invite.uses ?? 0);
    }
  }

  @On('inviteDelete')
  async onInviteDelete(@Context() [invite]: ContextOf<'inviteDelete'>) {
    if (invite.guild && 'id' in invite.guild) {
      this.snapshots.get(invite.guild.id)?.delete(invite.code);
    }
  }

  private async snapshot(guild: Guild): Promise<void> {
    if (!guild.members.me?.permissions.has('ManageGuild')) return;
    const invites = await guild.invites.fetch();
    this.snapshots.set(guild.id, new Map(invites.map((i) => [i.code, i.uses ?? 0])));
  }

  /**
   * Called right after a member join: returns the invite whose counter grew
   * (code + inviter tag) or null when undetectable.
   */
  async resolveJoin(guild: Guild): Promise<{ code: string; inviterTag: string | null } | null> {
    if (!guild.members.me?.permissions.has('ManageGuild')) return null;
    const prev = this.snapshots.get(guild.id);
    try {
      const invites = await guild.invites.fetch();
      this.snapshots.set(guild.id, new Map(invites.map((i) => [i.code, i.uses ?? 0])));
      if (!prev) return null;
      for (const invite of invites.values()) {
        const before = prev.get(invite.code) ?? 0;
        if ((invite.uses ?? 0) > before) {
          return { code: invite.code, inviterTag: invite.inviter?.tag ?? null };
        }
      }
    } catch (e) {
      this.logger.debug(`invite diff failed for ${guild.id}: ${(e as Error).message}`);
    }
    return null;
  }
}
