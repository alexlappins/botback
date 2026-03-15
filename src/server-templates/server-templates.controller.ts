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
import { TemplateRole } from './entities/template-role.entity';
import { NoCacheInterceptor } from './no-cache.interceptor';

const LOG_TYPES: (keyof LogChannelsConfig)[] = ['joinLeave', 'messages', 'moderation', 'channel', 'banKick'];

@Controller('api/server-templates')
@UseGuards(SessionGuard)
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
      select: ['id', 'name', 'description', 'createdAt'],
    });
  }

  @Post()
  async create(@Body() body: { name: string; description?: string | null }) {
    const name = body?.name?.trim();
    if (!name) throw new BadRequestException('name required');
    const template = this.templateRepo.create({ name, description: body.description?.trim() || null });
    await this.templateRepo.save(template);
    return { id: template.id, name: template.name, description: template.description, createdAt: template.createdAt };
  }

  @Get(':id')
  async getOne(@Param('id') id: string) {
    const template = await this.templateRepo
      .createQueryBuilder('t')
      .where('t.id = :id', { id })
      .leftJoinAndSelect('t.roles', 'roles')
      .leftJoinAndSelect('t.categories', 'categories')
      .leftJoinAndSelect('t.channels', 'channels')
      .leftJoinAndSelect('t.messages', 'messages')
      .leftJoinAndSelect('t.reactionRoles', 'reactionRoles')
      .leftJoinAndSelect('t.logChannels', 'logChannels')
      .getOne();
    if (!template) throw new NotFoundException('Template not found');
    return template;
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: { name?: string; description?: string | null }) {
    await this.ensureTemplate(id);
    if (body.name !== undefined) {
      const name = body.name?.trim();
      if (!name) throw new BadRequestException('name cannot be empty');
      await this.templateRepo.update(id, { name });
    }
    if (body.description !== undefined) await this.templateRepo.update(id, { description: body.description?.trim() || null });
    return this.templateRepo.findOne({ where: { id }, select: ['id', 'name', 'description', 'createdAt', 'updatedAt'] });
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
    body: { channelName: string; messageOrder?: number; content?: string | null; embedJson?: Record<string, unknown> | null; componentsJson?: unknown[] | null },
  ) {
    await this.ensureTemplate(id);
    const channelName = body?.channelName?.trim();
    if (!channelName) throw new BadRequestException('channelName required');
    const msg = this.messageRepo.create({
      templateId: id,
      channelName,
      messageOrder: body.messageOrder ?? 0,
      content: body.content?.trim() || null,
      embedJson: body.embedJson ?? null,
      componentsJson: body.componentsJson ?? null,
    });
    await this.messageRepo.save(msg);
    return msg;
  }

  @Patch(':id/messages/:messageId')
  async updateMessage(
    @Param('id') id: string,
    @Param('messageId') messageId: string,
    @Body()
    body: { channelName?: string; messageOrder?: number; content?: string | null; embedJson?: Record<string, unknown> | null; componentsJson?: unknown[] | null },
  ) {
    await this.ensureTemplate(id);
    const msg = await this.messageRepo.findOne({ where: { id: messageId, templateId: id } });
    if (!msg) throw new NotFoundException('Message not found');
    if (body.channelName !== undefined) msg.channelName = body.channelName.trim();
    if (body.messageOrder !== undefined) msg.messageOrder = body.messageOrder;
    if (body.content !== undefined) msg.content = body.content?.trim() || null;
    if (body.embedJson !== undefined) msg.embedJson = body.embedJson;
    if (body.componentsJson !== undefined) msg.componentsJson = body.componentsJson;
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
}
