import { Injectable } from '@nestjs/common';
import { Context, Options, SlashCommand } from 'necord';
import type { SlashCommandContext } from 'necord';
import { EmbedBuilder } from 'discord.js';
import { PostMessageDto } from './dto/post-message.dto';

@Injectable()
export class MessageConstructorCommands {
  @SlashCommand({
    name: 'post',
    description: 'Post a formatted message as the bot (message constructor)',
  })
  async onPost(
    @Context() [interaction]: SlashCommandContext,
    @Options() dto: PostMessageDto,
  ) {
    await interaction.deferReply({ ephemeral: true });

    const channel = interaction.guild?.channels.cache.get(dto.channel.id);
    if (!channel?.isTextBased()) {
      return interaction.editReply({
        content: 'Please specify a text channel.',
      });
    }

    const embed = new EmbedBuilder()
      .setTitle(dto.title)
      .setDescription(dto.description)
      .setColor(0x5865f2);

    if (dto.image) {
      try {
        new URL(dto.image);
        embed.setImage(dto.image);
      } catch {
        // невалидный URL — игнорируем
      }
    }

    await (channel as import('discord.js').TextChannel).send({ embeds: [embed] });

    return interaction.editReply({
      content: `Message posted in channel <#${dto.channel.id}>.`,
    });
  }
}
