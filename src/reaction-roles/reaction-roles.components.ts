import { Injectable } from '@nestjs/common';
import { Context, Button, ComponentParam, On } from 'necord';
import type { ButtonContext, ContextOf } from 'necord';
import type { MessageReaction, PartialMessageReaction } from 'discord.js';
import { GuildStorageService } from '../common/storage/guild-storage.service';
import { REACTION_ROLE_PREFIX } from './reaction-roles.commands';

/** Ключ эмодзи для хранилища: кастомный id или unicode (name). */
function getEmojiKey(reaction: MessageReaction | PartialMessageReaction): string {
  return reaction.emoji.id ?? reaction.emoji.name ?? '';
}

@Injectable()
export class ReactionRolesComponents {
  constructor(private readonly storage: GuildStorageService) {}

  @Button(`${REACTION_ROLE_PREFIX}/:roleId`)
  async onRoleButton(
    @Context() [interaction]: ButtonContext,
    @ComponentParam('roleId') roleId: string,
  ) {
    if (!interaction.guild || !interaction.member) {
      return interaction.reply({
        content: 'Команду можно использовать только на сервере.',
        ephemeral: true,
      });
    }

    const member = interaction.guild.members.cache.get(interaction.user.id);
    if (!member) {
      return interaction.reply({
        content: 'Не удалось найти участника.',
        ephemeral: true,
      });
    }

    const role = interaction.guild.roles.cache.get(roleId);
    if (!role) {
      return interaction.reply({
        content: 'Роль не найдена на сервере.',
        ephemeral: true,
      });
    }

    const hasRole = member.roles.cache.has(roleId);

    try {
      if (hasRole) {
        await member.roles.remove(roleId);
        return interaction.reply({
          content: `Роль **${role.name}** снята.`,
          ephemeral: true,
        });
      } else {
        await member.roles.add(roleId);
        return interaction.reply({
          content: `Роль **${role.name}** выдана.`,
          ephemeral: true,
        });
      }
    } catch (e) {
      const err = e as Error;
      return interaction.reply({
        content: `Ошибка: ${err.message}. Убедись, что роль бота выше роли «${role.name}» в настройках сервера.`,
        ephemeral: true,
      });
    }
  }

  @On('messageReactionAdd')
  async onReactionAdd(
    @Context() [reaction, user]: ContextOf<'messageReactionAdd'>,
  ): Promise<void> {
    if (user.bot) return;
    if (reaction.partial) {
      try {
        await reaction.fetch();
      } catch {
        return;
      }
    }
    if (reaction.message.partial) {
      try {
        await reaction.message.fetch();
      } catch {
        return;
      }
    }
    const guild = reaction.message.guild;
    if (!guild) return;

    const bindings = this.storage.getReactionRoleBindings(guild.id);
    const messageBindings = bindings[reaction.message.id];
    if (!messageBindings) return;

    const emojiKey = getEmojiKey(reaction);
    const roleId = messageBindings[emojiKey];
    if (!roleId) return;

    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member) return;
    if (member.roles.cache.has(roleId)) return;

    try {
      await member.roles.add(roleId);
    } catch {
      // роль выше бота или нет прав — молча игнорируем
    }
  }

  @On('messageReactionRemove')
  async onReactionRemove(
    @Context() [reaction, user]: ContextOf<'messageReactionRemove'>,
  ): Promise<void> {
    if (user.bot) return;
    if (reaction.partial) {
      try {
        await reaction.fetch();
      } catch {
        return;
      }
    }
    if (reaction.message.partial) {
      try {
        await reaction.message.fetch();
      } catch {
        return;
      }
    }
    const guild = reaction.message.guild;
    if (!guild) return;

    const bindings = this.storage.getReactionRoleBindings(guild.id);
    const roleId = bindings[reaction.message.id]?.[getEmojiKey(reaction)];
    if (!roleId) return;

    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member) return;
    if (!member.roles.cache.has(roleId)) return;

    try {
      await member.roles.remove(roleId);
    } catch {
      // роль выше бота или нет прав
    }
  }
}
