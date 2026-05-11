import { Injectable, Logger } from '@nestjs/common';
import { Context, On } from 'necord';
import type { ContextOf } from 'necord';
import { AttachmentBuilder, ButtonStyle, TextChannel } from 'discord.js';

import { WelcomeService } from './welcome.service';
import { ImageRendererService } from './image-renderer.service';
import { resolveVariables } from './variable-resolver';
import type { WelcomeTemplate } from './entities/welcome-template.entity';
import type { GoodbyeTemplate } from './entities/goodbye-template.entity';

@Injectable()
export class WelcomeListeners {
  private readonly logger = new Logger(WelcomeListeners.name);

  constructor(
    private readonly welcome: WelcomeService,
    private readonly renderer: ImageRendererService,
  ) {}

  @On('guildMemberAdd')
  async onMemberAdd(
    @Context() [member]: ContextOf<'guildMemberAdd'>,
  ): Promise<void> {
    try {
      const cfg = await this.welcome.getWelcome(member.guild.id);
      // Always record sighting even if welcome is disabled — so flipping the
      // feature on later still correctly identifies returns.
      const returning = await this.welcome.markSeenAndCheckReturning(
        member.guild.id,
        member.user.id,
      );

      if (!cfg.enabled) return;
      const variant = this.welcome.pickWelcomeVariant(cfg, { returning });
      if (!variant) return;

      const resolved = resolveVariables(variant.text, {
        user: member.user,
        member,
        guild: member.guild,
      });
      const components = buildLinkButtons(variant.buttonsConfig);
      const files: AttachmentBuilder[] = [];
      if (variant.imageEnabled) {
        const buf = await this.renderer.render(variant, {
          user: member.user,
          member,
          guild: member.guild,
        });
        if (buf) files.push(new AttachmentBuilder(buf, { name: 'welcome.png' }));
      }
      const messageContent = pickContentByMode(variant.imageSendMode, resolved, files.length > 0);
      if (!messageContent && !files.length && !components.length) return;

      if (cfg.sendMode === 'dm') {
        await member
          .send({
            content: messageContent || undefined,
            components: components as never,
            files,
          })
          .catch((e) =>
            this.logger.warn(
              `Welcome DM to ${member.user.tag} failed: ${(e as Error).message}`,
            ),
          );
      } else {
        if (!cfg.channelId) return;
        const channel = member.guild.channels.cache.get(cfg.channelId);
        if (!channel?.isTextBased()) return;
        await (channel as TextChannel)
          .send({
            content: messageContent || undefined,
            components: components as never,
            files,
          })
          .catch((e) =>
            this.logger.warn(
              `Welcome message in #${(channel as TextChannel).name} failed: ${(e as Error).message}`,
            ),
          );
      }
    } catch (e) {
      this.logger.error(`guildMemberAdd handler crashed`, e as Error);
    }
  }

  @On('guildMemberRemove')
  async onMemberRemove(
    @Context() [member]: ContextOf<'guildMemberRemove'>,
  ): Promise<void> {
    try {
      const cfg = await this.welcome.getGoodbye(member.guild.id);
      if (!cfg.enabled || !cfg.channelId) return;

      const variant = this.welcome.pickGoodbyeVariant(cfg);
      if (!variant) return;

      const channel = member.guild.channels.cache.get(cfg.channelId);
      if (!channel?.isTextBased()) return;

      const resolved = resolveVariables(variant.text, {
        user: member.user,
        member: member.partial ? null : member,
        guild: member.guild,
      });
      const files: AttachmentBuilder[] = [];
      if (variant.imageEnabled) {
        const buf = await this.renderer.render(variant, {
          user: member.user,
          member: member.partial ? null : member,
          guild: member.guild,
        });
        if (buf) files.push(new AttachmentBuilder(buf, { name: 'goodbye.png' }));
      }
      const messageContent = pickContentByMode(variant.imageSendMode, resolved, files.length > 0);
      if (!messageContent && !files.length) return;
      await (channel as TextChannel)
        .send({ content: messageContent || undefined, files })
        .catch((e) =>
          this.logger.warn(
            `Goodbye message in #${(channel as TextChannel).name} failed: ${(e as Error).message}`,
          ),
        );
    } catch (e) {
      this.logger.error(`guildMemberRemove handler crashed`, e as Error);
    }
  }
}

function buildLinkButtons(
  buttons: { label: string; url: string; emoji?: string | null }[] | null,
): unknown[] {
  if (!buttons || !buttons.length) return [];
  return [
    {
      type: 1,
      components: buttons.slice(0, 3).map((b) => ({
        type: 2,
        style: ButtonStyle.Link,
        label: b.label,
        url: b.url,
        ...(b.emoji ? { emoji: parseEmoji(b.emoji) } : {}),
      })),
    },
  ];
}

function parseEmoji(raw: string): { id?: string; name?: string; animated?: boolean } {
  const m = /^<(a?):([^:]+):(\d+)>$/.exec(raw.trim());
  if (m) return { animated: m[1] === 'a', name: m[2], id: m[3] };
  return { name: raw.trim() };
}

function pickContentByMode(
  mode: 'with_text' | 'before_text' | 'image_only' | undefined,
  text: string,
  hasImage: boolean,
): string {
  if (!hasImage) return text;
  if (mode === 'image_only') return '';
  return text;
}

export type { WelcomeTemplate, GoodbyeTemplate };
