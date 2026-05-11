import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard';
import { SessionGuard } from '../auth/session.guard';
import type { LogChannelsConfig } from '../common/storage/guild-storage.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ServerTemplate } from './entities/server-template.entity';
import { TemplateCategory } from './entities/template-category.entity';
import { TemplateChannel } from './entities/template-channel.entity';
import type { TemplatePermissionOverwrite } from './entities/template-channel.entity';
import { TemplateLogChannel } from './entities/template-log-channel.entity';
import { TemplateMessage } from './entities/template-message.entity';
import { TemplateReactionRole } from './entities/template-reaction-role.entity';
import { TemplateCategoryGrant } from './entities/template-category-grant.entity';
import { TemplateEmoji } from './entities/template-emoji.entity';
import { TemplateRole } from './entities/template-role.entity';
import { TemplateSticker } from './entities/template-sticker.entity';
import { TemplateWelcomeVariant } from './entities/template-welcome-variant.entity';
import { TemplateGoodbyeVariant } from './entities/template-goodbye-variant.entity';
import type { WelcomeVariantRole } from '../welcome/entities/welcome-template.entity';
import { NoCacheInterceptor } from './no-cache.interceptor';

const LOG_TYPES: (keyof LogChannelsConfig)[] = ['joinLeave', 'messages', 'moderation', 'channel', 'banKick'];

@Controller('api/server-templates')
@UseGuards(SessionGuard, AdminGuard)
@UseInterceptors(NoCacheInterceptor)
export class ServerTemplatesController {
  constructor(
    @InjectRepository(ServerTemplate) private readonly templateRepo: Repository<ServerTemplate>,
    @InjectRepository(TemplateRole) private readonly roleRepo: Repository<TemplateRole>,
    @InjectRepository(TemplateCategory) private readonly categoryRepo: Repository<TemplateCategory>,
    @InjectRepository(TemplateChannel) private readonly channelRepo: Repository<TemplateChannel>,
    @InjectRepository(TemplateMessage) private readonly messageRepo: Repository<TemplateMessage>,
    @InjectRepository(TemplateReactionRole) private readonly reactionRoleRepo: Repository<TemplateReactionRole>,
    @InjectRepository(TemplateLogChannel) private readonly logChannelRepo: Repository<TemplateLogChannel>,
    @InjectRepository(TemplateEmoji) private readonly emojiRepo: Repository<TemplateEmoji>,
    @InjectRepository(TemplateSticker) private readonly stickerRepo: Repository<TemplateSticker>,
    @InjectRepository(TemplateCategoryGrant) private readonly categoryGrantRepo: Repository<TemplateCategoryGrant>,
    @InjectRepository(TemplateWelcomeVariant) private readonly welcomeVariantRepo: Repository<TemplateWelcomeVariant>,
    @InjectRepository(TemplateGoodbyeVariant) private readonly goodbyeVariantRepo: Repository<TemplateGoodbyeVariant>,
  ) {}

  private async ensureTemplate(id: string): Promise<ServerTemplate> {
    const t = await this.templateRepo.findOne({ where: { id } });
    if (!t) throw new NotFoundException('Template not found');
    return t;
  }

  @Get()
  async list() {
    return this.templateRepo.find({
      order: { createdAt: 'DESC' },
      select: ['id', 'name', 'description', 'discordTemplateUrl', 'iconUrl', 'enableServerStats', 'createdAt'],
    });
  }

  @Post()
  async create(
    @Body() body: { name: string; description?: string | null; discordTemplateUrl?: string | null; iconUrl?: string | null },
  ) {
    const name = body?.name?.trim();
    if (!name) throw new BadRequestException('name required');
    const template = this.templateRepo.create({
      name,
      description: body.description?.trim() || null,
      discordTemplateUrl: body.discordTemplateUrl?.trim() || null,
      iconUrl: body.iconUrl?.trim() || null,
    });
    await this.templateRepo.save(template);
    return {
      id: template.id,
      name: template.name,
      description: template.description,
      discordTemplateUrl: template.discordTemplateUrl,
      iconUrl: template.iconUrl,
      createdAt: template.createdAt,
    };
  }

