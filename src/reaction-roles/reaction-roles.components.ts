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
        content: 'This command can only be used on a server.',
        ephemeral: true,
      });
    }

    if (roleId.startsWith('{{') && roleId.endsWith('}}')) {
      return interaction.reply({
        content: 'This button was sent via preview — the role was not substituted. Install the template to get working buttons.',
        ephemeral: true,
      });
    }

    const member =
      interaction.guild.members.cache.get(interaction.user.id) ??
      (await interaction.guild.members.fetch(interaction.user.id).catch(() => null));
    if (!member) {
      return interaction.reply({
        content: 'Failed to find member.',
        ephemeral: true,
      });
    }

    const role =
      interaction.guild.roles.cache.get(roleId) ??
      (await interaction.guild.roles.fetch(roleId).catch(() => null));
    if (!role) {
      return interaction.reply({
        content: 'Role not found on the server.',
        ephemeral: true,
      });
    }

    const hasRole = member.roles.cache.has(roleId);

    try {
      if (mode === 'give') {
        if (hasRole) {
          return interaction.reply({
            content: `You already have the **${role.name}** role.`,
            ephemeral: true,
          });
        }
        await member.roles.add(roleId);
        return interaction.reply({
          content: `Role **${role.name}** granted.`,
          ephemeral: true,
        });
      }
      if (mode === 'take') {
        if (!hasRole) {
          return interaction.reply({
            content: `You did not have the **${role.name}** role.`,
            ephemeral: true,
          });
        }
        await member.roles.remove(roleId);
        return interaction.reply({
          content: `Role **${role.name}** removed.`,
          ephemeral: true,
        });
      }
      // toggle
      if (hasRole) {
        await member.roles.remove(roleId);
        return interaction.reply({
          content: `Role **${role.name}** removed.`,
          ephemeral: true,
        });
      }
      await member.roles.add(roleId);
      return interaction.reply({
        content: `Role **${role.name}** granted.`,
        ephemeral: true,
      });
    } catch (e) {
      // Подробная диагностика: почему именно не получилось
      const me = interaction.guild.members.me;
      const botHighest = me?.roles.highest;
      const botRole = me?.roles.botRole;
      const hasManageRoles = me?.permissions.has('ManageRoles');
      const hasAdmin = me?.permissions.has('Administrator');
      console.error(
        `[ReactionRoles] Failed to toggle role on ${interaction.guild.name} (${interaction.guild.id}):\n` +
          `  target role: "${role.name}" (${role.id}), position=${role.position}\n` +
          `  bot highest: "${botHighest?.name}" (${botHighest?.id}), position=${botHighest?.position}\n` +
          `  bot managed: "${botRole?.name}" (${botRole?.id}), position=${botRole?.position}\n` +
          `  permissions: ManageRoles=${hasManageRoles}, Administrator=${hasAdmin}\n` +
          `  error:`,
        e,
      );

      // Пытаемся автоматически исправить: опустить целевую роль под ботом
      // (если у бота есть права и его роль выше)
      if (
        botHighest &&
        role.position >= botHighest.position &&
        (hasManageRoles || hasAdmin)
      ) {
        console.log(
          `[ReactionRoles] Attempting to lower role "${role.name}" below bot position ${botHighest.position}`,
        );
        try {
          await role.setPosition(Math.max(1, botHighest.position - 1));
          // Retry
          if (mode === 'give' || (mode === 'toggle' && !hasRole)) {
            await member.roles.add(roleId);
          } else {
            await member.roles.remove(roleId);
          }
          return interaction.reply({
            content: `Role **${role.name}** ${mode === 'take' || (mode === 'toggle' && hasRole) ? 'removed' : 'granted'}.`,
            ephemeral: true,
          });
        } catch (retryErr) {
          console.error(`[ReactionRoles] Retry also failed:`, retryErr);
        }
      }

      // Тихо закрываем интеракцию без сообщений пользователю
      if (!interaction.replied && !interaction.deferred) {
        try {
          await interaction.deferUpdate();
        } catch {
          // интеракция истекла
        }
      }
      return;
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
