import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Client, ChannelType, type VoiceChannel, type StageChannel } from 'discord.js';
import { LevelingService } from './leveling.service';

/**
 * Periodic voice XP awarder. Runs once per minute and grants
 * `voice_xp_per_minute` XP to every eligible member currently in a voice
 * channel on every guild where leveling + voice XP are enabled.
 *
 * Eligibility:
 *   - Bot is online and member is not a bot
 *   - Channel has ≥ `voice_xp_min_users` (non-bot) members
 *   - Channel id not in no_xp_channels (type='voice')
 *   - Member not deafened/muted (server- or self-) → AFK proxy
 *   - Member not on ignored_users list
 *   - Member doesn't have a no_xp role
 *   - Member.lastActiveAt within `voice_xp_afk_minutes` (AFK detector)
 */
@Injectable()
export class VoiceTickService {
  private readonly logger = new Logger(VoiceTickService.name);

  constructor(
    @Inject(Client) private readonly client: Client,
    private readonly leveling: LevelingService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: 'leveling.voice_tick' })
  async tick(): Promise<void> {
    if (!this.client?.isReady?.()) return;
    for (const [, guild] of this.client.guilds.cache) {
      try {
        await this.tickGuild(guild.id);
      } catch (e) {
        this.logger.warn(`voice tick for ${guild.id} failed: ${(e as Error).message}`);
      }
    }
  }

  private async tickGuild(serverId: string): Promise<void> {
    const guild = this.client.guilds.cache.get(serverId);
    if (!guild) return;
    const settings = await this.leveling.getSettings(serverId);
    if (!settings.enabled || !settings.voiceXpEnabled) return;

    const blocked = await this.leveling.getNoXpChannelIds(serverId, 'voice');
    const afkCutoffMs = settings.voiceXpAfkMinutes * 60 * 1000;
    const now = Date.now();

    for (const [, ch] of guild.channels.cache) {
      if (ch.type !== ChannelType.GuildVoice && ch.type !== ChannelType.GuildStageVoice) continue;
      if (blocked.has(ch.id)) continue;

      const voiceCh = ch as VoiceChannel | StageChannel;
      const eligibleMembers = voiceCh.members.filter(
        (m) =>
          !m.user.bot &&
          !m.voice.selfMute &&
          !m.voice.selfDeaf &&
          !m.voice.serverMute &&
          !m.voice.serverDeaf,
      );
      if (eligibleMembers.size < settings.voiceXpMinUsers) continue;

      for (const [, member] of eligibleMembers) {
        try {
          if (await this.leveling.isIgnored(serverId, member.id)) continue;
          if (await this.leveling.hasNoXpRole(member)) continue;

          const xpRow = await this.leveling.getOrCreateXp(serverId, member.id);
          if (
            xpRow.lastActiveAt &&
            now - xpRow.lastActiveAt.getTime() > afkCutoffMs
          ) {
            continue; // AFK
          }

          const result = await this.leveling.awardXp(
            serverId,
            member.id,
            settings.voiceXpPerMinute,
            'voice',
            { updateVoiceMinutes: 1 },
          );
          if (result.leveledUp) {
            await this.leveling.handleLevelUp(guild, member, result);
          }
        } catch (e) {
          this.logger.warn(
            `voice xp for ${member.user.tag} in ${guild.name} failed: ${(e as Error).message}`,
          );
        }
      }
    }
  }

  /** Reset monthly_xp for all rows. Runs on the 1st of every month, 00:00 UTC. */
  @Cron('0 0 1 * *', { name: 'leveling.monthly_reset', timeZone: 'UTC' })
  async monthlyReset(): Promise<void> {
    try {
      const affected = await this.leveling.resetAllMonthly();
      this.logger.log(`Monthly XP reset complete (${affected} rows)`);
    } catch (e) {
      this.logger.error('monthlyReset failed', e as Error);
    }
  }
}
