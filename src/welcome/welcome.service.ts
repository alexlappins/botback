import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { WelcomeConfig } from './entities/welcome-config.entity';
import { WelcomeTemplate } from './entities/welcome-template.entity';
import { GoodbyeConfig } from './entities/goodbye-config.entity';
import { GoodbyeTemplate } from './entities/goodbye-template.entity';
import { GuildMemberSeen } from './entities/guild-member-seen.entity';
import type {
  AvatarConfig,
  ImageTextBlock,
  UsernameConfig,
} from './image-config.types';

const MAX_TEMPLATES = 5;
const MAX_BUTTONS = 3;

export type ImageSendMode = 'with_text' | 'before_text' | 'image_only';

export interface ImageFormFields {
  imageEnabled?: boolean;
  imageSendMode?: ImageSendMode;
  backgroundImageUrl?: string | null;
  backgroundFill?: string | null;
  avatarConfig?: AvatarConfig | null;
  usernameConfig?: UsernameConfig | null;
  imageTextConfig?: ImageTextBlock | null;
}

export interface WelcomeFormDto extends ImageFormFields {
  enabled?: boolean;
  sendMode?: 'channel' | 'dm';
  channelId?: string | null;
  templates?: { id?: string; text: string; orderIndex?: number }[];
  buttonsConfig?: { label: string; url: string; emoji?: string | null }[] | null;
  returningMemberEnabled?: boolean;
  returningMemberText?: string | null;
}

export interface GoodbyeFormDto extends ImageFormFields {
  enabled?: boolean;
  channelId?: string | null;
  templates?: { id?: string; text: string; orderIndex?: number }[];
}

@Injectable()
export class WelcomeService {
  constructor(
    @InjectRepository(WelcomeConfig)
    private readonly welcomeRepo: Repository<WelcomeConfig>,
    @InjectRepository(WelcomeTemplate)
    private readonly welcomeTplRepo: Repository<WelcomeTemplate>,
    @InjectRepository(GoodbyeConfig)
    private readonly goodbyeRepo: Repository<GoodbyeConfig>,
    @InjectRepository(GoodbyeTemplate)
    private readonly goodbyeTplRepo: Repository<GoodbyeTemplate>,
    @InjectRepository(GuildMemberSeen)
    private readonly seenRepo: Repository<GuildMemberSeen>,
  ) {}

  // ── Welcome ─────────────────────────────────────────────

  async getWelcome(guildId: string): Promise<WelcomeConfig> {
    let cfg = await this.welcomeRepo.findOne({
      where: { guildId },
      relations: ['templates'],
      relationLoadStrategy: 'query',
    });
    if (!cfg) {
      cfg = this.welcomeRepo.create({
        guildId,
        enabled: false,
        sendMode: 'channel',
        templates: [],
      });
      cfg = await this.welcomeRepo.save(cfg);
      cfg.templates = [];
    }
    cfg.templates?.sort((a, b) => a.orderIndex - b.orderIndex);
    return cfg;
  }

  async updateWelcome(guildId: string, dto: WelcomeFormDto): Promise<WelcomeConfig> {
    const cfg = await this.getWelcome(guildId);

    if (dto.enabled !== undefined) cfg.enabled = !!dto.enabled;
    if (dto.sendMode !== undefined) {
      cfg.sendMode = dto.sendMode === 'dm' ? 'dm' : 'channel';
    }
    if (dto.channelId !== undefined) cfg.channelId = dto.channelId || null;
    if (dto.returningMemberEnabled !== undefined) {
      cfg.returningMemberEnabled = !!dto.returningMemberEnabled;
    }
    if (dto.returningMemberText !== undefined) {
      cfg.returningMemberText = dto.returningMemberText?.trim() || null;
    }
    if (dto.buttonsConfig !== undefined) {
      cfg.buttonsConfig = sanitizeButtons(dto.buttonsConfig);
    }
    applyImageFields(cfg, dto);

    await this.welcomeRepo.save(cfg);

    if (dto.templates !== undefined) {
      await this.replaceWelcomeTemplates(cfg.id, dto.templates);
    }

    return this.getWelcome(guildId);
  }

