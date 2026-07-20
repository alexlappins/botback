import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Guild,
  GuildVerificationLevel,
  TextChannel,
} from 'discord.js';
import { Button, Context } from 'necord';
import type { ButtonContext } from 'necord';

import { SecurityBridge } from '../common/security-bridge.service';
import { PanicState, SecuritySettings } from './entities/security.entities';
import { SecurityService } from './security.service';

interface SavedPanicState {
  verificationLevel: number;
  slowmodes: Record<string, number>;
}

/**
 * Panic Mode (§3): pause invites, max verification, optional slowmode —
 * with the FULL previous state saved first and restored verbatim on
 * deactivation. Plus the pinned Security Panel with ON/OFF buttons (§3.3c).
 */
@Injectable()
export class PanicService {
  private readonly logger = new Logger(PanicService.name);

  constructor(
    @InjectRepository(PanicState)
    private readonly stateRepo: Repository<PanicState>,
    private readonly security: SecurityService,
    private readonly bridge: SecurityBridge,
    @Inject(Client) private readonly client: Client,
  ) {}

  async isActive(guildId: string): Promise<boolean> {
    return Boolean(await this.stateRepo.findOne({ where: { guildId } }));
  }

  /** §3.1-3.2: snapshot state → apply lockdown. Idempotent. */
  async activate(guild: Guild, byUserId: string): Promise<{ ok: boolean; notes: string[] }> {
    if (await this.isActive(guild.id)) return { ok: true, notes: ['Already active.'] };
    const settings = await this.security.getSettings(guild.id);
    const notes: string[] = [];

    const saved: SavedPanicState = { verificationLevel: guild.verificationLevel, slowmodes: {} };

    try {
      await guild.disableInvites(true);
      notes.push('Invites paused.');
    } catch {
      notes.push('⚠️ Could not pause invites (missing Manage Server?).');
    }
    try {
      await guild.setVerificationLevel(GuildVerificationLevel.VeryHigh, 'Panic Mode');
      notes.push('Verification level raised to maximum.');
    } catch {
      notes.push('⚠️ Could not raise verification level.');
    }

    if (settings.panicSlowmodeEnabled) {
      let done = 0;
      for (const channel of guild.channels.cache.values()) {
        if (channel.type !== ChannelType.GuildText) continue;
        const tc = channel as TextChannel;
        saved.slowmodes[tc.id] = tc.rateLimitPerUser ?? 0;
        await tc
          .setRateLimitPerUser(settings.panicSlowmodeSeconds, 'Panic Mode')
          .then(() => (done += 1))
          .catch(() => null);
      }
      notes.push(`Slowmode ${settings.panicSlowmodeSeconds}s set on ${done} channel(s).`);
    }

    await this.stateRepo.save(
      this.stateRepo.create({ guildId: guild.id, savedState: saved as never, activatedBy: byUserId }),
    );

    const byTag = await this.client.users.fetch(byUserId).then((u) => u.tag).catch(() => byUserId);
    void this.bridge.notifyRecipients?.(
      guild.id,
      'Panic Mode ACTIVATED',
      [`Activated by **${byTag}**.`, ...notes],
      'critical',
    );
    await this.refreshPanel(guild).catch(() => null);
    return { ok: true, notes };
  }

