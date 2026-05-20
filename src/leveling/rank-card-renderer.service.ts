import { Injectable, Logger } from '@nestjs/common';
import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas';

import { AvatarCacheService } from './avatar-cache.service';
import type { ServerLevelingSettings } from './entities/server-leveling-settings.entity';
import type { ServerTier } from './entities/server-tier.entity';
import { levelProgress } from './level-formula';

const CARD_W = 800;
const CARD_H = 300;
const PADDING = 30;
const AVATAR_R = 80;
const AVATAR_X = PADDING + AVATAR_R; // 110
const AVATAR_Y = CARD_H / 2;          // 150

export interface RankCardData {
  username: string;
  avatarUrl: string;
  level: number;
  totalXp: bigint;
  currentLevelXp: number;  // XP earned within the current level
  neededXp: number;        // XP required to clear the current level
  progressPct: number;     // 0–100
  tier: { name: string; emoji: string | null; color: string } | null;
  rank: number;            // server rank position
  totalMembers: number;    // total ranked members
  messagesCount: number;
  voiceMinutes: number;
}

export type RankCardStyle = Pick<
  ServerLevelingSettings,
  | 'rankBgImageUrl'
  | 'rankBgColor'
  | 'rankOverlayOpacity'
  | 'rankPrimaryTextColor'
  | 'rankSecondaryTextColor'
  | 'rankAccentColor'
  | 'rankProgressColor'
  | 'rankProgressBgColor'
>;

@Injectable()
export class RankCardRendererService {
  private readonly logger = new Logger(RankCardRendererService.name);

  constructor(private readonly avatars: AvatarCacheService) {}

  /**
   * Render an 800x300 PNG rank card. Returns null if generation fails — the
   * caller (slash command / preview endpoint) decides whether to fall back to
   * an embed or surface the error.
   */
  async render(data: RankCardData, style: RankCardStyle): Promise<Buffer | null> {
    try {
      const canvas = createCanvas(CARD_W, CARD_H);
      const c = canvas.getContext('2d');

      await this.drawBackground(c, style);
      this.drawOverlay(c, style);
      await this.drawAvatar(c, data.avatarUrl, data.username);
      this.drawHeader(c, data, style);
      this.drawProgressBar(c, data, style);
      this.drawStatsLine(c, data, style);
      this.drawRankBadge(c, data, style);

      return canvas.toBuffer('image/png');
    } catch (e) {
      this.logger.warn(`Rank card render failed: ${(e as Error).message}`);
      return null;
    }
  }

  private async drawBackground(c: SKRSContext2D, style: RankCardStyle): Promise<void> {
    c.fillStyle = style.rankBgColor || '#1a1a1a';
    c.fillRect(0, 0, CARD_W, CARD_H);

    const url = style.rankBgImageUrl;
    if (!url) return;
    const img = await this.avatars.get(url);
    if (!img) return;
    // Cover: preserve aspect, center-crop
    const targetRatio = CARD_W / CARD_H;
    const srcRatio = img.width / img.height;
    let sx = 0;
    let sy = 0;
    let cropW = img.width;
    let cropH = img.height;
    if (srcRatio > targetRatio) {
      cropW = img.height * targetRatio;
      sx = (img.width - cropW) / 2;
    } else {
      cropH = img.width / targetRatio;
      sy = (img.height - cropH) / 2;
    }
    c.drawImage(img, sx, sy, cropW, cropH, 0, 0, CARD_W, CARD_H);
  }

  private drawOverlay(c: SKRSContext2D, style: RankCardStyle): void {
    const opacity = clamp(style.rankOverlayOpacity ?? 40, 0, 100) / 100;
    if (opacity === 0) return;
    c.fillStyle = `rgba(0,0,0,${opacity})`;
    c.fillRect(0, 0, CARD_W, CARD_H);
  }

  private async drawAvatar(c: SKRSContext2D, url: string, username: string): Promise<void> {
    const img = await this.avatars.get(url);

    // Subtle ring
    c.beginPath();
    c.arc(AVATAR_X, AVATAR_Y, AVATAR_R + 4, 0, Math.PI * 2);
    c.lineWidth = 4;
    c.strokeStyle = 'rgba(255,255,255,0.25)';
    c.stroke();

    if (!img) {
      c.beginPath();
      c.arc(AVATAR_X, AVATAR_Y, AVATAR_R, 0, Math.PI * 2);
      c.fillStyle = '#5865F2';
      c.fill();
      c.fillStyle = '#ffffff';
      c.font = `bold ${Math.round(AVATAR_R)}px Sans`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText((username?.[0] ?? '?').toUpperCase(), AVATAR_X, AVATAR_Y);
      return;
    }
    c.save();
    c.beginPath();
    c.arc(AVATAR_X, AVATAR_Y, AVATAR_R, 0, Math.PI * 2);
    c.closePath();
    c.clip();
    c.drawImage(img, AVATAR_X - AVATAR_R, AVATAR_Y - AVATAR_R, AVATAR_R * 2, AVATAR_R * 2);
    c.restore();
  }

  private drawHeader(c: SKRSContext2D, data: RankCardData, style: RankCardStyle): void {
    const textX = AVATAR_X + AVATAR_R + 25; // 215
    const usernameY = 80;
    const tierY = 120;

    c.textBaseline = 'middle';
    c.textAlign = 'left';

    // Username
    c.font = 'bold 32px Sans';
    c.fillStyle = style.rankPrimaryTextColor || '#FFFFFF';
    c.fillText(truncate(data.username, 22), textX, usernameY);

    // Tier line — accent colored
    if (data.tier) {
      c.font = 'bold 20px Sans';
      c.fillStyle = data.tier.color || style.rankAccentColor || '#8b5cf6';
      const tierText = `${data.tier.emoji ?? ''} ${data.tier.name}`.trim();
      c.fillText(tierText, textX, tierY);
    }
  }