  private async replaceWelcomeTemplates(
    configId: string,
    next: { id?: string; text: string; orderIndex?: number }[],
  ): Promise<void> {
    const cleaned = next
      .map((t, i) => ({
        id: t.id,
        text: (t.text ?? '').trim(),
        orderIndex: t.orderIndex ?? i,
      }))
      .filter((t) => t.text.length > 0)
      .slice(0, MAX_TEMPLATES);

    const existing = await this.welcomeTplRepo.find({ where: { configId } });
    const keepIds = new Set(cleaned.filter((t) => t.id).map((t) => t.id as string));
    const toDelete = existing.filter((e) => !keepIds.has(e.id)).map((e) => e.id);
    if (toDelete.length) {
      await this.welcomeTplRepo.delete({ id: In(toDelete) });
    }

    for (const t of cleaned) {
      if (t.id) {
        await this.welcomeTplRepo.update(
          { id: t.id, configId },
          { text: t.text, orderIndex: t.orderIndex },
        );
      } else {
        await this.welcomeTplRepo.save(
          this.welcomeTplRepo.create({
            configId,
            text: t.text,
            orderIndex: t.orderIndex,
          }),
        );
      }
    }
  }

  // ── Goodbye ─────────────────────────────────────────────

  async getGoodbye(guildId: string): Promise<GoodbyeConfig> {
    let cfg = await this.goodbyeRepo.findOne({
      where: { guildId },
      relations: ['templates'],
      relationLoadStrategy: 'query',
    });
    if (!cfg) {
      cfg = this.goodbyeRepo.create({ guildId, enabled: false, templates: [] });
      cfg = await this.goodbyeRepo.save(cfg);
      cfg.templates = [];
    }
    cfg.templates?.sort((a, b) => a.orderIndex - b.orderIndex);
    return cfg;
  }

  async updateGoodbye(guildId: string, dto: GoodbyeFormDto): Promise<GoodbyeConfig> {
    const cfg = await this.getGoodbye(guildId);

    if (dto.enabled !== undefined) cfg.enabled = !!dto.enabled;
    if (dto.channelId !== undefined) cfg.channelId = dto.channelId || null;
    applyImageFields(cfg, dto);

    await this.goodbyeRepo.save(cfg);

    if (dto.templates !== undefined) {
      await this.replaceGoodbyeTemplates(cfg.id, dto.templates);
    }

    return this.getGoodbye(guildId);
  }

  private async replaceGoodbyeTemplates(
    configId: string,
    next: { id?: string; text: string; orderIndex?: number }[],
  ): Promise<void> {
    const cleaned = next
      .map((t, i) => ({
        id: t.id,
        text: (t.text ?? '').trim(),
        orderIndex: t.orderIndex ?? i,
      }))
      .filter((t) => t.text.length > 0)
      .slice(0, MAX_TEMPLATES);

    const existing = await this.goodbyeTplRepo.find({ where: { configId } });
    const keepIds = new Set(cleaned.filter((t) => t.id).map((t) => t.id as string));
    const toDelete = existing.filter((e) => !keepIds.has(e.id)).map((e) => e.id);
    if (toDelete.length) {
      await this.goodbyeTplRepo.delete({ id: In(toDelete) });
    }

    for (const t of cleaned) {
      if (t.id) {
        await this.goodbyeTplRepo.update(
          { id: t.id, configId },
          { text: t.text, orderIndex: t.orderIndex },
        );
      } else {
        await this.goodbyeTplRepo.save(
          this.goodbyeTplRepo.create({
            configId,
            text: t.text,
            orderIndex: t.orderIndex,
          }),
        );
      }
    }
  }

  // ── Helpers used by listeners ──────────────────────────

  /** Pick a random template text (or null). Returning member text wins if applicable. */
  pickWelcomeText(
    cfg: WelcomeConfig,
    opts: { returning?: boolean } = {},
  ): string | null {
    if (opts.returning && cfg.returningMemberEnabled && cfg.returningMemberText) {
      return cfg.returningMemberText;
    }
    const pool = (cfg.templates ?? []).filter((t) => t.text?.trim());
    if (!pool.length) return null;
    // TODO premium: random pick across all templates. Free tier uses just first.
    const idx = Math.floor(Math.random() * pool.length);
    return pool[idx].text;
  }

  pickGoodbyeText(cfg: GoodbyeConfig): string | null {
    const pool = (cfg.templates ?? []).filter((t) => t.text?.trim());
    if (!pool.length) return null;
    const idx = Math.floor(Math.random() * pool.length);
    return pool[idx].text;
  }

