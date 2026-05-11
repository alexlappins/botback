import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { WelcomeConfig } from './entities/welcome-config.entity';
import {
  WelcomeTemplate,
  type WelcomeVariantRole,
} from './entities/welcome-template.entity';
import { GoodbyeConfig } from './entities/goodbye-config.entity';
import { GoodbyeTemplate } from './entities/goodbye-template.entity';
import { GuildMemberSeen } from './entities/guild-member-seen.entity';
import type {
  AvatarConfig,
  ImageTextBlock,
  UsernameConfig,
} from './image-config.types';

const MAX_VARIANTS = 5;
const MAX_BUTTONS = 3;

export type ImageSendMode = 'with_text' | 'before_text' | 'image_only';

export interface VariantImageFields {
  imageEnabled?: boolean;
  imageSendMode?: ImageSendMode;
  backgroundImageUrl?: string | null;
  backgroundFill?: string | null;
  avatarConfig?: AvatarConfig | null;
  usernameConfig?: UsernameConfig | null;
  imageTextConfig?: ImageTextBlock | null;
}

export interface VariantInput extends VariantImageFields {
  id?: string;
  text: string;
  orderIndex?: number;
}

export interface WelcomeVariantInput extends VariantInput {
  role?: WelcomeVariantRole;
  buttonsConfig?: { label: string; url: string; emoji?: string | null }[] | null;
}

export interface WelcomeFormDto {
  enabled?: boolean;
  sendMode?: 'channel' | 'dm';
  channelId?: string | null;
  returningMemberEnabled?: boolean;
  variants?: WelcomeVariantInput[];
}

export interface GoodbyeFormDto {
  enabled?: boolean;
  channelId?: string | null;
  variants?: VariantInput[];
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

    await this.welcomeRepo.save(cfg);

    if (dto.variants !== undefined) {
      await this.replaceWelcomeVariants(cfg.id, dto.variants);
    }

    return this.getWelcome(guildId);
  }

  private async replaceWelcomeVariants(
    configId: string,
    next: WelcomeVariantInput[],
  ): Promise<void> {
    // Group by role and cap each pool independently
    const byRole = new Map<WelcomeVariantRole, WelcomeVariantInput[]>([
      ['new_member', []],
      ['returning_member', []],
    ]);
    for (const v of next) {
      const role: WelcomeVariantRole =
        v.role === 'returning_member' ? 'returning_member' : 'new_member';
      const list = byRole.get(role)!;
      if (list.length >= MAX_VARIANTS) continue;
      list.push({ ...v, role });
    }

    const flat = [...byRole.get('new_member')!, ...byRole.get('returning_member')!]
      .map((v, i) => ({ ...v, _i: i }))
      .filter((v) => (v.text ?? '').trim().length > 0);

    const existing = await this.welcomeTplRepo.find({ where: { configId } });
    const keepIds = new Set(flat.filter((t) => t.id).map((t) => t.id as string));
    const toDelete = existing.filter((e) => !keepIds.has(e.id)).map((e) => e.id);
    if (toDelete.length) {
      await this.welcomeTplRepo.delete({ id: In(toDelete) });
    }

    for (const v of flat) {
      const payload = welcomeVariantPayload(v, configId, v._i);
      if (v.id) {
        await this.welcomeTplRepo.update({ id: v.id, configId }, payload);
      } else {
        await this.welcomeTplRepo.save(this.welcomeTplRepo.create(payload));
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

    await this.goodbyeRepo.save(cfg);

    if (dto.variants !== undefined) {
      await this.replaceGoodbyeVariants(cfg.id, dto.variants);
    }

    return this.getGoodbye(guildId);
  }

  private async replaceGoodbyeVariants(
    configId: string,
    next: VariantInput[],
  ): Promise<void> {
    const cleaned = next
      .filter((v) => (v.text ?? '').trim().length > 0)
      .slice(0, MAX_VARIANTS);

    const existing = await this.goodbyeTplRepo.find({ where: { configId } });
    const keepIds = new Set(cleaned.filter((t) => t.id).map((t) => t.id as string));
    const toDelete = existing.filter((e) => !keepIds.has(e.id)).map((e) => e.id);
    if (toDelete.length) {
      await this.goodbyeTplRepo.delete({ id: In(toDelete) });
    }

    for (let i = 0; i < cleaned.length; i++) {
      const v = cleaned[i];
      const payload = goodbyeVariantPayload(v, configId, i);
      if (v.id) {
        await this.goodbyeTplRepo.update({ id: v.id, configId }, payload);
      } else {
        await this.goodbyeTplRepo.save(this.goodbyeTplRepo.create(payload));
      }
    }
  }

  // ── Helpers used by listeners ──────────────────────────

  /** Pick a random variant from the appropriate pool, or null. */
  pickWelcomeVariant(
    cfg: WelcomeConfig,
    opts: { returning?: boolean } = {},
  ): WelcomeTemplate | null {
    const all = (cfg.templates ?? []).filter((t) => t.text?.trim());
    const wantReturning = !!opts.returning && cfg.returningMemberEnabled;
    let pool = all.filter(
      (t) =>
        (wantReturning ? t.role === 'returning_member' : t.role === 'new_member'),
    );
    if (!pool.length) {
      // Fallback: if returning was requested but no returning variants are configured,
      // use the new_member pool so the user still gets greeted.
      pool = all.filter((t) => t.role !== 'returning_member');
    }
    if (!pool.length) return null;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  pickGoodbyeVariant(cfg: GoodbyeConfig): GoodbyeTemplate | null {
    const pool = (cfg.templates ?? []).filter((t) => t.text?.trim());
    if (!pool.length) return null;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  async markSeenAndCheckReturning(guildId: string, userId: string): Promise<boolean> {
    const existing = await this.seenRepo.findOne({ where: { guildId, userId } });
    if (existing) return true;
    try {
      await this.seenRepo.insert({ guildId, userId });
    } catch {
      return true;
    }
    return false;
  }
}

// ── Sanitizers ─────────────────────────────────────────

export function welcomeVariantPayload(
  v: WelcomeVariantInput,
  configId: string,
  orderIndex: number,
): Partial<WelcomeTemplate> {
  return {
    configId,
    role: v.role === 'returning_member' ? 'returning_member' : 'new_member',
    text: (v.text ?? '').toString(),
    orderIndex: v.orderIndex ?? orderIndex,
    ...applyImageFieldsToPayload(v),
    buttonsConfig: sanitizeButtons(v.buttonsConfig ?? null),
  };
}

export function goodbyeVariantPayload(
  v: VariantInput,
  configId: string,
  orderIndex: number,
): Partial<GoodbyeTemplate> {
  return {
    configId,
    text: (v.text ?? '').toString(),
    orderIndex: v.orderIndex ?? orderIndex,
    ...applyImageFieldsToPayload(v),
  };
}

function applyImageFieldsToPayload(v: VariantImageFields): Partial<VariantImageFields> {
  return {
    imageEnabled: !!v.imageEnabled,
    imageSendMode:
      v.imageSendMode === 'before_text' || v.imageSendMode === 'image_only'
        ? v.imageSendMode
        : 'with_text',
    backgroundImageUrl: v.backgroundImageUrl?.toString().trim() || null,
    backgroundFill: sanitizeColor(v.backgroundFill ?? null),
    avatarConfig: v.avatarConfig ? sanitizeAvatar(v.avatarConfig) : null,
    usernameConfig: v.usernameConfig ? sanitizeUsername(v.usernameConfig) : null,
    imageTextConfig: v.imageTextConfig ? sanitizeText(v.imageTextConfig) : null,
  };
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