  private drawProgressBar(c: SKRSContext2D, data: RankCardData, style: RankCardStyle): void {
    const barX = AVATAR_X + AVATAR_R + 25; // 215
    const barW = CARD_W - barX - PADDING;  // 555
    const barH = 22;
    const barY = 200;

    // Track
    drawRoundedRect(c, barX, barY, barW, barH, barH / 2);
    c.fillStyle = parseRgbaSafe(style.rankProgressBgColor, 'rgba(255,255,255,0.2)');
    c.fill();

    // Fill
    const fillW = Math.max(0, Math.min(barW, (data.progressPct / 100) * barW));
    if (fillW > 0) {
      drawRoundedRect(c, barX, barY, fillW, barH, barH / 2);
      c.fillStyle = style.rankProgressColor || '#8b5cf6';
      c.fill();
    }

    // Inline progress label (right-aligned, baseline-middle inside the track)
    c.font = 'bold 14px Sans';
    c.fillStyle = style.rankPrimaryTextColor || '#FFFFFF';
    c.textAlign = 'right';
    c.textBaseline = 'middle';
    const label = `${formatNumber(data.currentLevelXp)} / ${formatNumber(data.neededXp)} XP · ${data.progressPct}%`;
    c.fillText(label, barX + barW - 8, barY + barH / 2);
  }

  private drawStatsLine(c: SKRSContext2D, data: RankCardData, style: RankCardStyle): void {
    const x = AVATAR_X + AVATAR_R + 25;
    const y = 250;
    c.font = '14px Sans';
    c.fillStyle = style.rankSecondaryTextColor || '#B0B0B0';
    c.textAlign = 'left';
    c.textBaseline = 'middle';
    const parts = [
      `${formatNumber(data.messagesCount)} messages`,
      `${formatNumber(data.voiceMinutes)} voice min`,
      `Total XP: ${formatNumber(data.totalXp)}`,
    ];
    c.fillText(parts.join('  ·  '), x, y);
  }

  private drawRankBadge(c: SKRSContext2D, data: RankCardData, style: RankCardStyle): void {
    // Top-right: "Lv 25" and "#5 of 234"
    const rightX = CARD_W - PADDING;
    c.textAlign = 'right';
    c.textBaseline = 'middle';

    // Level number — large accent
    c.font = 'bold 48px Sans';
    c.fillStyle = style.rankAccentColor || '#8b5cf6';
    c.fillText(`Lv ${data.level}`, rightX, 70);

    // Rank position — small secondary
    c.font = '14px Sans';
    c.fillStyle = style.rankSecondaryTextColor || '#B0B0B0';
    c.fillText(
      `#${data.rank || '—'}${data.totalMembers ? ` of ${formatNumber(data.totalMembers)}` : ''}`,
      rightX,
      110,
    );
  }
}

// ── Helpers ────────────────────────────────────────────────

function clamp(v: number, min: number, max: number): number {
  if (Number.isNaN(v)) return min;
  return Math.max(min, Math.min(max, v));
}

function formatNumber(v: number | bigint): string {
  const n = typeof v === 'bigint' ? Number(v) : v;
  if (!Number.isFinite(n)) return '0';
  return n.toLocaleString('en-US');
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

/**
 * Parse "rgba(r,g,b,a)" / "#RRGGBB" / "#RGB" / etc. into a canvas-safe colour
 * string. Returns the fallback if the value is unparseable — Skia would throw
 * on invalid CSS otherwise and we'd lose the whole card.
 */
function parseRgbaSafe(v: string | null | undefined, fallback: string): string {
  if (!v) return fallback;
  const s = v.trim();
  if (/^#[0-9a-f]{3,8}$/i.test(s)) return s;
  if (/^rgba?\([^)]+\)$/i.test(s)) return s;
  return fallback;
}

function drawRoundedRect(
  c: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + radius, y);
  c.lineTo(x + w - radius, y);
  c.quadraticCurveTo(x + w, y, x + w, y + radius);
  c.lineTo(x + w, y + h - radius);
  c.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  c.lineTo(x + radius, y + h);
  c.quadraticCurveTo(x, y + h, x, y + h - radius);
  c.lineTo(x, y + radius);
  c.quadraticCurveTo(x, y, x + radius, y);
  c.closePath();
}

/**
 * Build a {@link RankCardData} object given persisted state. Caller fetches
 * `xp`, resolves `tier`, computes `rank`/`totalMembers`, and supplies the
 * username + avatar URL (we don't depend on discord.js here so this stays
 * trivially testable).
 */
export function buildRankCardData(args: {
  username: string;
  avatarUrl: string;
  level: number;
  totalXp: bigint;
  rank: number;
  totalMembers: number;
  messagesCount: number;
  voiceMinutes: number;
  tier: ServerTier | null;
}): RankCardData {
  const progress = levelProgress(args.totalXp, args.level);
  return {
    username: args.username,
    avatarUrl: args.avatarUrl,
    level: args.level,
    totalXp: args.totalXp,
    currentLevelXp: progress.current,
    neededXp: progress.needed,
    progressPct: progress.percent,
    tier: args.tier
      ? { name: args.tier.name, emoji: args.tier.emoji, color: args.tier.color }
      : null,
    rank: args.rank,
    totalMembers: args.totalMembers,
    messagesCount: args.messagesCount,
    voiceMinutes: args.voiceMinutes,
  };
}
