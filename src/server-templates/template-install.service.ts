import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Client, EmbedBuilder } from 'discord.js';
import { Repository } from 'typeorm';
import type { LogChannelsConfig } from '../common/storage/guild-storage.service';
import { GuildStorageService } from '../common/storage/guild-storage.service';
import { REACTION_ROLE_PREFIX } from '../reaction-roles/reaction-roles.commands';
import { ServerStatsService } from '../server-stats/server-stats.service';
import { ServerTemplate } from './entities/server-template.entity';
import { TemplateCategory } from './entities/template-category.entity';
import { TemplateChannel } from './entities/template-channel.entity';
import { TemplateEmoji } from './entities/template-emoji.entity';
import { TemplateLogChannel } from './entities/template-log-channel.entity';
import { TemplateMessage } from './entities/template-message.entity';
import { TemplateReactionRole } from './entities/template-reaction-role.entity';
import { TemplateRole } from './entities/template-role.entity';
import { TemplateSticker } from './entities/template-sticker.entity';
import { GuildMessage } from '../guild-data/entities/guild-message.entity';
import { GuildReactionRole } from '../guild-data/entities/guild-reaction-role.entity';

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
    @InjectRepository(TemplateEmoji)
    private readonly emojiRepo: Repository<TemplateEmoji>,
    @InjectRepository(TemplateSticker)
    private readonly stickerRepo: Repository<TemplateSticker>,
    @InjectRepository(GuildMessage)
    private readonly guildMessageRepo: Repository<GuildMessage>,
    @InjectRepository(GuildReactionRole)
    private readonly guildReactionRoleRepo: Repository<GuildReactionRole>,
    private readonly storage: GuildStorageService,
    private readonly serverStats: ServerStatsService,
  ) {}

  async check(guildId: string, templateId: string): Promise<TemplateInstallCheckReport> {
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) return { ok: false, error: 'Server not found or bot is not on the server' };

    const template = await this.loadTemplate(templateId);
    if (!template) return { ok: false, error: 'Template not found' };

    await guild.channels.fetch();
    await guild.roles.fetch();

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
    if (missingMessageChannels.length) warnings.push('Some messages will not be sent: channels not found');
    if (missingReactionRoleChannels.length || missingReactionRoleNames.length) {
      warnings.push('Some auto-roles will not be bound: channels/roles not found');
    }
    if (reactionRoleMissingMessageTemplates.length) {
      warnings.push('Some auto-roles will not be bound: source message missing in template');
    }
    if (missingLogChannels.length) warnings.push('Some log channels will not be set: channels not found');

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
      emojisCreated: 0,
      stickersCreated: 0,
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
        error: 'Server not found or bot is not on the server',
        summary: emptySummary,
        skipped: emptySkipped,
        warnings: [],
        errors: ['Server not found or bot is not on the server'],
      };
    }

    const template = await this.loadTemplate(templateId);
    if (!template) {
      return {
        ok: false,
        error: 'Template not found',
        summary: emptySummary,
        skipped: emptySkipped,
        warnings: [],
        errors: ['Template not found'],
      };
    }

    // Принудительно обновляем кэш каналов и ролей перед установкой,
    // чтобы не пропустить каналы созданные Discord-шаблоном.
    await guild.channels.fetch();
    await guild.roles.fetch();

    const guildRoleIdByName = new Map(
      guild.roles.cache
        .filter((r) => !r.managed)
        .map((r) => [r.name, r.id] as const),
    );
    // ВАЖНО: эти мапы пересобираются после шага 0.5 (ServerStats), потому что
    // ServerStats создаёт новую категорию и каналы — без обновления мапы шаг 2.1
    // не сможет найти ServerStats-категорию для применения категориальных прав.
    let guildCategoryIdByName = new Map(
      guild.channels.cache
        .filter((c) => c.type === ChannelType.GuildCategory)
        .map((c) => [c.name, c.id] as const),
    );
    let guildChannelIdByName = new Map(
      guild.channels.cache
        .filter((c) => c.isTextBased() && !c.isDMBased())
        .map((c) => [c.name, c.id] as const),
    );
    const rebuildGuildMaps = () => {
      guildCategoryIdByName = new Map(
        guild.channels.cache
          .filter((c) => c.type === ChannelType.GuildCategory)
          .map((c) => [c.name, c.id] as const),
      );
      guildChannelIdByName = new Map(
        guild.channels.cache
          .filter((c) => c.isTextBased() && !c.isDMBased())
          .map((c) => [c.name, c.id] as const),
      );
    };

    const summary: TemplateInstallSummary = {
      rolesCreated: 0,
      categoriesCreated: 0,
      channelsCreated: 0,
      messagesSent: 0,
      reactionRolesBound: 0,
      logChannelsSet: 0,
      emojisCreated: 0,
      stickersCreated: 0,
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
      // 0. Иконка сервера (best-effort — если не получилось, установка не падает)
      if (template.iconUrl) {
        try {
          await guild.setIcon(template.iconUrl);
        } catch (e) {
          warnings.push(`Failed to set server icon: ${(e as Error).message}`);
        }
      }

      // 0.5. Server stats — создаём ДО шагов категорий и прав, чтобы:
      //  — не дублировать категорию (если она уже задана как TemplateCategory или в categoryGrants)
      //  — права из categoryGrants могли применяться к ServerStats-категории и её каналам
      if (template.enableServerStats) {
        try {
          await this.serverStats.setup(guildId, {
            categoryName: template.statsCategoryName ?? undefined,
            totalName: template.statsTotalName ?? undefined,
            humansName: template.statsHumansName ?? undefined,
            botsName: template.statsBotsName ?? undefined,
            onlineName: template.statsOnlineName ?? undefined,
          });
          console.log('[TemplateInstall] server stats setup completed (early phase)');
          // Перечитываем кэш каналов и обновляем мапы — иначе шаг 2.1
          // не сможет найти свежесозданную ServerStats-категорию по имени.
          await guild.channels.fetch().catch(() => null);
          rebuildGuildMaps();
        } catch (e) {
          const msg = (e as Error).message;
          console.error('[TemplateInstall] server stats setup FAILED:', e);
          warnings.push(`Failed to configure server stats: ${msg}`);
        }
      }

      // 1. Роли (сортируем по position) — пропускаем если роль с таким именем уже есть
      const roles = (template.roles ?? []).slice().sort((a, b) => a.position - b.position);
      for (const r of roles) {
        const existingId = guildRoleIdByName.get(r.name);
        if (existingId) {
          roleIdByName.set(r.name, existingId);
          continue;
        }
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

      // 1.1. Поднимаем роль бота выше всех немоделируемых ролей —
      // это даёт боту иерархию, достаточную для выдачи ролей шаблона через кнопки.
      // Если не получилось (у бота нет MANAGE_ROLES, или его роль ниже админки),
      // падаем back: опускаем все шаблонные роли на 1 ниже текущей позиции бота.
      try {
        await guild.roles.fetch();
        const me = guild.members.me ?? (await guild.members.fetchMe());
        const botRole = me.roles.botRole;
        const botHighest = me.roles.highest;

        let liftOk = false;
        if (botRole) {
          const maxNonManaged = Math.max(
            1,
            ...guild.roles.cache
              .filter((r) => !r.managed && r.id !== guild.id)
              .map((r) => r.position),
          );
          if (botRole.position <= maxNonManaged) {
            try {
              await botRole.setPosition(maxNonManaged + 1);
              liftOk = true;
              console.log(`[TemplateInstall] Bot role lifted to position ${maxNonManaged + 1}`);
            } catch (err) {
              console.warn(
                `[TemplateInstall] Failed to lift bot role: ${(err as Error).message}. ` +
                  'Fallback will be applied — lowering template roles.',
              );
            }
          } else {
            liftOk = true; // уже выше всех
          }
        }

        // Fallback: если поднять роль бота не вышло — опускаем ВСЕ роли, на которые
        // ссылаются кнопки авторолей (включая роли от Discord-шаблона), под роль бота
        if (!liftOk && botHighest) {
          // Собираем имена ролей из componentsJson всех сообщений шаблона
          const referencedRoleNames = new Set<string>();
          for (const msg of template.messages ?? []) {
            const components = coerceComponentsJsonField(msg.componentsJson);
            if (!components) continue;
            for (const row of components) {
              if (!row || typeof row !== 'object') continue;
              const rowComps = (row as { components?: unknown[] }).components;
              if (!Array.isArray(rowComps)) continue;
              for (const c of rowComps) {
                const cid = (c as { customId?: string })?.customId;
                if (typeof cid !== 'string') continue;
                // Ищем {{RoleName}} в customId
                const matches = cid.matchAll(/\{\{([^}#][^}]*)\}\}/g);
                for (const m of matches) referencedRoleNames.add(m[1]);
              }
            }
          }
          // + все роли, на которые ссылаются reactionRoles
          for (const rr of template.reactionRoles ?? []) {
            if (rr.roleName) referencedRoleNames.add(rr.roleName);
          }

          // Резолвим имена → реальные ID (из наших + с гильдии)
          const guildRoleByName = new Map(
            guild.roles.cache
              .filter((r) => !r.managed && r.id !== guild.id)
              .map((r) => [r.name, r] as const),
          );
          const rolesToLower: string[] = [];
          for (const name of referencedRoleNames) {
            const id = roleIdByName.get(name) ?? guildRoleByName.get(name)?.id;
            if (!id) continue;
            const r = guild.roles.cache.get(id);
            if (!r || r.managed) continue;
            if (r.position >= botHighest.position) rolesToLower.push(id);
          }

          if (rolesToLower.length > 0) {
            const targetPosition = Math.max(1, botHighest.position - 1);
            const positions = rolesToLower.map((roleId, idx) => ({
              role: roleId,
              position: Math.max(1, targetPosition - idx),
            }));
            console.log(
              `[TemplateInstall] Lowering ${rolesToLower.length} referenced roles below bot position ${botHighest.position}`,
            );
            await guild.roles.setPositions(positions).catch((err) => {
              warnings.push(
                `Failed to lower roles below the bot role: ${(err as Error).message}. ` +
                  'Drag the bot role above all template roles manually in server settings.',
              );
            });
          } else {
            console.log(
              `[TemplateInstall] No referenced roles need lowering (all below bot position ${botHighest.position})`,
            );
          }
        }
      } catch (e) {
        warnings.push(
          `Failed to configure role hierarchy: ${(e as Error).message}. ` +
            'Drag the bot role above all roles manually in server settings.',
        );
      }

      // 2. Категории (Discord type 4) — пропускаем если уже есть на гильдии (Discord-шаблон создал)
      const categories = (template.categories ?? []).slice().sort((a, b) => a.position - b.position);
      for (const c of categories) {
        const existingId = guildCategoryIdByName.get(c.name);
        if (existingId) {
          // Уже существует — не дублируем, просто запоминаем ID
          categoryIdByName.set(c.name, existingId);
          continue;
        }
        const ch = await guild.channels.create({
          name: c.name,
          type: ChannelType.GuildCategory,
          position: categoryIdByName.size,
        });
        categoryIdByName.set(c.name, ch.id);
        summary.categoriesCreated += 1;
      }

      // 2.1. Права верификационной роли на выбранные категории.
      // Берём ПЕРВУЮ роль из шаблона (по позиции) — она и есть верификационная.
      // Открываем для неё ViewChannel + SendMessages только в категориях из categoryGrants,
      // запрещаем @everyone видеть эти категории. Остальные категории не трогаем.
      const grants = template.categoryGrants ?? [];
      if (grants.length > 0) {
        const firstRole = (template.roles ?? []).slice().sort((a, b) => a.position - b.position)[0];
        const firstRoleId = firstRole ? roleIdByName.get(firstRole.name) : undefined;
        if (!firstRoleId) {
          warnings.push(
            'Category bindings are set, but the template has no roles — add a role (it will become the verification role).',
          );
        } else {
          const { PermissionsBitField } = await import('discord.js');
          for (const g of grants) {
            const categoryId =
              categoryIdByName.get(g.categoryName) ?? guildCategoryIdByName.get(g.categoryName);
            if (!categoryId) {
              warnings.push(
                `Category "${g.categoryName}" not found in the template or on the server — permissions not applied.`,
              );
              continue;
            }
            const cat = guild.channels.cache.get(categoryId);
            if (!cat || cat.type !== ChannelType.GuildCategory) continue;
            const overwrites = [
              {
                id: guild.roles.everyone.id,
                deny: [PermissionsBitField.Flags.ViewChannel],
              },
              {
                id: firstRoleId,
                allow: [
                  PermissionsBitField.Flags.ViewChannel,
                  PermissionsBitField.Flags.SendMessages,
                  PermissionsBitField.Flags.ReadMessageHistory,
                ],
              },
            ];
            try {
              // 1) на самой категории
              await cat.permissionOverwrites.set(overwrites);

              // 2) синхронизируем на ВСЕ каналы которые лежат под этой категорией.
              // Discord по умолчанию не наследует овэрайты — нужно явно проставить на каждый канал.
              const childChannels = guild.channels.cache.filter(
                (c) =>
                  'parentId' in c &&
                  (c as { parentId?: string | null }).parentId === categoryId &&
                  c.type !== ChannelType.GuildCategory,
              );
              for (const ch of childChannels.values()) {
                const target = ch as unknown as {
                  permissionOverwrites?: { set: (o: typeof overwrites) => Promise<unknown> };
                };
                if (!target.permissionOverwrites?.set) continue;
                await target.permissionOverwrites.set(overwrites).catch((err) => {
                  warnings.push(
                    `Failed to sync permissions on channel "#${ch.name}" in category "${g.categoryName}": ${(err as Error).message}`,
                  );
                });
              }
            } catch (e) {
              warnings.push(
                `Failed to set permissions for category "${g.categoryName}": ${(e as Error).message}`,
              );
            }
          }
        }
      }

      // 3. Каналы (не категории): text, voice и т.д. — пропускаем если уже есть на гильдии
      const channels = (template.channels ?? []).slice().sort((a, b) => a.position - b.position);
      for (const ch of channels) {
        const existingId = guildChannelIdByName.get(ch.name);
        if (existingId) {
          channelIdByName.set(ch.name, existingId);
          continue;
        }
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

      // 3.1. Re-sync category permissions onto ALL child channels (including ones we just created)
      // Discord doesn't auto-inherit overrides — we must explicitly copy them onto each channel.
      if (grants.length > 0) {
        const firstRole = (template.roles ?? []).slice().sort((a, b) => a.position - b.position)[0];
        const firstRoleId = firstRole ? roleIdByName.get(firstRole.name) : undefined;
        if (firstRoleId) {
          const { PermissionsBitField } = await import('discord.js');
          const overwrites = [
            {
              id: guild.roles.everyone.id,
              deny: [PermissionsBitField.Flags.ViewChannel],
            },
            {
              id: firstRoleId,
              allow: [
                PermissionsBitField.Flags.ViewChannel,
                PermissionsBitField.Flags.SendMessages,
                PermissionsBitField.Flags.ReadMessageHistory,
              ],
            },
          ];
          // Re-fetch to make sure newly-created channels are in cache
          await guild.channels.fetch().catch(() => null);
          for (const g of grants) {
            const categoryId =
              categoryIdByName.get(g.categoryName) ?? guildCategoryIdByName.get(g.categoryName);
            if (!categoryId) continue;
            const childChannels = guild.channels.cache.filter(
              (c) =>
                'parentId' in c &&
                (c as { parentId?: string | null }).parentId === categoryId &&
                c.type !== ChannelType.GuildCategory,
            );
            for (const ch of childChannels.values()) {
              const target = ch as unknown as {
                permissionOverwrites?: { set: (o: typeof overwrites) => Promise<unknown> };
              };
              if (!target.permissionOverwrites?.set) continue;
              await target.permissionOverwrites.set(overwrites).catch(() => null);
            }
          }
        }
      }

      // 3.2. Verification: скрыть выбранную категорию + её каналы от выбранной роли.
      // Используется когда верификационный канал должен исчезнуть после получения роли:
      //   @everyone — видит, верифицированный — НЕ видит.
      // Одна категория и одна роль на шаблон.
      if (template.verifiedHideCategoryName && template.verifiedHideRoleName) {
        const catName = template.verifiedHideCategoryName.trim();
        const roleName = template.verifiedHideRoleName.trim();
        const hideRoleId = roleIdByName.get(roleName) ?? guildRoleIdByName.get(roleName);
        const hideCategoryId =
          categoryIdByName.get(catName) ?? guildCategoryIdByName.get(catName);
        if (!hideRoleId) {
          warnings.push(
            `Verification: role "${roleName}" not found — visibility was not configured.`,
          );
        } else if (!hideCategoryId) {
          warnings.push(
            `Verification: category "${catName}" not found — visibility was not configured.`,
          );
        } else {
          await guild.channels.fetch().catch(() => null);
          const cat = guild.channels.cache.get(hideCategoryId);
          if (cat && cat.type === ChannelType.GuildCategory) {
            try {
              // Только Deny ViewChannel для роли — @everyone не трогаем (по умолчанию видит).
              await cat.permissionOverwrites.edit(hideRoleId, {
                ViewChannel: false,
              });
            } catch (e) {
              warnings.push(
                `Verification: failed to hide category "${catName}" from role "${roleName}": ${(e as Error).message}`,
              );
            }
            // Тот же deny на все каналы внутри
            const childChannels = guild.channels.cache.filter(
              (c) =>
                'parentId' in c &&
                (c as { parentId?: string | null }).parentId === hideCategoryId &&
                c.type !== ChannelType.GuildCategory,
            );
            for (const ch of childChannels.values()) {
              const target = ch as unknown as {
                permissionOverwrites?: {
                  edit: (id: string, perms: { ViewChannel: boolean }) => Promise<unknown>;
                };
              };
              if (!target.permissionOverwrites?.edit) continue;
              await target.permissionOverwrites
                .edit(hideRoleId, { ViewChannel: false })
                .catch(() => null);
            }
          }
        }
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

        // embedJson и componentsJson могут лежать в БД и как объект/массив, и как строка
        // (фронт часто отправляет JSON-строкой) — нормализуем
        // Для подстановки {{RoleName}} и {{#ChannelName}} мёрджим сущности созданные install'ом
        // + уже существующие на гильдии (созданные Discord-шаблоном на Шаге 1).
        const roleMapForMsg = new Map<string, string>([
          ...guildRoleIdByName,
          ...roleIdByName, // свежесозданные имеют приоритет при совпадении имён
        ]);
        const channelMapForMsg = new Map<string, string>([
          ...guildChannelIdByName,
          ...channelIdByName,
        ]);
        const ctx = { roleMap: roleMapForMsg, channelMap: channelMapForMsg };

        const content = msg.content?.trim() ? this.replacePlaceholders(msg.content.trim(), ctx) : undefined;
        const embedRecord = coerceEmbedJsonField(msg.embedJson);
        const embed = embedRecord ? this.buildEmbed(embedRecord, ctx) : undefined;
        const componentsPayload = coerceComponentsJsonField(msg.componentsJson);
        const components = componentsPayload
          ? this.buildComponents(componentsPayload, ctx)
          : undefined;

        // Пропускаем полностью пустые сообщения — Discord не разрешает их отправлять
        if (!content && !embed && !components) {
          warnings.push(`Message in channel "${msg.channelName}" is empty — skipped`);
          continue;
        }

        const sent = await (channel as import('discord.js').TextChannel).send({
          content,
          embeds: embed ? [embed] : undefined,
          components: components ?? undefined,
        });
        messageIdByKey.set(`${msg.channelName}:${msg.messageOrder}`, sent.id);
        summary.messagesSent += 1;

        // Snapshot to GuildMessage so user can edit it from User Admin Panel.
        // Сохраняем уже-подставленный embed/components (с реальными role/channel id).
        try {
          const snapshot = this.guildMessageRepo.create({
            guildId,
            discordChannelId: channelId,
            discordMessageId: sent.id,
            channelName: msg.channelName,
            content: content ?? null,
            embedJson: embedRecord ? this.applyPlaceholdersToObject(embedRecord, ctx) : null,
            componentsJson: componentsPayload
              ? this.applyPlaceholdersToArray(componentsPayload, ctx)
              : null,
          });
          await this.guildMessageRepo.save(snapshot);
        } catch (e) {
          warnings.push(`Snapshot for message in #${msg.channelName} failed: ${(e as Error).message}`);
        }
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

        // Snapshot to GuildReactionRole (per-guild table for User Admin Panel)
        try {
          const existing = await this.guildReactionRoleRepo.findOne({
            where: { guildId, discordMessageId: messageId, emojiKey: rr.emojiKey },
          });
          if (existing) {
            existing.discordChannelId = channelId;
            existing.discordRoleId = roleId;
            await this.guildReactionRoleRepo.save(existing);
          } else {
            await this.guildReactionRoleRepo.save(
              this.guildReactionRoleRepo.create({
                guildId,
                discordChannelId: channelId,
                discordMessageId: messageId,
                emojiKey: rr.emojiKey,
                discordRoleId: roleId,
              }),
            );
          }
        } catch (e) {
          warnings.push(`Reaction-role snapshot failed: ${(e as Error).message}`);
        }
      }

      // 6. Каналы логов
      const logChannels = template.logChannels ?? [];
      for (const lc of logChannels) {
        if (!LOG_TYPES.includes(lc.logType)) {
          warnings.push(`Skipped unknown log type: ${lc.logType}`);
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

      // 7. Эмодзи
      const emojis = template.emojis ?? [];
      for (const em of emojis) {
        // Discord требует имя 2-32 символа, [a-zA-Z0-9_]
        let name = em.name.replace(/[^a-zA-Z0-9_]/g, '_');
        if (name.length < 2) name = `emoji_${name || em.id.slice(0, 6)}`;
        name = name.slice(0, 32);
        try {
          await guild.emojis.create({ attachment: em.imageUrl, name });
          summary.emojisCreated += 1;
        } catch (e) {
          warnings.push(`Failed to create emoji "${name}": ${(e as Error).message}`);
        }
      }

      // 8. Стикеры
      const stickers = template.stickers ?? [];
      for (const st of stickers) {
        try {
          await guild.stickers.create({
            file: st.imageUrl,
            name: st.name,
            tags: st.tags,
            description: st.description ?? undefined,
          });
          summary.stickersCreated += 1;
        } catch (e) {
          warnings.push(`Failed to create sticker "${st.name}": ${(e as Error).message}`);
        }
      }

      // (Server stats был перенесён в шаг 0.5 — до создания категорий и применения прав,
      // чтобы права из categoryGrants могли распространиться на ServerStats-категорию.)

      return {
        ok: true,
        summary,
        skipped: normalizeSkipped(skipped),
        warnings: unique(warnings),
      };
    } catch (e) {
      const err = e as Error;
      errors.push(err.message || 'Installation error');
      return {
        ok: false,
        error: err.message || 'Installation error',
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
      /** Объект или строка JSON (как с фронта из textarea) */
      embedJson?: Record<string, unknown> | string | null;
      componentsJson?: unknown[] | string | null;
    },
  ): Promise<void> {
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) throw new Error('Server not found or bot is not on the server');
    const channel = guild.channels.cache.get(channelId);
    if (!channel?.isTextBased()) throw new Error('Channel not found or is not a text channel');

    // В превью плейсхолдеры не подставляем (ctx пустой) — пользователь увидит
    // шаблон как есть, без реальных каналов/ролей.
    const emptyCtx: PlaceholderContext = {
      roleMap: new Map<string, string>(),
      channelMap: new Map<string, string>(),
    };
    const embedRecord = coerceEmbedJsonField(payload.embedJson);
    const embed = embedRecord ? this.buildEmbed(embedRecord, emptyCtx) : undefined;
    const componentsPayload = coerceComponentsJsonField(payload.componentsJson);
    const components = componentsPayload
      ? this.buildComponents(componentsPayload, emptyCtx)
      : undefined;
    const content = payload.content?.trim() ? payload.content.trim() : undefined;
    if (!content && !embed && !components) {
      throw new Error('Nothing to send: add text, embed, or buttons');
    }

    await (channel as import('discord.js').TextChannel).send({
      content,
      embeds: embed ? [embed] : undefined,
      components: components ?? undefined,
    });
  }

  private loadTemplate(templateId: string): Promise<ServerTemplate | null> {
    // relationLoadStrategy: 'query' = отдельный SELECT на каждую relation вместо
    // одного огромного JOIN. Без этого 9 relations создают cartesian product
    // и Node падает с heap OOM на средних/больших шаблонах.
    return this.templateRepo.findOne({
      where: { id: templateId },
      relations: {
        roles: true,
        categories: true,
        channels: true,
        messages: true,
        reactionRoles: true,
        logChannels: true,
        emojis: true,
        stickers: true,
        categoryGrants: true,
      },
      relationLoadStrategy: 'query',
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
   * Плейсхолдеры: {{RoleName}} → id роли, {{#channel-name}} → <#channelId>.
   */
  private buildEmbed(data: Record<string, unknown>, ctx: PlaceholderContext): EmbedBuilder | undefined {
    const raw = unwrapEmbedPayload(data);
    if (!raw) return undefined;

    const embed = new EmbedBuilder();
    let hasContent = false;

    if (typeof raw.title === 'string' && raw.title.trim()) {
      embed.setTitle(this.replacePlaceholders(raw.title, ctx));
      hasContent = true;
    }
    if (typeof raw.url === 'string' && raw.url.trim()) {
      embed.setURL(raw.url.trim());
    }
    if (typeof raw.description === 'string' && raw.description.length) {
      embed.setDescription(this.replacePlaceholders(raw.description, ctx));
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
        typeof a.name === 'string' ? this.replacePlaceholders(a.name, ctx).trim() : '';
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
        typeof f.text === 'string' ? this.replacePlaceholders(f.text, ctx).trim() : '';
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
              ? this.replacePlaceholders(f.name, ctx).trim() || '\u200b'
              : '\u200b',
          value:
            typeof f.value === 'string'
              ? this.replacePlaceholders(f.value, ctx)
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

  /**
   * Подставляет плейсхолдеры в текст:
   * - `{{RoleName}}` → id роли (из roleMap)
   * - `{{#channel-name}}` → `<#channelId>` (Discord-меншн канала, становится кликабельной ссылкой)
   */
  private replacePlaceholders(text: string, ctx: PlaceholderContext): string {
    let out = text;
    for (const [name, id] of ctx.channelMap) {
      out = out.replace(new RegExp(`\\{\\{#${escapeRegex(name)}\\}\\}`, 'g'), `<#${id}>`);
    }
    for (const [name, id] of ctx.roleMap) {
      out = out.replace(new RegExp(`\\{\\{${escapeRegex(name)}\\}\\}`, 'g'), id);
    }
    return out;
  }

  /**
   * Глубоко обходит объект и заменяет плейсхолдеры во всех string-полях.
   * Используется для подготовки snapshot (GuildMessage) — там лежит уже-резолвленный JSON.
   */
  private applyPlaceholdersToObject(
    obj: Record<string, unknown>,
    ctx: PlaceholderContext,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string') {
        out[k] = this.replacePlaceholders(v, ctx);
      } else if (Array.isArray(v)) {
        out[k] = this.applyPlaceholdersToArray(v, ctx);
      } else if (v && typeof v === 'object') {
        out[k] = this.applyPlaceholdersToObject(v as Record<string, unknown>, ctx);
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  private applyPlaceholdersToArray(arr: unknown[], ctx: PlaceholderContext): unknown[] {
    return arr.map((item) => {
      if (typeof item === 'string') return this.replacePlaceholders(item, ctx);
      if (Array.isArray(item)) return this.applyPlaceholdersToArray(item, ctx);
      if (item && typeof item === 'object') {
        return this.applyPlaceholdersToObject(item as Record<string, unknown>, ctx);
      }
      return item;
    });
  }

  private buildComponents(
    data: unknown[],
    ctx: PlaceholderContext,
  ): ActionRowBuilder<ButtonBuilder>[] | undefined {
    if (!Array.isArray(data)) return undefined;
    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    for (const row of data) {
      if (!row || typeof row !== 'object' || !Array.isArray((row as { components?: unknown[] }).components))
        continue;
      const actionRow = new ActionRowBuilder<ButtonBuilder>();
      for (const comp of (row as { components: unknown[] }).components) {
        const c = comp as {
          type?: number;
          customId?: string;
          label?: string;
          style?: number;
          emoji?: string | { id?: string; name?: string; animated?: boolean };
        };
        if (c?.type !== 2) continue;
        // В customId подставляем только id роли (без <#…>/<@&…> синтаксиса)
        let customId = (c.customId ?? '').toString();
        for (const [name, id] of ctx.roleMap) {
          customId = customId.replace(new RegExp(`\\{\\{${escapeRegex(name)}\\}\\}`, 'g'), id);
        }
        const label = typeof c.label === 'string' ? this.replacePlaceholders(c.label, ctx) : 'Role';
        const btn = new ButtonBuilder()
          .setCustomId(customId)
          .setLabel(label)
          .setStyle((c.style as ButtonStyle) ?? ButtonStyle.Primary);
        if (c.emoji !== undefined && c.emoji !== null) {
          if (typeof c.emoji === 'string') {
            btn.setEmoji(c.emoji);
          } else if (typeof c.emoji === 'object') {
            const e = c.emoji;
            if (e.id) btn.setEmoji({ id: e.id, name: e.name ?? '', animated: Boolean(e.animated) });
            else if (e.name) btn.setEmoji(e.name);
          }
        }
        actionRow.addComponents(btn);
      }
      if (actionRow.components.length) rows.push(actionRow);
    }
    return rows.length ? rows : undefined;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Принимает объект или строку JSON (частая ошибка фронта: двойная сериализация). */
function coerceEmbedJsonField(v: unknown): Record<string, unknown> | undefined {
  if (v == null) return undefined;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return undefined;
    try {
      const parsed = JSON.parse(s) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      throw new Error('embedJson: invalid JSON string');
    }
    throw new Error('embedJson must be an object after parse');
  }
  if (typeof v === 'object' && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return undefined;
}

function coerceComponentsJsonField(v: unknown): unknown[] | undefined {
  if (v == null) return undefined;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return undefined;
    try {
      const parsed = JSON.parse(s) as unknown;
      return Array.isArray(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return Array.isArray(v) ? v : undefined;
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

/** Контекст для подстановки плейсхолдеров в тексте сообщений / кнопок при установке */
interface PlaceholderContext {
  roleMap: Map<string, string>;
  channelMap: Map<string, string>;
}

export type TemplateInstallSummary = {
  rolesCreated: number;
  categoriesCreated: number;
  channelsCreated: number;
  messagesSent: number;
  reactionRolesBound: number;
  logChannelsSet: number;
  emojisCreated: number;
  stickersCreated: number;
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
