import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  PermissionFlagsBits,
} from 'discord.js';
import { Repository } from 'typeorm';
import type { LogChannelsConfig } from '../common/storage/guild-storage.service';
import { GuildStorageService } from '../common/storage/guild-storage.service';
import { REACTION_ROLE_PREFIX } from '../reaction-roles/reaction-roles.commands';
import { ServerTemplate } from './entities/server-template.entity';
import { TemplateCategory } from './entities/template-category.entity';
import { TemplateChannel } from './entities/template-channel.entity';
import { TemplateLogChannel } from './entities/template-log-channel.entity';
import { TemplateMessage } from './entities/template-message.entity';
import { TemplateReactionRole } from './entities/template-reaction-role.entity';
import { TemplateRole } from './entities/template-role.entity';

const LOG_TYPES: (keyof LogChannelsConfig)[] = [
  'joinLeave',
  'messages',
  'moderation',
  'channel',
  'banKick',
];

@Injectable()
export class TemplateInstallService {
  constructor(
    @Inject(Client) private readonly client: Client,
    @InjectRepository(ServerTemplate)
    private readonly templateRepo: Repository<ServerTemplate>,
    @InjectRepository(TemplateRole)
    private readonly roleRepo: Repository<TemplateRole>,
    @InjectRepository(TemplateCategory)
    private readonly categoryRepo: Repository<TemplateCategory>,
    @InjectRepository(TemplateChannel)
    private readonly channelRepo: Repository<TemplateChannel>,
    @InjectRepository(TemplateMessage)
    private readonly messageRepo: Repository<TemplateMessage>,
    @InjectRepository(TemplateReactionRole)
    private readonly reactionRoleRepo: Repository<TemplateReactionRole>,
    @InjectRepository(TemplateLogChannel)
    private readonly logChannelRepo: Repository<TemplateLogChannel>,
    private readonly storage: GuildStorageService,
  ) {}

  async install(guildId: string, templateId: string): Promise<{ ok: true } | { error: string }> {
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) return { error: 'Сервер не найден или бот не на сервере' };

    const template = await this.templateRepo.findOne({
      where: { id: templateId },
      relations: { roles: true, categories: true, channels: true, messages: true, reactionRoles: true, logChannels: true },
    });
    if (!template) return { error: 'Шаблон не найден' };

    const roleIdByName = new Map<string, string>();
    const categoryIdByName = new Map<string, string>();
    const channelIdByName = new Map<string, string>();
    const messageIdByKey = new Map<string, string>(); // key: channelName:messageOrder

