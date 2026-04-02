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

  /** Только выдать роль (шаблон: customId rr/give/<id>) */
  @Button(`${REACTION_ROLE_PREFIX}/give/:roleId`)
  async onGiveRoleButton(
    @Context() [interaction]: ButtonContext,
    @ComponentParam('roleId') roleId: string,
  ) {
    return this.applyRoleButton(interaction, roleId, 'give');
  }

  /** Только снять роль (шаблон: customId rr/take/<id>) */
  @Button(`${REACTION_ROLE_PREFIX}/take/:roleId`)
  async onTakeRoleButton(
    @Context() [interaction]: ButtonContext,
    @ComponentParam('roleId') roleId: string,
  ) {
    return this.applyRoleButton(interaction, roleId, 'take');
  }

  /** Переключить роль (шаблон: customId rr/<id>) */
  @Button(`${REACTION_ROLE_PREFIX}/:roleId`)
  async onRoleButton(
    @Context() [interaction]: ButtonContext,
    @ComponentParam('roleId') roleId: string,
  ) {
    return this.applyRoleButton(interaction, roleId, 'toggle');
  }

  private async applyRoleButton(
    interaction: ButtonContext[0],
    roleId: string,
    mode: 'toggle' | 'give' | 'take',
  ) {
    if (!interaction.guild || !interaction.member) {
      return interaction.reply({
        content: 'Команду можно использовать только на сервере.',
        ephemeral: true,
      });
    }

    if (roleId.startsWith('{{') && roleId.endsWith('}}')) {
      return interaction.reply({
        content: 'Эта кнопка отправлена через превью — роль не была подставлена. Установите шаблон для получения рабочих кнопок.',
        ephemeral: true,
      });
    }

    const member =
      interaction.guild.members.cache.get(interaction.user.id) ??
      (await interaction.guild.members.fetch(interaction.user.id).catch(() => null));
    if (!member) {
      return interaction.reply({
        content: 'Не удалось найти участника.',
        ephemeral: true,
      });
    }

    const role =
      interaction.guild.roles.cache.get(roleId) ??
      (await interaction.guild.roles.fetch(roleId).catch(() => null));
    if (!role) {
      return interaction.reply({
        content: 'Роль не найдена на сервере.',
        ephemeral: true,
      });
    }

    const hasRole = member.roles.cache.has(roleId);

    try {
      if (mode === 'give') {
        if (hasRole) {
          return interaction.reply({
            content: `Роль **${role.name}** у вас уже есть.`,
            ephemeral: true,
          });
        }
        await member.roles.add(roleId);
        return interaction.reply({
          content: `Роль **${role.name}** выдана.`,
          ephemeral: true,
        });
      }
      if (mode === 'take') {
        if (!hasRole) {
          return interaction.reply({
            content: `Роль **${role.name}** у вас не была выдана.`,
            ephemeral: true,
          });
        }
        await member.roles.remove(roleId);
        return interaction.reply({
          content: `Роль **${role.name}** снята.`,
          ephemeral: true,
        });
      }
      // toggle
      if (hasRole) {
        await member.roles.remove(roleId);
        return interaction.reply({
          content: `Роль **${role.name}** снята.`,
          ephemeral: true,
        });
      }
      await member.roles.add(roleId);
      return interaction.reply({
        content: `Роль **${role.name}** выдана.`,
        ephemeral: true,
      });
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
