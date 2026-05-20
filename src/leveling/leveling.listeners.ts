import { Injectable, Logger } from '@nestjs/common';
import { Context, On } from 'necord';
import type { ContextOf } from 'necord';
import { LevelingService } from './leveling.service';

/**
 * Two Discord event paths feed the leveling engine:
 *
 *  - messageCreate    → chat XP (with cooldown, length, filter, no-XP checks)
 *  - voiceStateUpdate → updates `last_active_at` so the cron voice tick has
 *                       a fresh "active" timestamp to compare against AFK
 */
@Injectable()
export class LevelingListeners {
  private readonly logger = new Logger(LevelingListeners.name);

  constructor(private readonly leveling: LevelingService) {}

  @On('messageCreate')
  async onMessageCreate(
    @Context() [message]: ContextOf<'messageCreate'>,
  ): Promise<void> {
    try {
      if (!message.guild || !message.member) return;
      if (message.author.bot) return;
      if (message.system) return;

      const settings = await this.leveling.getSettings(message.guild.id);
      if (!settings.enabled || !settings.chatXpEnabled) return;

      // Channel blacklist
      const blockedText = await this.leveling.getNoXpChannelIds(message.guild.id, 'text');
      if (blockedText.has(message.channel.id)) return;

      // Ignored user
      if (await this.leveling.isIgnored(message.guild.id, message.author.id)) return;

      // No-xp roles
      if (await this.leveling.hasNoXpRole(message.member)) return;

      // Substantive message check
      if (!LevelingService.isMessageSubstantive(message.content, settings.chatXpMinLength)) return;

      // Cooldown
      const xp = await this.leveling.getOrCreateXp(message.guild.id, message.author.id);
      const cooldownMs = settings.chatXpCooldown * 1000;
      if (xp.lastMessageAt && Date.now() - xp.lastMessageAt.getTime() < cooldownMs) return;

      const min = Math.max(0, settings.chatXpMin);
      const max = Math.max(min, settings.chatXpMax);
      const amount = min + Math.floor(Math.random() * (max - min + 1));

      const result = await this.leveling.awardXp(
        message.guild.id,
        message.author.id,
        amount,
        'chat',
        { updateMessageCounter: true },
      );
      if (result.leveledUp) {
        await this.leveling.handleLevelUp(message.guild, message.member, result);
      }
    } catch (e) {
      this.logger.warn(`messageCreate XP path crashed: ${(e as Error).message}`);
    }
  }

  /**
   * Tap voice activity to keep `last_active_at` fresh. Without this the
   * AFK detector would falsely skip users whose only Discord activity is
   * voice (no chat messages).
   */
  @On('voiceStateUpdate')
  async onVoiceStateUpdate(
    @Context() [, newState]: ContextOf<'voiceStateUpdate'>,
  ): Promise<void> {
    try {
      if (!newState.guild || !newState.member) return;
      if (newState.member.user.bot) return;
      // Only count "activity" when the user actually has a channel (i.e. they're connected
      // and (un)muted/(un)deafened) — leaving doesn't refresh the marker.
      if (!newState.channelId) return;
      await this.leveling.markActive(newState.guild.id, newState.member.id);
    } catch {
      // best-effort, swallow
    }
  }
}
