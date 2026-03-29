import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Client, EmbedBuilder } from 'discord.js';
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

  async check(guildId: string, templateId: string): Promise<TemplateInstallCheckReport> {
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) return { ok: false, error: 'Сервер не найден или бот не на сервере' };

    const template = await this.loadTemplate(templateId);
    if (!template) return { ok: false, error: 'Шаблон не найден' };

    const guildChannelNames = new Set(
      guild.channels.cache
        .filter((c) => c.isTextBased() && !c.isDMBased())
        .map((c) => c.name),
    );
    const guildRoleNames = new Set(
      guild.roles.cache
        .filter((r) => !r.managed && r.id !== guild.id)
        .map((r) => r.name),
    );

    const missingMessageChannels = unique(
      (template.messages ?? [])
        .map((m) => m.channelName)
        .filter((name) => !guildChannelNames.has(name)),
    );

    const reactionRoles = template.reactionRoles ?? [];
    const missingReactionRoleChannels = unique(
      reactionRoles
        .map((rr) => rr.channelName)
        .filter((name) => !guildChannelNames.has(name)),
    );
    const missingReactionRoleNames = unique(
      reactionRoles
        .map((rr) => rr.roleName)
        .filter((name) => !guildRoleNames.has(name)),
    );

    const messageKeys = new Set((template.messages ?? []).map((m) => `${m.channelName}:${m.messageOrder}`));
    const reactionRoleMissingMessageTemplates = reactionRoles
      .filter((rr) => !messageKeys.has(`${rr.channelName}:${rr.messageOrder}`))
      .map((rr) => `${rr.channelName}:${rr.messageOrder}`);

    const missingLogChannels = unique(
      (template.logChannels ?? [])
        .map((l) => l.channelName)
        .filter((name) => !guildChannelNames.has(name)),
    );

    const warnings: string[] = [];
    if (missingMessageChannels.length) warnings.push('Часть сообщений не будет отправлена: не найдены каналы');
    if (missingReactionRoleChannels.length || missingReactionRoleNames.length) {
      warnings.push('Часть авторолей не будет привязана: не найдены каналы/роли');
    }
    if (reactionRoleMissingMessageTemplates.length) {
      warnings.push('Часть авторолей не будет привязана: нет исходного сообщения в шаблоне');
    }
    if (missingLogChannels.length) warnings.push('Часть лог-каналов не будет установлена: каналы не найдены');

    return {
      ok: true,
      summary: {
        templateId: template.id,
        templateName: template.name,
        guildId,
      },
      checks: {
        missingMessageChannels,
        missingReactionRoleChannels,
        missingReactionRoleNames,
        reactionRoleMissingMessageTemplates,
        missingLogChannels,
      },
      warnings,
    };
  }

  async install(guildId: string, templateId: string): Promise<TemplateInstallReport> {
    const emptySummary: TemplateInstallSummary = {
      rolesCreated: 0,
      categoriesCreated: 0,
      channelsCreated: 0,
      messagesSent: 0,
      reactionRolesBound: 0,
      logChannelsSet: 0,
    };
    const emptySkipped: TemplateInstallSkipped = {
      messageChannelMissing: [],
      reactionRoleMissingMessage: [],
      reactionRoleMissingChannel: [],
      reactionRoleMissingRole: [],
      logChannelMissing: [],
    };

    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) {
      return {
        ok: false,
        error: 'Сервер не найден или бот не на сервере',
        summary: emptySummary,
        skipped: emptySkipped,
        warnings: [],
        errors: ['Сервер не найден или бот не на сервере'],
      };
    }

    const template = await this.loadTemplate(templateId);
    if (!template) {
      return {
        ok: false,
        error: 'Шаблон не найден',
        summary: emptySummary,
        skipped: emptySkipped,
        warnings: [],
        errors: ['Шаблон не найден'],
      };
    }

    const guildRoleIdByName = new Map(
      guild.roles.cache
        .filter((r) => !r.managed)
        .map((r) => [r.name, r.id] as const),
    );
    const guildCategoryIdByName = new Map(
      guild.channels.cache
        .filter((c) => c.type === ChannelType.GuildCategory)
        .map((c) => [c.name, c.id] as const),
    );
    const guildChannelIdByName = new Map(
      guild.channels.cache
        .filter((c) => c.isTextBased() && !c.isDMBased())
        .map((c) => [c.name, c.id] as const),
    );

    const summary: TemplateInstallSummary = {
      rolesCreated: 0,
      categoriesCreated: 0,
      channelsCreated: 0,
      messagesSent: 0,
      reactionRolesBound: 0,
      logChannelsSet: 0,
    };
    const skipped: TemplateInstallSkipped = {
      messageChannelMissing: [],
      reactionRoleMissingMessage: [],
      reactionRoleMissingChannel: [],
      reactionRoleMissingRole: [],
      logChannelMissing: [],
    };
    const warnings: string[] = [];
    const errors: string[] = [];

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
        summary.rolesCreated += 1;
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
        summary.categoriesCreated += 1;
      }

      // 3. Каналы (не категории): text, voice и т.д.
      const channels = (template.channels ?? []).slice().sort((a, b) => a.position - b.position);
      for (const ch of channels) {
        const parentId = ch.categoryName
          ? categoryIdByName.get(ch.categoryName) ?? guildCategoryIdByName.get(ch.categoryName) ?? null
          : null;
        const overwrites: Array<{ id: string; type: 0 | 1; allow: bigint; deny: bigint }> = [];
        if (ch.permissionOverwrites?.length) {
          for (const o of ch.permissionOverwrites) {
            const roleId = roleIdByName.get(o.roleName) ?? guildRoleIdByName.get(o.roleName);
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
        summary.channelsCreated += 1;
      }

      // 4. Сообщения: группируем по channelName, сортируем по messageOrder
      const messages = (template.messages ?? []).slice().sort(
        (a, b) => a.channelName.localeCompare(b.channelName) || a.messageOrder - b.messageOrder,
      );
      for (const msg of messages) {
        const channelId = channelIdByName.get(msg.channelName) ?? guildChannelIdByName.get(msg.channelName);
        if (!channelId) {
          skipped.messageChannelMissing.push(msg.channelName);
          continue;
        }
        const channel = guild.channels.cache.get(channelId);
        if (!channel?.isTextBased()) {
          skipped.messageChannelMissing.push(msg.channelName);
          continue;
        }

        const embed = msg.embedJson
          ? this.buildEmbed(msg.embedJson as Record<string, unknown>, roleIdByName)
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
        summary.messagesSent += 1;
      }

      // 5. Привязки авторолей
      const reactionRoles = template.reactionRoles ?? [];
      for (const rr of reactionRoles) {
        const key = `${rr.channelName}:${rr.messageOrder}`;
        const messageId = messageIdByKey.get(key);
        const roleId = roleIdByName.get(rr.roleName) ?? guildRoleIdByName.get(rr.roleName);
        const channelId = channelIdByName.get(rr.channelName) ?? guildChannelIdByName.get(rr.channelName);
        if (!messageId) {
          skipped.reactionRoleMissingMessage.push(key);
          continue;
        }
        if (!roleId) {
          skipped.reactionRoleMissingRole.push(rr.roleName);
          continue;
        }
        if (!channelId) {
          skipped.reactionRoleMissingChannel.push(rr.channelName);
          continue;
        }
        this.storage.setReactionRoleBinding(guildId, messageId, rr.emojiKey, roleId);
        this.storage.setReactionRoleChannel(guildId, messageId, channelId);
        summary.reactionRolesBound += 1;
      }

      // 6. Каналы логов
      const logChannels = template.logChannels ?? [];
      for (const lc of logChannels) {
        if (!LOG_TYPES.includes(lc.logType)) {
          warnings.push(`Пропущен неизвестный тип лога: ${lc.logType}`);
          continue;
        }
        const channelId = channelIdByName.get(lc.channelName) ?? guildChannelIdByName.get(lc.channelName);
        if (!channelId) {
          skipped.logChannelMissing.push(lc.channelName);
          continue;
        }
        this.storage.setLogChannel(guildId, lc.logType, channelId);
        summary.logChannelsSet += 1;
      }

      return {
        ok: true,
        summary,
        skipped: normalizeSkipped(skipped),
        warnings: unique(warnings),
      };
    } catch (e) {
      const err = e as Error;
      errors.push(err.message || 'Ошибка установки');
      return {
        ok: false,
        error: err.message || 'Ошибка установки',
        summary,
        skipped: normalizeSkipped(skipped),
        warnings: unique(warnings),
        errors: unique(errors),
      };
    }
  }

  /**
   * Відправляє тестове повідомлення в канал (той самий пайплайн, що й при інсталі шаблону).
   * Плейсхолдери ролей не підставляються (порожня карта).
   */
  async sendTemplatePreviewToChannel(
    guildId: string,
    channelId: string,
    payload: {
      content?: string | null;
      embedJson?: Record<string, unknown> | null;
      componentsJson?: unknown[] | null;
    },
  ): Promise<void> {
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) throw new Error('Сервер не знайдено або бот не на сервері');
    const channel = guild.channels.cache.get(channelId);
    if (!channel?.isTextBased()) throw new Error('Канал не знайдено або це не текстовий канал');

    const emptyRoleMap = new Map<string, string>();
    const embed = payload.embedJson
      ? this.buildEmbed(payload.embedJson, emptyRoleMap)
      : undefined;
    const components = payload.componentsJson
      ? this.buildComponents(payload.componentsJson, emptyRoleMap)
      : undefined;
    const content = payload.content?.trim() ? payload.content.trim() : undefined;
    if (!content && !embed && !components) {
      throw new Error('Немає що відправити: додайте текст, embed або кнопки');
    }

    await (channel as import('discord.js').TextChannel).send({
      content,
      embeds: embed ? [embed] : undefined,
      components: components ?? undefined,
    });
  }

  private loadTemplate(templateId: string): Promise<ServerTemplate | null> {
    return this.templateRepo.findOne({
      where: { id: templateId },
      relations: {
        roles: true,
        categories: true,
        channels: true,
        messages: true,
        reactionRoles: true,
        logChannels: true,
      },
    });
  }

  /**
   * Собирает Discord Embed из JSON (как в Discord API / ProBot-подобные конструкторы).
   * Поддерживается:
   * - корневой объект embed ИЛИ обёртка `{ embeds: [ { ... } ] }`
   * - title, description, url, color (#RRGGBB или число), timestamp
   * - author: { name, url, icon_url | iconURL }
   * - footer: { text, icon_url | iconURL }
   * - image / thumbnail: строка URL или { url }
   * - fields: [ { name, value, inline } ] (до 25)
   * Плейсхолдеры {{RoleName}} в текстах заменяются на id роли из шаблона.
   */
  private buildEmbed(data: Record<string, unknown>, roleMap: Map<string, string>): EmbedBuilder | undefined {
    const raw = unwrapEmbedPayload(data);
    if (!raw) return undefined;

    const embed = new EmbedBuilder();
    let hasContent = false;

    if (typeof raw.title === 'string' && raw.title.trim()) {
      embed.setTitle(this.replaceRolePlaceholders(raw.title, roleMap));
      hasContent = true;
    }
    if (typeof raw.url === 'string' && raw.url.trim()) {
      embed.setURL(raw.url.trim());
    }
    if (typeof raw.description === 'string' && raw.description.length) {
      embed.setDescription(this.replaceRolePlaceholders(raw.description, roleMap));
      hasContent = true;
    }

    const color = parseEmbedColor(raw.color);
    if (color !== undefined) {
      embed.setColor(color);
      hasContent = true;
    }

    if (raw.author && typeof raw.author === 'object') {
      const a = raw.author as Record<string, unknown>;
      const name =
        typeof a.name === 'string' ? this.replaceRolePlaceholders(a.name, roleMap).trim() : '';
      if (name) {
        const iconUrl = pickString(a, 'icon_url', 'iconURL');
        const url = typeof a.url === 'string' ? a.url.trim() : undefined;
        embed.setAuthor({ name, iconURL: iconUrl, url });
        hasContent = true;
      }
    }

    if (raw.footer && typeof raw.footer === 'object') {
      const f = raw.footer as Record<string, unknown>;
      const text =
        typeof f.text === 'string' ? this.replaceRolePlaceholders(f.text, roleMap).trim() : '';
      if (text) {
        const iconUrl = pickString(f, 'icon_url', 'iconURL');
        embed.setFooter({ text, iconURL: iconUrl });
        hasContent = true;
      }
    }

    const thumbUrl = resolveMediaUrl(raw.thumbnail);
    if (thumbUrl) {
      embed.setThumbnail(thumbUrl);
      hasContent = true;
    }

    const imageUrl = resolveMediaUrl(raw.image);
    if (imageUrl) {
      embed.setImage(imageUrl);
      hasContent = true;
    }

    if (Array.isArray(raw.fields) && raw.fields.length) {
      const fields = raw.fields
        .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object')
        .slice(0, 25)
        .map((f) => ({
          name:
            typeof f.name === 'string'
              ? this.replaceRolePlaceholders(f.name, roleMap).trim() || '\u200b'
              : '\u200b',
          value:
            typeof f.value === 'string'
              ? this.replaceRolePlaceholders(f.value, roleMap)
              : '\u200b',
          inline: Boolean(f.inline),
        }));
      if (fields.length) {
        embed.addFields(fields);
        hasContent = true;
      }
    }

    if (raw.timestamp !== undefined && raw.timestamp !== null) {
      const t = raw.timestamp;
      if (typeof t === 'number') {
        embed.setTimestamp(t);
        hasContent = true;
      } else if (typeof t === 'string') {
        const d = new Date(t);
        if (!Number.isNaN(d.getTime())) {
          embed.setTimestamp(d);
          hasContent = true;
        }
      }
    }

    if (!hasContent) return undefined;
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

/** Discord webhook payload: `{ embeds: [ {...} ] }` или сразу объект embed. */
function unwrapEmbedPayload(data: Record<string, unknown>): Record<string, unknown> | null {
  if (Array.isArray(data.embeds) && data.embeds.length > 0) {
    const first = data.embeds[0];
    if (first && typeof first === 'object') return first as Record<string, unknown>;
  }
  return data;
}

function parseEmbedColor(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const s = v.trim();
    if (/^#?[0-9a-fA-F]{6}$/.test(s)) {
      const hex = s.startsWith('#') ? s.slice(1) : s;
      return parseInt(hex, 16);
    }
  }
  return undefined;
}

