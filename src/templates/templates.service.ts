import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MessageTemplate } from './entities/message-template.entity';

export interface CreateTemplateDto {
  name: string;
  title?: string | null;
  description?: string | null;
  image?: string | null;
}

export interface UpdateTemplateDto {
  name?: string;
  title?: string | null;
  description?: string | null;
  image?: string | null;
}

@Injectable()
export class TemplatesService {
  constructor(
    @InjectRepository(MessageTemplate)
    private readonly repo: Repository<MessageTemplate>,
  ) {}

  async create(guildId: string, dto: CreateTemplateDto): Promise<MessageTemplate> {
    const template = this.repo.create({
      guildId,
      name: dto.name.trim(),
      title: dto.title?.trim() ?? null,
      description: dto.description?.trim() ?? null,
      image: dto.image?.trim() ?? null,
    });
    return this.repo.save(template);
  }

  async findAllByGuild(guildId: string): Promise<MessageTemplate[]> {
    return this.repo.find({
      where: { guildId },
      order: { updatedAt: 'DESC' },
    });
  }

  async findOne(guildId: string, id: string): Promise<MessageTemplate> {
    const template = await this.repo.findOne({
      where: { id, guildId },
    });
    if (!template) throw new NotFoundException('Template not found');
    return template;
  }

  async update(
    guildId: string,
    id: string,
    dto: UpdateTemplateDto,
  ): Promise<MessageTemplate> {
    const template = await this.findOne(guildId, id);
    if (dto.name !== undefined) template.name = dto.name.trim();
    if (dto.title !== undefined) template.title = dto.title?.trim() ?? null;
    if (dto.description !== undefined)
      template.description = dto.description?.trim() ?? null;
    if (dto.image !== undefined) template.image = dto.image?.trim() ?? null;
    return this.repo.save(template);
  }

  async remove(guildId: string, id: string): Promise<void> {
    const template = await this.findOne(guildId, id);
    await this.repo.remove(template);
  }
}