  @Get(':id')
  async getOne(@Param('id') id: string) {
    // ВАЖНО: 9 leftJoinAndSelect подряд = cartesian-взрыв в одном SQL и OOM при росте шаблона.
    // Используем findOne с relations + relationLoadStrategy: 'query' — каждая relation
    // отдельным SELECT'ом, без декартова произведения.
    const template = await this.templateRepo.findOne({
      where: { id },
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
        welcomeVariants: true,
        goodbyeVariants: true,
      },
      relationLoadStrategy: 'query',
    });
    if (!template) throw new NotFoundException('Template not found');
    template.welcomeVariants?.sort((a, b) => a.orderIndex - b.orderIndex);
    template.goodbyeVariants?.sort((a, b) => a.orderIndex - b.orderIndex);
    return template;
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() body: {
      name?: string;
      description?: string | null;
      discordTemplateUrl?: string | null;
      iconUrl?: string | null;
      enableServerStats?: boolean;
      statsCategoryName?: string | null;
      statsTotalName?: string | null;
      statsHumansName?: string | null;
      statsBotsName?: string | null;
      statsOnlineName?: string | null;
      verifiedHideCategoryName?: string | null;
      verifiedHideRoleName?: string | null;
      welcomeEnabled?: boolean;
      welcomeSendMode?: 'channel' | 'dm';
      welcomeChannelName?: string | null;
      welcomeReturningEnabled?: boolean;
      goodbyeEnabled?: boolean;
      goodbyeChannelName?: string | null;
    },
  ) {
    await this.ensureTemplate(id);
    if (body.name !== undefined) {
      const name = body.name?.trim();
      if (!name) throw new BadRequestException('name cannot be empty');
      await this.templateRepo.update(id, { name });
    }
    if (body.description !== undefined) {
      await this.templateRepo.update(id, { description: body.description?.trim() || null });
    }
    if (body.discordTemplateUrl !== undefined) {
      await this.templateRepo.update(id, { discordTemplateUrl: body.discordTemplateUrl?.trim() || null });
    }
    if (body.iconUrl !== undefined) {
      await this.templateRepo.update(id, { iconUrl: body.iconUrl?.trim() || null });
    }
    if (body.enableServerStats !== undefined) {
      await this.templateRepo.update(id, { enableServerStats: Boolean(body.enableServerStats) });
    }
    const statsFields: Record<string, string | null> = {};
    if (body.statsCategoryName !== undefined) statsFields.statsCategoryName = body.statsCategoryName?.trim() || null;
    if (body.statsTotalName !== undefined) statsFields.statsTotalName = body.statsTotalName?.trim() || null;
    if (body.statsHumansName !== undefined) statsFields.statsHumansName = body.statsHumansName?.trim() || null;
    if (body.statsBotsName !== undefined) statsFields.statsBotsName = body.statsBotsName?.trim() || null;
    if (body.statsOnlineName !== undefined) statsFields.statsOnlineName = body.statsOnlineName?.trim() || null;
    if (Object.keys(statsFields).length) await this.templateRepo.update(id, statsFields);

    const verifyFields: Record<string, string | null> = {};
    if (body.verifiedHideCategoryName !== undefined) {
      verifyFields.verifiedHideCategoryName = body.verifiedHideCategoryName?.trim() || null;
    }
    if (body.verifiedHideRoleName !== undefined) {
      verifyFields.verifiedHideRoleName = body.verifiedHideRoleName?.trim() || null;
    }
    if (Object.keys(verifyFields).length) await this.templateRepo.update(id, verifyFields);

    const wgFields: Record<string, unknown> = {};
    if (body.welcomeEnabled !== undefined) wgFields.welcomeEnabled = !!body.welcomeEnabled;
    if (body.welcomeSendMode !== undefined) {
      wgFields.welcomeSendMode = body.welcomeSendMode === 'dm' ? 'dm' : 'channel';
    }
    if (body.welcomeChannelName !== undefined) {
      wgFields.welcomeChannelName = body.welcomeChannelName?.trim() || null;
    }
    if (body.welcomeReturningEnabled !== undefined) {
      wgFields.welcomeReturningEnabled = !!body.welcomeReturningEnabled;
    }
    if (body.goodbyeEnabled !== undefined) wgFields.goodbyeEnabled = !!body.goodbyeEnabled;
    if (body.goodbyeChannelName !== undefined) {
      wgFields.goodbyeChannelName = body.goodbyeChannelName?.trim() || null;
    }
    if (Object.keys(wgFields).length) await this.templateRepo.update(id, wgFields);

    return this.templateRepo.findOne({
      where: { id },
      select: [
        'id', 'name', 'description', 'discordTemplateUrl', 'iconUrl', 'enableServerStats',
        'statsCategoryName', 'statsTotalName', 'statsHumansName', 'statsBotsName', 'statsOnlineName',
        'verifiedHideCategoryName', 'verifiedHideRoleName',
        'welcomeEnabled', 'welcomeSendMode', 'welcomeChannelName', 'welcomeReturningEnabled',
        'goodbyeEnabled', 'goodbyeChannelName',
        'createdAt', 'updatedAt',
      ],
    });
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    await this.ensureTemplate(id);
    await this.templateRepo.delete(id);
    return { ok: true };
  }

  // ——— Roles ———
  @Get(':id/roles')
  async getRoles(@Param('id') id: string) {
    await this.ensureTemplate(id);
    return this.roleRepo.find({ where: { templateId: id }, order: { position: 'ASC' } });
  }

  @Post(':id/roles')
  async addRole(
    @Param('id') id: string,
    @Body()
    body: { name: string; color?: number; permissions?: string; position?: number; hoist?: boolean; mentionable?: boolean },
  ) {
    await this.ensureTemplate(id);
    const name = body?.name?.trim();
    if (!name) throw new BadRequestException('name required');
    const role = this.roleRepo.create({
      templateId: id,
      name,
      color: body.color ?? 0,
      permissions: body.permissions ?? '0',
      position: body.position ?? 0,
      hoist: body.hoist ?? false,
      mentionable: body.mentionable ?? false,
    });
    await this.roleRepo.save(role);
    return role;
  }

  @Patch(':id/roles/:roleId')
  async updateRole(
    @Param('id') id: string,
    @Param('roleId') roleId: string,
    @Body()
    body: { name?: string; color?: number; permissions?: string; position?: number; hoist?: boolean; mentionable?: boolean },
  ) {
    await this.ensureTemplate(id);
    const role = await this.roleRepo.findOne({ where: { id: roleId, templateId: id } });
    if (!role) throw new NotFoundException('Role not found');
    if (body.name !== undefined) role.name = body.name.trim();
    if (body.color !== undefined) role.color = body.color;
    if (body.permissions !== undefined) role.permissions = body.permissions;
    if (body.position !== undefined) role.position = body.position;
    if (body.hoist !== undefined) role.hoist = body.hoist;
    if (body.mentionable !== undefined) role.mentionable = body.mentionable;
    await this.roleRepo.save(role);
    return role;
  }

  @Delete(':id/roles/:roleId')
  async removeRole(@Param('id') id: string, @Param('roleId') roleId: string) {
    await this.ensureTemplate(id);
    const result = await this.roleRepo.delete({ id: roleId, templateId: id });
    if (result.affected === 0) throw new NotFoundException('Role not found');
    return { ok: true };
  }

  // ——— Categories ———
  @Get(':id/categories')
  async getCategories(@Param('id') id: string) {
    await this.ensureTemplate(id);
    return this.categoryRepo.find({ where: { templateId: id }, order: { position: 'ASC' } });
  }

  @Post(':id/categories')
  async addCategory(@Param('id') id: string, @Body() body: { name: string; position?: number }) {
    await this.ensureTemplate(id);
    const name = body?.name?.trim();
    if (!name) throw new BadRequestException('name required');
    const cat = this.categoryRepo.create({ templateId: id, name, position: body.position ?? 0 });
    await this.categoryRepo.save(cat);
    return cat;
  }

  @Patch(':id/categories/:categoryId')
  async updateCategory(@Param('id') id: string, @Param('categoryId') categoryId: string, @Body() body: { name?: string; position?: number }) {
    await this.ensureTemplate(id);
    const cat = await this.categoryRepo.findOne({ where: { id: categoryId, templateId: id } });
    if (!cat) throw new NotFoundException('Category not found');
    if (body.name !== undefined) cat.name = body.name.trim();
    if (body.position !== undefined) cat.position = body.position;
    await this.categoryRepo.save(cat);
    return cat;
  }

  @Delete(':id/categories/:categoryId')
  async removeCategory(@Param('id') id: string, @Param('categoryId') categoryId: string) {
    await this.ensureTemplate(id);
    const result = await this.categoryRepo.delete({ id: categoryId, templateId: id });
    if (result.affected === 0) throw new NotFoundException('Category not found');
    return { ok: true };
  }

  // ——— Channels ———
  @Get(':id/channels')
  async getChannels(@Param('id') id: string) {
    await this.ensureTemplate(id);
    return this.channelRepo.find({ where: { templateId: id }, order: { position: 'ASC' } });
  }

  @Post(':id/channels')
  async addChannel(
    @Param('id') id: string,
    @Body()
    body: {
      name: string;
      categoryName?: string | null;
      type?: number;
      topic?: string | null;
      position?: number;
      permissionOverwrites?: TemplatePermissionOverwrite[] | null;
    },
  ) {
    await this.ensureTemplate(id);
    const name = body?.name?.trim();
    if (!name) throw new BadRequestException('name required');
    const ch = this.channelRepo.create({
      templateId: id,
      name,
      categoryName: body.categoryName?.trim() || null,
      type: body.type ?? 0,
      topic: body.topic?.trim() || null,
      position: body.position ?? 0,
      permissionOverwrites: body.permissionOverwrites ?? null,
    });
    await this.channelRepo.save(ch);
    return ch;
  }

  @Patch(':id/channels/:channelId')
  async updateChannel(
    @Param('id') id: string,
    @Param('channelId') channelId: string,
    @Body()
    body: {
      name?: string;
      categoryName?: string | null;
      type?: number;
      topic?: string | null;
      position?: number;
      permissionOverwrites?: TemplatePermissionOverwrite[] | null;
    },
  ) {
    await this.ensureTemplate(id);
    const ch = await this.channelRepo.findOne({ where: { id: channelId, templateId: id } });
    if (!ch) throw new NotFoundException('Channel not found');
    if (body.name !== undefined) ch.name = body.name.trim();
    if (body.categoryName !== undefined) ch.categoryName = body.categoryName?.trim() || null;
    if (body.type !== undefined) ch.type = body.type;
    if (body.topic !== undefined) ch.topic = body.topic?.trim() || null;
    if (body.position !== undefined) ch.position = body.position;
    if (body.permissionOverwrites !== undefined) ch.permissionOverwrites = body.permissionOverwrites;
    await this.channelRepo.save(ch);
    return ch;
  }

  @Delete(':id/channels/:channelId')
  async removeChannel(@Param('id') id: string, @Param('channelId') channelId: string) {
    await this.ensureTemplate(id);
    const result = await this.channelRepo.delete({ id: channelId, templateId: id });
    if (result.affected === 0) throw new NotFoundException('Channel not found');
    return { ok: true };
  }

  // ——— Messages ———
  @Get(':id/messages')
  async getMessages(@Param('id') id: string) {
    await this.ensureTemplate(id);
    return this.messageRepo.find({ where: { templateId: id }, order: { channelName: 'ASC', messageOrder: 'ASC' } });
  }

  @Post(':id/messages')
  async addMessage(
    @Param('id') id: string,
    @Body()
    body: { channelName: string; messageOrder?: number; content?: string | null; embedJson?: Record<string, unknown> | string | null; componentsJson?: unknown[] | string | null },
  ) {
    await this.ensureTemplate(id);
    const channelName = body?.channelName?.trim();
    if (!channelName) throw new BadRequestException('channelName required');
    const msg = this.messageRepo.create({
      templateId: id,
      channelName,
      messageOrder: body.messageOrder ?? 0,
      content: body.content?.trim() || null,
      embedJson: parseJsonbObject(body.embedJson),
      componentsJson: parseJsonbArray(body.componentsJson),
    });
    await this.messageRepo.save(msg);
    return msg;
  }

  @Patch(':id/messages/:messageId')
  async updateMessage(
    @Param('id') id: string,
    @Param('messageId') messageId: string,
    @Body()
    body: { channelName?: string; messageOrder?: number; content?: string | null; embedJson?: Record<string, unknown> | string | null; componentsJson?: unknown[] | string | null },
  ) {
    await this.ensureTemplate(id);
    const msg = await this.messageRepo.findOne({ where: { id: messageId, templateId: id } });
    if (!msg) throw new NotFoundException('Message not found');
    if (body.channelName !== undefined) msg.channelName = body.channelName.trim();
    if (body.messageOrder !== undefined) msg.messageOrder = body.messageOrder;
    if (body.content !== undefined) msg.content = body.content?.trim() || null;
    if (body.embedJson !== undefined) msg.embedJson = parseJsonbObject(body.embedJson);
    if (body.componentsJson !== undefined) msg.componentsJson = parseJsonbArray(body.componentsJson);
    await this.messageRepo.save(msg);
    return msg;
  }

  @Delete(':id/messages/:messageId')
  async removeMessage(@Param('id') id: string, @Param('messageId') messageId: string) {
    await this.ensureTemplate(id);
    const result = await this.messageRepo.delete({ id: messageId, templateId: id });
    if (result.affected === 0) throw new NotFoundException('Message not found');
    return { ok: true };
  }

  // ——— Reaction roles ———
  @Get(':id/reaction-roles')
  async getReactionRoles(@Param('id') id: string) {
    await this.ensureTemplate(id);
    return this.reactionRoleRepo.find({ where: { templateId: id } });
  }

  @Post(':id/reaction-roles')
  async addReactionRole(
    @Param('id') id: string,
    @Body() body: { channelName: string; messageOrder?: number; emojiKey: string; roleName: string },
  ) {
    await this.ensureTemplate(id);
    const channelName = body?.channelName?.trim();
    const emojiKey = body?.emojiKey?.trim();
    const roleName = body?.roleName?.trim();
    if (!channelName || !emojiKey || !roleName) throw new BadRequestException('channelName, emojiKey, roleName required');
    const rr = this.reactionRoleRepo.create({
      templateId: id,
      channelName,
      messageOrder: body.messageOrder ?? 0,
      emojiKey,
      roleName,
    });
    await this.reactionRoleRepo.save(rr);
    return rr;
  }

  @Patch(':id/reaction-roles/:rrId')
  async updateReactionRole(
    @Param('id') id: string,
    @Param('rrId') rrId: string,
    @Body() body: { channelName?: string; messageOrder?: number; emojiKey?: string; roleName?: string },
  ) {
    await this.ensureTemplate(id);
    const rr = await this.reactionRoleRepo.findOne({ where: { id: rrId, templateId: id } });
    if (!rr) throw new NotFoundException('Reaction role not found');
    if (body.channelName !== undefined) rr.channelName = body.channelName.trim();
    if (body.messageOrder !== undefined) rr.messageOrder = body.messageOrder;
    if (body.emojiKey !== undefined) rr.emojiKey = body.emojiKey.trim();
    if (body.roleName !== undefined) rr.roleName = body.roleName.trim();
    await this.reactionRoleRepo.save(rr);
    return rr;
  }

  @Delete(':id/reaction-roles/:rrId')
  async removeReactionRole(@Param('id') id: string, @Param('rrId') rrId: string) {
    await this.ensureTemplate(id);
    const result = await this.reactionRoleRepo.delete({ id: rrId, templateId: id });
    if (result.affected === 0) throw new NotFoundException('Reaction role not found');
    return { ok: true };
  }

  // ——— Log channels ———
  @Get(':id/log-channels')
  async getLogChannels(@Param('id') id: string) {
    await this.ensureTemplate(id);
    return this.logChannelRepo.find({ where: { templateId: id } });
  }

  @Post(':id/log-channels')
  async addLogChannel(@Param('id') id: string, @Body() body: { logType: keyof LogChannelsConfig; channelName: string }) {
    await this.ensureTemplate(id);
    const logType = body?.logType;
    const channelName = body?.channelName?.trim();
    if (!logType || !LOG_TYPES.includes(logType)) throw new BadRequestException('logType must be one of: ' + LOG_TYPES.join(', '));
    if (!channelName) throw new BadRequestException('channelName required');
    const lc = this.logChannelRepo.create({ templateId: id, logType, channelName });
    await this.logChannelRepo.save(lc);
    return lc;
  }

  @Patch(':id/log-channels/:lcId')
  async updateLogChannel(
    @Param('id') id: string,
    @Param('lcId') lcId: string,
    @Body() body: { logType?: keyof LogChannelsConfig; channelName?: string },
  ) {
    await this.ensureTemplate(id);
    const lc = await this.logChannelRepo.findOne({ where: { id: lcId, templateId: id } });
    if (!lc) throw new NotFoundException('Log channel not found');
    if (body.logType !== undefined) {
      if (!LOG_TYPES.includes(body.logType)) throw new BadRequestException('logType must be one of: ' + LOG_TYPES.join(', '));
      lc.logType = body.logType;
    }
    if (body.channelName !== undefined) lc.channelName = body.channelName.trim();
    await this.logChannelRepo.save(lc);
    return lc;
  }

  @Delete(':id/log-channels/:lcId')
  async removeLogChannel(@Param('id') id: string, @Param('lcId') lcId: string) {
    await this.ensureTemplate(id);
    const result = await this.logChannelRepo.delete({ id: lcId, templateId: id });
    if (result.affected === 0) throw new NotFoundException('Log channel not found');
    return { ok: true };
  }

  // ——— Emojis ———
  @Get(':id/emojis')
  async getEmojis(@Param('id') id: string) {
    await this.ensureTemplate(id);
    return this.emojiRepo.find({ where: { templateId: id } });
  }

  @Post(':id/emojis')
  async addEmoji(@Param('id') id: string, @Body() body: { name: string; imageUrl: string }) {
    await this.ensureTemplate(id);
    const name = body?.name?.trim();
    const imageUrl = body?.imageUrl?.trim();
    if (!name) throw new BadRequestException('name required');
    if (!imageUrl) throw new BadRequestException('imageUrl required');
    const emoji = this.emojiRepo.create({ templateId: id, name, imageUrl });
    await this.emojiRepo.save(emoji);
    return emoji;
  }

  @Patch(':id/emojis/:emojiId')
  async updateEmoji(
    @Param('id') id: string,
    @Param('emojiId') emojiId: string,
    @Body() body: { name?: string; imageUrl?: string },
  ) {
    await this.ensureTemplate(id);
    const emoji = await this.emojiRepo.findOne({ where: { id: emojiId, templateId: id } });
    if (!emoji) throw new NotFoundException('Emoji not found');
    if (body.name !== undefined) emoji.name = body.name.trim();
    if (body.imageUrl !== undefined) emoji.imageUrl = body.imageUrl.trim();
    await this.emojiRepo.save(emoji);
    return emoji;
  }

  @Delete(':id/emojis/:emojiId')
  async removeEmoji(@Param('id') id: string, @Param('emojiId') emojiId: string) {
    await this.ensureTemplate(id);
    const result = await this.emojiRepo.delete({ id: emojiId, templateId: id });
    if (result.affected === 0) throw new NotFoundException('Emoji not found');
    return { ok: true };
  }

  // ——— Stickers ———
  @Get(':id/stickers')
  async getStickers(@Param('id') id: string) {
    await this.ensureTemplate(id);
    return this.stickerRepo.find({ where: { templateId: id } });
  }

  @Post(':id/stickers')
  async addSticker(
    @Param('id') id: string,
    @Body() body: { name: string; tags: string; imageUrl: string; description?: string | null },
  ) {
    await this.ensureTemplate(id);
    const name = body?.name?.trim();
    const tags = body?.tags?.trim();
    const imageUrl = body?.imageUrl?.trim();
    if (!name) throw new BadRequestException('name required');
    if (!tags) throw new BadRequestException('tags required');
    if (!imageUrl) throw new BadRequestException('imageUrl required');
    const sticker = this.stickerRepo.create({
      templateId: id,
      name,
      tags,
      imageUrl,
      description: body.description?.trim() || null,
    });
    await this.stickerRepo.save(sticker);
    return sticker;
  }

  @Patch(':id/stickers/:stickerId')
  async updateSticker(
    @Param('id') id: string,
    @Param('stickerId') stickerId: string,
    @Body() body: { name?: string; tags?: string; imageUrl?: string; description?: string | null },
  ) {
    await this.ensureTemplate(id);
    const sticker = await this.stickerRepo.findOne({ where: { id: stickerId, templateId: id } });
    if (!sticker) throw new NotFoundException('Sticker not found');
    if (body.name !== undefined) sticker.name = body.name.trim();
    if (body.tags !== undefined) sticker.tags = body.tags.trim();
    if (body.imageUrl !== undefined) sticker.imageUrl = body.imageUrl.trim();
    if (body.description !== undefined) sticker.description = body.description?.trim() || null;
    await this.stickerRepo.save(sticker);
    return sticker;
  }

  @Delete(':id/stickers/:stickerId')
  async removeSticker(@Param('id') id: string, @Param('stickerId') stickerId: string) {
    await this.ensureTemplate(id);
    const result = await this.stickerRepo.delete({ id: stickerId, templateId: id });
    if (result.affected === 0) throw new NotFoundException('Sticker not found');
    return { ok: true };
  }

  // ——— Category grants (привязка категорий к роли верификации) ———
  @Get(':id/category-grants')
  async getCategoryGrants(@Param('id') id: string) {
    await this.ensureTemplate(id);
    return this.categoryGrantRepo.find({ where: { templateId: id }, order: { categoryName: 'ASC' } });
  }

  @Post(':id/category-grants')
  async addCategoryGrant(@Param('id') id: string, @Body() body: { categoryName: string }) {
    await this.ensureTemplate(id);
    const categoryName = body?.categoryName?.trim();
    if (!categoryName) throw new BadRequestException('categoryName required');
    const exists = await this.categoryGrantRepo.findOne({ where: { templateId: id, categoryName } });
    if (exists) return exists;
    const grant = this.categoryGrantRepo.create({ templateId: id, categoryName });
    await this.categoryGrantRepo.save(grant);
    return grant;
  }

  @Delete(':id/category-grants/:grantId')
  async removeCategoryGrant(@Param('id') id: string, @Param('grantId') grantId: string) {
    await this.ensureTemplate(id);
    const result = await this.categoryGrantRepo.delete({ id: grantId, templateId: id });
    if (result.affected === 0) throw new NotFoundException('Grant not found');
    return { ok: true };
  }

  // ── Welcome variants ──────────────────────────────────

  @Get(':id/welcome-variants')
  async listWelcomeVariants(@Param('id') id: string) {
    await this.ensureTemplate(id);
    const rows = await this.welcomeVariantRepo.find({ where: { templateId: id } });
    return rows.sort((a, b) => a.orderIndex - b.orderIndex);
  }

  @Post(':id/welcome-variants')
  async addWelcomeVariant(
    @Param('id') id: string,
    @Body() body: TemplateVariantBody & { role?: WelcomeVariantRole; buttonsConfig?: { label: string; url: string; emoji?: string | null }[] | null },
  ) {
    await this.ensureTemplate(id);
    const text = (body?.text ?? '').toString();
    if (!text.trim()) throw new BadRequestException('text required');
    const v = this.welcomeVariantRepo.create({
      templateId: id,
      role: body.role === 'returning_member' ? 'returning_member' : 'new_member',
      text,
      orderIndex: typeof body.orderIndex === 'number' ? body.orderIndex : 0,
      ...mergeImageFields(body),
      buttonsConfig: body.buttonsConfig ?? null,
    });
    await this.welcomeVariantRepo.save(v);
    return v;
  }

  @Patch(':id/welcome-variants/:vId')
  async updateWelcomeVariant(
    @Param('id') id: string,
    @Param('vId') vId: string,
    @Body() body: Partial<TemplateVariantBody> & { role?: WelcomeVariantRole; buttonsConfig?: { label: string; url: string; emoji?: string | null }[] | null },
  ) {
    await this.ensureTemplate(id);
    const v = await this.welcomeVariantRepo.findOne({ where: { id: vId, templateId: id } });
    if (!v) throw new NotFoundException('Variant not found');
    if (body.text !== undefined) v.text = body.text.toString();
    if (body.orderIndex !== undefined) v.orderIndex = body.orderIndex;
    if (body.role !== undefined) {
      v.role = body.role === 'returning_member' ? 'returning_member' : 'new_member';
    }
    if (body.buttonsConfig !== undefined) v.buttonsConfig = body.buttonsConfig ?? null;
    Object.assign(v, mergeImageFields(body));
    await this.welcomeVariantRepo.save(v);
    return v;
  }

  @Delete(':id/welcome-variants/:vId')
  async removeWelcomeVariant(@Param('id') id: string, @Param('vId') vId: string) {
    await this.ensureTemplate(id);
    const result = await this.welcomeVariantRepo.delete({ id: vId, templateId: id });
    if (result.affected === 0) throw new NotFoundException('Variant not found');
    return { ok: true };
  }

  // ── Goodbye variants ──────────────────────────────────

  @Get(':id/goodbye-variants')
  async listGoodbyeVariants(@Param('id') id: string) {
    await this.ensureTemplate(id);
    const rows = await this.goodbyeVariantRepo.find({ where: { templateId: id } });
    return rows.sort((a, b) => a.orderIndex - b.orderIndex);
  }

  @Post(':id/goodbye-variants')
  async addGoodbyeVariant(@Param('id') id: string, @Body() body: TemplateVariantBody) {
    await this.ensureTemplate(id);
    const text = (body?.text ?? '').toString();
    if (!text.trim()) throw new BadRequestException('text required');
    const v = this.goodbyeVariantRepo.create({
      templateId: id,
      text,
      orderIndex: typeof body.orderIndex === 'number' ? body.orderIndex : 0,
      ...mergeImageFields(body),
    });
    await this.goodbyeVariantRepo.save(v);
    return v;
  }

  @Patch(':id/goodbye-variants/:vId')
  async updateGoodbyeVariant(
    @Param('id') id: string,
    @Param('vId') vId: string,
    @Body() body: Partial<TemplateVariantBody>,
  ) {
    await this.ensureTemplate(id);
    const v = await this.goodbyeVariantRepo.findOne({ where: { id: vId, templateId: id } });
    if (!v) throw new NotFoundException('Variant not found');
    if (body.text !== undefined) v.text = body.text.toString();
    if (body.orderIndex !== undefined) v.orderIndex = body.orderIndex;
    Object.assign(v, mergeImageFields(body));
    await this.goodbyeVariantRepo.save(v);
    return v;
  }

  @Delete(':id/goodbye-variants/:vId')
  async removeGoodbyeVariant(@Param('id') id: string, @Param('vId') vId: string) {
    await this.ensureTemplate(id);
    const result = await this.goodbyeVariantRepo.delete({ id: vId, templateId: id });
    if (result.affected === 0) throw new NotFoundException('Variant not found');
    return { ok: true };
  }
}