function resolveMediaUrl(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (v && typeof v === 'object') {
    const url = (v as { url?: unknown }).url;
    if (typeof url === 'string' && url.trim()) return url.trim();
  }
  return undefined;
}

function pickString(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

function unique(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))];
}

function normalizeSkipped(skipped: TemplateInstallSkipped): TemplateInstallSkipped {
  return {
    messageChannelMissing: unique(skipped.messageChannelMissing),
    reactionRoleMissingMessage: unique(skipped.reactionRoleMissingMessage),
    reactionRoleMissingChannel: unique(skipped.reactionRoleMissingChannel),
    reactionRoleMissingRole: unique(skipped.reactionRoleMissingRole),
    logChannelMissing: unique(skipped.logChannelMissing),
  };
}

export type TemplateInstallSummary = {
  rolesCreated: number;
  categoriesCreated: number;
  channelsCreated: number;
  messagesSent: number;
  reactionRolesBound: number;
  logChannelsSet: number;
};

export type TemplateInstallSkipped = {
  messageChannelMissing: string[];
  reactionRoleMissingMessage: string[];
  reactionRoleMissingChannel: string[];
  reactionRoleMissingRole: string[];
  logChannelMissing: string[];
};

export type TemplateInstallReport =
  | {
      ok: true;
      summary: TemplateInstallSummary;
      skipped: TemplateInstallSkipped;
      warnings: string[];
    }
  | {
      ok: false;
      error: string;
      summary: TemplateInstallSummary;
      skipped: TemplateInstallSkipped;
      warnings: string[];
      errors: string[];
    };

export type TemplateInstallCheckReport =
  | { ok: false; error: string }
  | {
      ok: true;
      summary: {
        templateId: string;
        templateName: string;
        guildId: string;
      };
      checks: {
        missingMessageChannels: string[];
        missingReactionRoleChannels: string[];
        missingReactionRoleNames: string[];
        reactionRoleMissingMessageTemplates: string[];
        missingLogChannels: string[];
      };
      warnings: string[];
    };