  /**
   * Records a (guildId, userId) pair as seen. Returns true if this is a returning
   * member (we had seen them before), false if first encounter.
   *
   * Race-safe: relies on unique index. Concurrent inserts collapse into one row.
   */
  async markSeenAndCheckReturning(guildId: string, userId: string): Promise<boolean> {
    const existing = await this.seenRepo.findOne({ where: { guildId, userId } });
    if (existing) return true;
    try {
      await this.seenRepo.insert({ guildId, userId });
    } catch {
      // Unique race — they had been seen by another concurrent insert.
      return true;
    }
    return false;
  }
}

function applyImageFields(
  cfg: WelcomeConfig | GoodbyeConfig,
  dto: ImageFormFields,
): void {
  if (dto.imageEnabled !== undefined) cfg.imageEnabled = !!dto.imageEnabled;
  if (dto.imageSendMode !== undefined) {
    const m = dto.imageSendMode;
    cfg.imageSendMode = m === 'before_text' || m === 'image_only' ? m : 'with_text';
  }
  if (dto.backgroundImageUrl !== undefined) {
    cfg.backgroundImageUrl = dto.backgroundImageUrl?.trim() || null;
  }
  if (dto.backgroundFill !== undefined) {
    cfg.backgroundFill = sanitizeColor(dto.backgroundFill) ?? null;
  }
  if (dto.avatarConfig !== undefined) {
    cfg.avatarConfig = dto.avatarConfig
      ? sanitizeAvatar(dto.avatarConfig)
      : null;
  }
  if (dto.usernameConfig !== undefined) {
    cfg.usernameConfig = dto.usernameConfig
      ? sanitizeUsername(dto.usernameConfig)
      : null;
  }
  if (dto.imageTextConfig !== undefined) {
    cfg.imageTextConfig = dto.imageTextConfig
      ? sanitizeText(dto.imageTextConfig)
      : null;
  }
}

function sanitizeColor(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  return /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v) ? v : null;
}

function sanitizeAvatar(c: AvatarConfig): AvatarConfig {
  return {
    enabled: !!c.enabled,
    x: clampNum(c.x, 0, 1024, 512),
    y: clampNum(c.y, 0, 400, 170),
    radius: clampNum(c.radius, 16, 200, 80),
    borderColor: sanitizeColor(c.borderColor) ?? '#ffffff',
    borderWidth: clampNum(c.borderWidth, 0, 30, 6),
  };
}

function sanitizeUsername(c: UsernameConfig): UsernameConfig {
  return {
    enabled: !!c.enabled,
    x: clampNum(c.x, 0, 1024, 512),
    y: clampNum(c.y, 0, 400, 290),
    fontSize: clampNum(c.fontSize, 10, 96, 36),
    color: sanitizeColor(c.color) ?? '#ffffff',
    bold: !!c.bold,
    align: c.align === 'left' || c.align === 'right' ? c.align : 'center',
    strokeColor: sanitizeColor(c.strokeColor ?? null),
    strokeWidth: clampNum(c.strokeWidth ?? 0, 0, 10, 0),
  };
}

function sanitizeText(c: ImageTextBlock): ImageTextBlock {
  return {
    enabled: !!c.enabled,
    text: (c.text ?? '').toString().slice(0, 200),
    x: clampNum(c.x, 0, 1024, 512),
    y: clampNum(c.y, 0, 400, 60),
    fontSize: clampNum(c.fontSize, 10, 96, 30),
    color: sanitizeColor(c.color) ?? '#ffffff',
    bold: !!c.bold,
    align: c.align === 'left' || c.align === 'right' ? c.align : 'center',
    strokeColor: sanitizeColor(c.strokeColor ?? null),
    strokeWidth: clampNum(c.strokeWidth ?? 0, 0, 10, 0),
  };
}

function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function sanitizeButtons(
  raw: { label: string; url: string; emoji?: string | null }[] | null | undefined,
): { label: string; url: string; emoji?: string | null }[] | null {
  if (!raw || !Array.isArray(raw)) return null;
  const out = raw
    .map((b) => ({
      label: (b.label ?? '').toString().trim().slice(0, 80),
      url: (b.url ?? '').toString().trim(),
      emoji: b.emoji ? b.emoji.toString().trim() : null,
    }))
    .filter((b) => b.label && /^https?:\/\//i.test(b.url))
    .slice(0, MAX_BUTTONS);
  return out.length ? out : null;
}

export { NotFoundException };