interface TemplateVariantBody {
  text: string;
  orderIndex?: number;
  imageEnabled?: boolean;
  imageSendMode?: 'with_text' | 'before_text' | 'image_only';
  backgroundImageUrl?: string | null;
  backgroundFill?: string | null;
  avatarConfig?: Record<string, unknown> | null;
  usernameConfig?: Record<string, unknown> | null;
  imageTextConfig?: Record<string, unknown> | null;
}

function mergeImageFields(body: Partial<TemplateVariantBody>): Partial<TemplateVariantBody> {
  const out: Record<string, unknown> = {};
  if (body.imageEnabled !== undefined) out.imageEnabled = !!body.imageEnabled;
  if (body.imageSendMode !== undefined) {
    out.imageSendMode =
      body.imageSendMode === 'before_text' || body.imageSendMode === 'image_only'
        ? body.imageSendMode
        : 'with_text';
  }
  if (body.backgroundImageUrl !== undefined) {
    out.backgroundImageUrl = body.backgroundImageUrl?.toString().trim() || null;
  }
  if (body.backgroundFill !== undefined) out.backgroundFill = body.backgroundFill ?? null;
  if (body.avatarConfig !== undefined) out.avatarConfig = body.avatarConfig ?? null;
  if (body.usernameConfig !== undefined) out.usernameConfig = body.usernameConfig ?? null;
  if (body.imageTextConfig !== undefined) out.imageTextConfig = body.imageTextConfig ?? null;
  return out as Partial<TemplateVariantBody>;
}

/**
 * Нормализация входящего JSONB поля: фронт может прислать объект или JSON-строку.
 * Возвращаем object, чтобы не сохранить строку в JSONB колонку.
 */
function parseJsonbObject(v: unknown): Record<string, unknown> | null {
  if (v == null) return null;
  if (typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    try {
      const parsed = JSON.parse(s) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      throw new BadRequestException('embedJson: invalid JSON');
    }
  }
  return null;
}

function parseJsonbArray(v: unknown): unknown[] | null {
  if (v == null) return null;
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    try {
      const parsed = JSON.parse(s) as unknown;
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      throw new BadRequestException('componentsJson: invalid JSON');
    }
  }
  return null;
}