    try {
      // 1. Роли (сортируем по position)
      const roles = (template.roles ?? []).slice().sort((a, b) => a.position - b.position);
      for (const r of roles) {
        const created = await guild.roles.create({
          name: r.name,
          color: r.color,
          permissions: BigInt(r.permissions || '0'),
          position: roleIdByName.size,
          hoist: r.hoist,
          mentionable: r.mentionable,
        });
        roleIdByName.set(r.name, created.id);
      }

      // 2. Категории (Discord type 4)
      const categories = (template.categories ?? []).slice().sort((a, b) => a.position - b.position);
      for (const c of categories) {
        const ch = await guild.channels.create({
          name: c.name,
          type: ChannelType.GuildCategory,
          position: categoryIdByName.size,
        });
        categoryIdByName.set(c.name, ch.id);
      }

      // 3. Каналы (не категории): text, voice и т.д.
      const channels = (template.channels ?? []).slice().sort((a, b) => a.position - b.position);
      for (const ch of channels) {
        const parentId = ch.categoryName ? categoryIdByName.get(ch.categoryName) ?? null : null;
        const overwrites: Array<{ id: string; type: 0 | 1; allow: bigint; deny: bigint }> = [];
        if (ch.permissionOverwrites?.length) {
          for (const o of ch.permissionOverwrites) {
            const roleId = roleIdByName.get(o.roleName);
            if (roleId) {
              overwrites.push({
                id: roleId,
                type: 0,
                allow: BigInt(o.allow || '0'),
                deny: BigInt(o.deny || '0'),
              });
            }
          }
        }
        const created = await guild.channels.create({
          name: ch.name,
          type: ch.type as ChannelType.GuildText | ChannelType.GuildVoice,
          parent: parentId,
          topic: ch.topic ?? undefined,
          position: channelIdByName.size,
          permissionOverwrites: overwrites.length ? overwrites : undefined,
        });
        channelIdByName.set(ch.name, created.id);
      }

      // 4. Сообщения: группируем по channelName, сортируем по messageOrder
      const messages = (template.messages ?? []).slice().sort(
        (a, b) => a.channelName.localeCompare(b.channelName) || a.messageOrder - b.messageOrder,
      );
      for (const msg of messages) {
        const channelId = channelIdByName.get(msg.channelName);
        if (!channelId) continue;
        const channel = guild.channels.cache.get(channelId);
        if (!channel?.isTextBased()) continue;

        const embed = msg.embedJson
          ? this.buildEmbed(msg.embedJson, roleIdByName)
          : undefined;
        const components = msg.componentsJson
          ? this.buildComponents(msg.componentsJson, roleIdByName)
          : undefined;

        const sent = await (channel as import('discord.js').TextChannel).send({
          content: msg.content ?? undefined,
          embeds: embed ? [embed] : undefined,
          components: components ?? undefined,
        });
        messageIdByKey.set(`${msg.channelName}:${msg.messageOrder}`, sent.id);
      }

      // 5. Привязки авторолей
      const reactionRoles = template.reactionRoles ?? [];
      for (const rr of reactionRoles) {
        const key = `${rr.channelName}:${rr.messageOrder}`;
        const messageId = messageIdByKey.get(key);
        const roleId = roleIdByName.get(rr.roleName);
        const channelId = channelIdByName.get(rr.channelName);
        if (!messageId || !roleId || !channelId) continue;
        this.storage.setReactionRoleBinding(guildId, messageId, rr.emojiKey, roleId);
        this.storage.setReactionRoleChannel(guildId, messageId, channelId);
      }

      // 6. Каналы логов
      const logChannels = template.logChannels ?? [];
      for (const lc of logChannels) {
        if (!LOG_TYPES.includes(lc.logType)) continue;
        const channelId = channelIdByName.get(lc.channelName);
        if (channelId) this.storage.setLogChannel(guildId, lc.logType, channelId);
      }

      return { ok: true };
    } catch (e) {
      const err = e as Error;
      return { error: err.message || 'Ошибка установки' };
    }
  }

  private buildEmbed(data: Record<string, unknown>, roleMap: Map<string, string>): EmbedBuilder {
    const embed = new EmbedBuilder();
    if (typeof data.title === 'string') embed.setTitle(this.replaceRolePlaceholders(data.title, roleMap));
    if (typeof data.description === 'string') embed.setDescription(this.replaceRolePlaceholders(data.description, roleMap));
    if (typeof data.color === 'number') embed.setColor(data.color);
    if (typeof data.image === 'string') embed.setImage(data.image);
    return embed;
  }

  private replaceRolePlaceholders(text: string, roleMap: Map<string, string>): string {
    let out = text;
    for (const [name, id] of roleMap) {
      out = out.replace(new RegExp(`\\{\\{${escapeRegex(name)}\\}\\}`, 'g'), id);
    }
    return out;
  }

  private buildComponents(
    data: unknown[],
    roleMap: Map<string, string>,
  ): ActionRowBuilder<ButtonBuilder>[] | undefined {
    if (!Array.isArray(data)) return undefined;
    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    for (const row of data) {
      if (!row || typeof row !== 'object' || !Array.isArray((row as { components?: unknown[] }).components))
        continue;
      const actionRow = new ActionRowBuilder<ButtonBuilder>();
      for (const comp of (row as { components: unknown[] }).components) {
        const c = comp as { type?: number; customId?: string; label?: string; style?: number };
        if (c?.type !== 2) continue;
        let customId = (c.customId ?? '').toString();
        for (const [name, id] of roleMap) {
          customId = customId.replace(`{{${name}}}`, `${REACTION_ROLE_PREFIX}/${id}`);
        }
        actionRow.addComponents(
          new ButtonBuilder()
            .setCustomId(customId)
            .setLabel((c.label as string) ?? 'Роль')
            .setStyle((c.style as ButtonStyle) ?? ButtonStyle.Primary),
        );
      }
      if (actionRow.components.length) rows.push(actionRow);
    }
    return rows.length ? rows : undefined;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