  /** §3.2: restore everything exactly as saved, then clear the record. */
  async deactivate(guild: Guild, byUserId: string): Promise<{ ok: boolean; notes: string[] }> {
    const state = await this.stateRepo.findOne({ where: { guildId: guild.id } });
    if (!state) return { ok: true, notes: ['Not active.'] };
    const saved = state.savedState as unknown as SavedPanicState;
    const notes: string[] = [];

    try {
      await guild.disableInvites(false);
      notes.push('Invites re-enabled.');
    } catch {
      notes.push('⚠️ Could not re-enable invites.');
    }
    try {
      await guild.setVerificationLevel(saved.verificationLevel as GuildVerificationLevel, 'Panic Mode off');
      notes.push('Verification level restored.');
    } catch {
      notes.push('⚠️ Could not restore verification level.');
    }
    let restored = 0;
    for (const [channelId, seconds] of Object.entries(saved.slowmodes ?? {})) {
      const ch = guild.channels.cache.get(channelId);
      if (ch?.type === ChannelType.GuildText) {
        await (ch as TextChannel)
          .setRateLimitPerUser(seconds, 'Panic Mode off')
          .then(() => (restored += 1))
          .catch(() => null);
      }
    }
    if (Object.keys(saved.slowmodes ?? {}).length) notes.push(`Slowmode restored on ${restored} channel(s).`);

    await this.stateRepo.delete({ guildId: guild.id });

    const byTag = await this.client.users.fetch(byUserId).then((u) => u.tag).catch(() => byUserId);
    void this.bridge.notifyRecipients?.(
      guild.id,
      'Panic Mode deactivated',
      [`Deactivated by **${byTag}**.`, ...notes],
      'warning',
    );
    await this.refreshPanel(guild).catch(() => null);
    return { ok: true, notes };
  }

  // ── §3.3c Security Panel ────────────────────────────────

  /** (Re)post or edit the pinned panel message in the configured channel. */
  async refreshPanel(guild: Guild): Promise<void> {
    const settings = await this.security.getSettings(guild.id);
    if (!settings.panelChannelId) return;
    const channel = guild.channels.cache.get(settings.panelChannelId);
    if (!channel?.isTextBased()) return;

    const active = await this.isActive(guild.id);
    const embed = new EmbedBuilder()
      .setColor(active ? 0xed4245 : 0x57f287)
      .setTitle('🛡️ Security Panel')
      .setDescription(
        [
          `Panic Mode: **${active ? '🔒 ACTIVE' : '🔓 off'}**`,
          `Age Filter: **${settings.ageFilterEnabled ? `on (${settings.ageFilterMinDays}d, ${settings.ageFilterAction})` : 'off'}**`,
          `Anti-Raid: **${settings.antiRaidAction}**`,
          `Anti-Nuke: **${settings.antiNukeAction}**`,
        ].join('\n'),
      )
      .setTimestamp(new Date());
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`sec/panic-on/${guild.id}`)
        .setLabel('🔒 Panic ON')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(active),
      new ButtonBuilder()
        .setCustomId(`sec/panic-off/${guild.id}`)
        .setLabel('🔓 Panic OFF')
        .setStyle(ButtonStyle.Success)
        .setDisabled(!active),
    );

    const tc = channel as TextChannel;
    if (settings.panelMessageId) {
      const msg = await tc.messages.fetch(settings.panelMessageId).catch(() => null);
      if (msg) {
        await msg.edit({ embeds: [embed], components: [row] });
        return;
      }
    }
    const sent = await tc.send({ embeds: [embed], components: [row] });
    await sent.pin().catch(() => null);
    settings.panelMessageId = sent.id;
    await this.security.saveSettings(settings);
  }

  // ── Panel buttons (§3.4) ────────────────────────────────

  @Button('sec/panic-on/:guildId')
  async onPanicOn(@Context() [interaction]: ButtonContext) {
    await this.handlePanicButton(interaction, true);
  }

  @Button('sec/panic-off/:guildId')
  async onPanicOff(@Context() [interaction]: ButtonContext) {
    await this.handlePanicButton(interaction, false);
  }

  private async handlePanicButton(
    interaction: ButtonContext[0],
    on: boolean,
  ): Promise<void> {
    const guild = interaction.guild;
    if (!guild) return;
    if (!(await this.security.canUseButtons(guild, interaction.user.id))) {
      await interaction.reply({ content: "You don't have permission.", ephemeral: true });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    const result = on
      ? await this.activate(guild, interaction.user.id)
      : await this.deactivate(guild, interaction.user.id);
    await interaction.editReply({
      content: `Panic Mode ${on ? 'activated' : 'deactivated'}.\n${result.notes.join('\n')}`,
    });
  }
}
