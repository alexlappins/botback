import { Injectable, Logger } from '@nestjs/common';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import type {
  Canvas,
  Image,
  SKRSContext2D,
} from '@napi-rs/canvas';
import {
  CANVAS_H,
  CANVAS_W,
  DEFAULT_AVATAR_CONFIG,
  DEFAULT_BG_FILL,
  DEFAULT_TEXT_CONFIG,
  DEFAULT_USERNAME_CONFIG,
  type AvatarConfig,
  type ImageTextBlock,
  type UsernameConfig,
} from './image-config.types';
import { resolveVariables } from './variable-resolver';
import type { Guild, GuildMember, User } from 'discord.js';

export interface RenderInput {
  backgroundImageUrl: string | null;
  backgroundFill: string | null;
  avatarConfig: AvatarConfig | null;
  usernameConfig: UsernameConfig | null;
  imageTextConfig: ImageTextBlock | null;
}

export interface RenderContext {
  user: User;
  member?: GuildMember | null;
  guild: Guild;
}

const FETCH_TIMEOUT_MS = 8000;

@Injectable()
export class ImageRendererService {
  private readonly logger = new Logger(ImageRendererService.name);

  /**
   * Render the welcome/goodbye image as PNG.
   * Returns null if rendering fails — listener falls back to text-only.
   *
   * `opts.premium=false` (TZ v2.1 §5): custom settings are IGNORED (not
   * deleted — they stay in the DB and re-apply on renewal); the image renders
   * with the stock default template plus a small "via lvl-up.studio"
   * watermark bottom-right. Premium renders the stored custom config with no
   * watermark.
   */
  async render(
    input: RenderInput,
    ctx: RenderContext,
    opts: { premium?: boolean } = {},
  ): Promise<Buffer | null> {
    const premium = opts.premium !== false; // default true (backwards compat for previews)
    try {
      // Free plan: fall back to the stock template, keep the stored custom
      // config untouched in the DB.
      const effective: RenderInput = premium
        ? input
        : {
            ...input,
            backgroundImageUrl: null,
            backgroundFill: DEFAULT_BG_FILL,
            avatarConfig: DEFAULT_AVATAR_CONFIG,
            usernameConfig: DEFAULT_USERNAME_CONFIG,
            imageTextConfig: input.imageTextConfig
              ? { ...DEFAULT_TEXT_CONFIG, text: input.imageTextConfig.text, enabled: input.imageTextConfig.enabled }
              : DEFAULT_TEXT_CONFIG,
          };

      const canvas = createCanvas(CANVAS_W, CANVAS_H);
      const c = canvas.getContext('2d');

      await this.drawBackground(c, effective);

      const avatarCfg = effective.avatarConfig ?? DEFAULT_AVATAR_CONFIG;
      if (avatarCfg.enabled) {
        await this.drawAvatar(c, ctx.user, avatarCfg);
      }

      const usernameCfg = effective.usernameConfig ?? DEFAULT_USERNAME_CONFIG;
      if (usernameCfg.enabled) {
        this.drawText(c, ctx.user.username, usernameCfg);
      }

      const textCfg = effective.imageTextConfig ?? DEFAULT_TEXT_CONFIG;
      if (textCfg.enabled && textCfg.text) {
        const resolved = resolveVariables(textCfg.text, ctx);
        this.drawText(c, resolved, textCfg);
      }

      if (!premium) this.drawWatermark(c);

      return canvas.toBuffer('image/png');
    } catch (e) {
      this.logger.warn(`Image render failed: ${(e as Error).message}`);
      return null;
    }
  }

  /** Small, unobtrusive brand mark bottom-right — free plan only (TZ §5.1). */
  private drawWatermark(c: SKRSContext2D): void {
    const text = 'via lvl-up.studio';
    c.save();
    c.font = '12px sans-serif';
    c.textAlign = 'right';
    c.textBaseline = 'bottom';
    c.globalAlpha = 0.55;
    c.fillStyle = '#000000';
    c.fillText(text, CANVAS_W - 11, CANVAS_H - 9);
    c.fillStyle = '#ffffff';
    c.fillText(text, CANVAS_W - 12, CANVAS_H - 10);
    c.restore();
  }

  /** Render a sample image with a placeholder user — used by dashboard live preview. */
  async renderPreview(input: RenderInput, sample: SamplePreviewData): Promise<Buffer | null> {
    return this.render(input, {
      user: sample as unknown as User,
      member: null,
      guild: { name: sample.guildName, id: sample.guildId, memberCount: sample.memberCount } as unknown as Guild,
    });
  }

