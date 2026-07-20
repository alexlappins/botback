import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Inject,
  Param,
  Put,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { Client } from 'discord.js';

import { CustomerGuard } from '../auth/customer.guard';
import { SessionGuard } from '../auth/session.guard';
import type { SessionUser } from '../auth/session.serializer';
import { GuildsService } from '../dashboard/guilds.service';
import { AuditLookupService } from './audit-lookup.service';
import { AlertsService } from './alerts.service';
import { LogSettingsService } from './log-settings.service';
import type { PresetSettingsInput } from './log-settings.service';
import { LOG_PRESETS, LogPreset } from './log-presets';

/**
 * Server Logs 2.0 + Server Alerts REST API (TZ §2, §4.1).
 * Base: /api/guilds/:guildId/…
 */
@Controller('api/guilds/:guildId')
@UseGuards(SessionGuard, CustomerGuard)
export class LogsController {
  constructor(
    private readonly settings: LogSettingsService,
    private readonly alerts: AlertsService,
    private readonly audit: AuditLookupService,
    private readonly guilds: GuildsService,
    @Inject(Client) private readonly client: Client,
  ) {}

  private async ensureGuildAccess(guildId: string, req: Request): Promise<void> {
    const user = (req as Request & { user: SessionUser }).user;
    const list = await this.guilds.getUserGuilds(user.accessToken, user.refreshToken, (tokens) => {
      user.accessToken = tokens.accessToken;
      user.refreshToken = tokens.refreshToken;
    });
    if (!list.some((g) => g.id === guildId)) throw new UnauthorizedException('No access to this guild');
  }

  // ── Presets (TZ §2-3) ───────────────────────────────────

  @Get('log-settings')
  @Header('Cache-Control', 'no-store')
  async getLogSettings(@Param('guildId') guildId: string, @Req() req: Request) {
    await this.ensureGuildAccess(guildId, req);
    const row = await this.settings.getOrCreate(guildId);
    const guild = this.client.guilds.cache.get(guildId);
    return {
      ...this.settings.toWire(row),
      // TZ §2: warn in the UI when the bot can't read the Audit Log.
      auditLogAccess: guild ? this.audit.hasAuditAccess(guild) : true,
    };
  }

  @Put('log-settings')
  async putLogSettings(
    @Param('guildId') guildId: string,
    @Body() body: PresetSettingsInput,
    @Req() req: Request,
  ) {
    await this.ensureGuildAccess(guildId, req);
    if (body.presets) {
      for (const key of Object.keys(body.presets)) {
        if (!LOG_PRESETS.includes(key as LogPreset)) {
          throw new BadRequestException(`Unknown preset: ${key}`);
        }
      }
    }
    const saved = await this.settings.update(guildId, body);
    return this.settings.toWire(saved);
  }

  // ── Alerts (TZ §4) ──────────────────────────────────────

  @Get('alert-settings')
  @Header('Cache-Control', 'no-store')
  async getAlertSettings(@Param('guildId') guildId: string, @Req() req: Request) {
    await this.ensureGuildAccess(guildId, req);
    const row = await this.alerts.getSettings(guildId);
    const guild = this.client.guilds.cache.get(guildId);
    const recipients = await Promise.all(
      row.recipients.map(async (id) => {
        const user = await this.client.users.fetch(id).catch(() => null);
        return { id, tag: user?.tag ?? null, avatarUrl: user?.displayAvatarURL({ size: 64 }) ?? null };
      }),
    );
    const owner = guild ? await this.client.users.fetch(guild.ownerId).catch(() => null) : null;
    return {
      enabled: row.enabled,
      owner: guild ? { id: guild.ownerId, tag: owner?.tag ?? null } : null,
      recipients,
      detectors: Object.fromEntries(
        ([1, 2, 3, 4, 5, 6, 7, 8, 9] as const).map((i) => [`d${i}`, row[`d${i}Enabled`] as boolean]),
      ),
    };
  }

  @Put('alert-settings')
  async putAlertSettings(
    @Param('guildId') guildId: string,
    @Body()
    body: {
      enabled?: boolean;
      recipients?: string[];
      detectors?: Partial<Record<'d1' | 'd2' | 'd3' | 'd4' | 'd5' | 'd6' | 'd7' | 'd8' | 'd9', boolean>>;
    },
    @Req() req: Request,
  ) {
    await this.ensureGuildAccess(guildId, req);
    if (body.recipients && body.recipients.length > 3) {
      throw new BadRequestException('Maximum 3 extra recipients');
    }
    const patch: Record<string, unknown> = {};
    if (body.enabled !== undefined) patch.enabled = body.enabled;
    if (body.recipients !== undefined) patch.recipients = body.recipients.map((r) => r.trim()).filter(Boolean);
    for (const [k, v] of Object.entries(body.detectors ?? {})) {
      patch[`${k}Enabled`] = v;
    }
    await this.alerts.updateSettings(guildId, patch as never);
    return this.getAlertSettings(guildId, req);
  }

  /** Member search for the recipients picker (TZ §4.1: поиск по нику). */
  @Get('members/search')
  @Header('Cache-Control', 'no-store')
  async searchMembers(@Param('guildId') guildId: string, @Query('q') q: string, @Req() req: Request) {
    await this.ensureGuildAccess(guildId, req);
    const query = q?.trim();
    if (!query) return [];
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) return [];
    const found = await guild.members.fetch({ query, limit: 10 }).catch(() => null);
    if (!found) return [];
    return [...found.values()]
      .filter((m) => !m.user.bot)
      .map((m) => ({
        id: m.id,
        tag: m.user.tag,
        displayName: m.displayName,
        avatarUrl: m.user.displayAvatarURL({ size: 64 }),
      }));
  }
}