  private async drawBackground(
    c: SKRSContext2D,
    input: RenderInput,
  ): Promise<void> {
    c.fillStyle = input.backgroundFill ?? DEFAULT_BG_FILL;
    c.fillRect(0, 0, CANVAS_W, CANVAS_H);

    const url = input.backgroundImageUrl;
    if (!url) return;
    const img = await fetchImage(url);
    if (!img) return;
    // Cover the canvas (preserve aspect, center-crop)
    const sw = img.width;
    const sh = img.height;
    const targetRatio = CANVAS_W / CANVAS_H;
    const srcRatio = sw / sh;
    let sx = 0;
    let sy = 0;
    let cropW = sw;
    let cropH = sh;
    if (srcRatio > targetRatio) {
      cropW = sh * targetRatio;
      sx = (sw - cropW) / 2;
    } else {
      cropH = sw / targetRatio;
      sy = (sh - cropH) / 2;
    }
    c.drawImage(img, sx, sy, cropW, cropH, 0, 0, CANVAS_W, CANVAS_H);
  }

  private async drawAvatar(
    c: SKRSContext2D,
    user: User,
    cfg: AvatarConfig,
  ): Promise<void> {
    const url = avatarUrlFor(user);
    const img = await fetchImage(url);
    const x = clamp(cfg.x, 0, CANVAS_W);
    const y = clamp(cfg.y, 0, CANVAS_H);
    const r = clamp(cfg.radius, 16, 200);

    // Border ring
    if (cfg.borderWidth > 0) {
      c.beginPath();
      c.arc(x, y, r + cfg.borderWidth / 2, 0, Math.PI * 2);
      c.lineWidth = cfg.borderWidth;
      c.strokeStyle = cfg.borderColor || '#ffffff';
      c.stroke();
    }

    if (!img) {
      // Fallback: filled circle with initial
      c.beginPath();
      c.arc(x, y, r, 0, Math.PI * 2);
      c.fillStyle = '#5865F2';
      c.fill();
      c.fillStyle = '#ffffff';
      c.font = `bold ${Math.round(r)}px Sans`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText((user.username?.[0] ?? '?').toUpperCase(), x, y);
      return;
    }

    c.save();
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.closePath();
    c.clip();
    c.drawImage(img, x - r, y - r, r * 2, r * 2);
    c.restore();
  }

  private drawText(
    c: SKRSContext2D,
    text: string,
    cfg: ImageTextBlock | UsernameConfig,
  ): void {
    if (!text) return;
    const fontSize = clamp(cfg.fontSize, 10, 96);
    c.font = `${cfg.bold ? 'bold ' : ''}${fontSize}px Sans`;
    c.textAlign = cfg.align;
    c.textBaseline = 'middle';
    const x = clamp(cfg.x, 0, CANVAS_W);
    const y = clamp(cfg.y, 0, CANVAS_H);

    if (cfg.strokeColor && (cfg.strokeWidth ?? 0) > 0) {
      c.lineWidth = cfg.strokeWidth!;
      c.strokeStyle = cfg.strokeColor;
      c.lineJoin = 'round';
      c.miterLimit = 2;
      c.strokeText(text, x, y);
    }
    c.fillStyle = cfg.color || '#ffffff';
    c.fillText(text, x, y);
  }
}

export interface SamplePreviewData {
  username: string;
  id: string;
  discriminator?: string;
  avatarURL?: () => string | null;
  displayAvatarURL?: () => string;
  guildName: string;
  guildId: string;
  memberCount: number;
  createdAt?: Date;
}

function avatarUrlFor(user: User): string {
  if (typeof user.displayAvatarURL === 'function') {
    return user.displayAvatarURL({ extension: 'png', size: 256 });
  }
  // SamplePreviewData / loose objects
  const sample = user as unknown as SamplePreviewData;
  if (typeof sample.displayAvatarURL === 'function') return sample.displayAvatarURL();
  if (typeof sample.avatarURL === 'function') {
    const u = sample.avatarURL();
    if (u) return u;
  }
  // Fallback: default Discord avatar based on user id
  const idx = Number(BigInt(user.id ?? '0') % 5n);
  return `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
}

async function fetchImage(url: string): Promise<Image | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return await loadImage(buf);
  } catch {
    return null;
  }
}

function clamp(v: number, min: number, max: number): number {
  if (Number.isNaN(v)) return min;
  return Math.max(min, Math.min(max, v));
}

export type { Canvas };
