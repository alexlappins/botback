import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { Client } from 'discord.js';

import { CustomerGuard } from '../auth/customer.guard';
import { SessionGuard } from '../auth/session.guard';
import type { SessionUser } from '../auth/session.serializer';
import { GuildsService } from '../dashboard/guilds.service';
import { ALERT_EVENT_TYPES, EventAlertsService } from './event-alerts.service';
import { LiveRoleService } from './live-role.service';
import { ScheduleSyncService } from './schedule-sync.service';
import { TwitchOAuthService } from './twitch-oauth.service';
import { WatchXpService } from './watch-xp.service';
import type { AlertEventType } from './entities/twitch-features.entities';

/** Twitch OAuth + Live Role + Event Alerts + Schedule Sync + Watch XP REST. */
@Controller('api/twitch')
export class TwitchFeaturesController {
  constructor(
    private readonly oauth: TwitchOAuthService,
    private readonly liveRole: LiveRoleService,
    private readonly alerts: EventAlertsService,
    private readonly schedule: ScheduleSyncService,
    private readonly watchXp: WatchXpService,
    private readonly guilds: GuildsService,
    private readonly config: ConfigService,
    @Inject(Client) private readonly client: Client,
  ) {}

  private user(req: Request): SessionUser {
    const user = (req as Request & { user?: SessionUser }).user;
    if (!user) throw new UnauthorizedException('Not logged in');
    return user;
  }

  private async ensureGuildAccess(guildId: string, req: Request): Promise<SessionUser> {
    const user = this.user(req);
    const list = await this.guilds.getUserGuilds(user.accessToken, user.refreshToken, (tokens) => {
      user.accessToken = tokens.accessToken;
      user.refreshToken = tokens.refreshToken;
    });
    if (!list.some((g) => g.id === guildId)) throw new UnauthorizedException('No access to this guild');
    return user;
  }

  private frontend(): string {
    return this.config.get<string>('FRONTEND_URL', 'http://localhost:5173');
  }

  // ── §1 Streamer OAuth (connection, NOT login — §0.2) ────

  @Get('oauth/connect')
  @UseGuards(SessionGuard, CustomerGuard)
  async connect(@Query('guildId') guildId: string, @Req() req: Request, @Res() res: Response) {
    const user = await this.ensureGuildAccess(guildId, req);
    const state = this.oauth.signState(JSON.stringify({ g: guildId, u: user.id, k: 'streamer' }));
    res.redirect(this.oauth.authorizeUrl('streamer', state));
  }

  @Get('oauth/callback')
  @UseGuards(SessionGuard)
  async callback(@Query('code') code: string, @Query('state') state: string, @Res() res: Response) {
    const payload = state ? this.oauth.verifyState(state) : null;
    if (!payload || !code) return res.redirect(`${this.frontend()}/twitch?connected=0`);
    const parsed = JSON.parse(payload) as { g: string; u: string; k: string };
    try {
      const conn = await this.oauth.completeStreamerConnect(parsed.g, parsed.u, code);
      await this.alerts.ensureEventSubscriptions(conn).catch(() => null);
      return res.redirect(`${this.frontend()}/twitch?connected=1`);
    } catch {
      return res.redirect(`${this.frontend()}/twitch?connected=0`);
    }
  }

  @Get('connections')
  @UseGuards(SessionGuard, CustomerGuard)
  @Header('Cache-Control', 'no-store')
  async connections(@Query('guildId') guildId: string, @Req() req: Request) {
    await this.ensureGuildAccess(guildId, req);
    const rows = await this.oauth.listConnections(guildId);
    return rows.map((r) => ({
      id: r.id,
      twitchLogin: r.twitchLogin,
      status: r.status,
      discordUserId: r.discordUserId,
      createdAt: r.createdAt,
    }));
  }

  @Delete('connections/:id')
  @UseGuards(SessionGuard, CustomerGuard)
  async disconnect(@Query('guildId') guildId: string, @Param('id') id: string, @Req() req: Request) {
    await this.ensureGuildAccess(guildId, req);
    // §1.4: drop this connection's alert EventSubs; stream.online/offline of
    // regular live notifications live on stream_subscriptions and stay.
    await this.alerts.removeEventSubscriptions(id).catch(() => null);
    await this.oauth.disconnect(guildId, id);
    return { ok: true };
  }

  // ── TZ-B §2.2 Viewer link (identity only, global) ───────

  @Get('oauth/link-viewer')
  @UseGuards(SessionGuard, CustomerGuard)
  linkViewer(@Req() req: Request, @Res() res: Response) {
    const user = this.user(req);
    const state = this.oauth.signState(JSON.stringify({ u: user.id, k: 'viewer' }));
    res.redirect(this.oauth.authorizeUrl('viewer', state));
  }

  @Get('oauth/viewer-callback')
  @UseGuards(SessionGuard)
  async viewerCallback(@Query('code') code: string, @Query('state') state: string, @Res() res: Response) {
    const payload = state ? this.oauth.verifyState(state) : null;
    if (!payload || !code) return res.redirect(`${this.frontend()}/leveling?linked=0`);
    const parsed = JSON.parse(payload) as { u: string; k: string };
    try {
      await this.oauth.completeViewerLink(parsed.u, code);
      return res.redirect(`${this.frontend()}/leveling?linked=1`);
    } catch {
      return res.redirect(`${this.frontend()}/leveling?linked=0`);
    }
  }

  @Get('viewer-link')
  @UseGuards(SessionGuard, CustomerGuard)
  @Header('Cache-Control', 'no-store')
  async viewerLink(@Req() req: Request) {
    const link = await this.oauth.getViewerLink(this.user(req).id);
    return link ? { linked: true, twitchLogin: link.twitchLogin } : { linked: false };
  }

  @Delete('viewer-link')
  @UseGuards(SessionGuard, CustomerGuard)
  async unlinkViewer(@Req() req: Request) {
    await this.oauth.unlinkViewer(this.user(req).id);
    return { ok: true };
  }

  // ── §2 Live Role ────────────────────────────────────────

  @Get('live-role')
  @UseGuards(SessionGuard, CustomerGuard)
  @Header('Cache-Control', 'no-store')
  async liveRoleState(@Query('guildId') guildId: string, @Req() req: Request) {
    await this.ensureGuildAccess(guildId, req);
    const configs = await this.liveRole.listConfigs(guildId);
    const bindings = await this.liveRole.listBindings(guildId);
    return {
      configs: configs.map((c) => ({
        ...c,
        hierarchyWarning: this.liveRole.hierarchyWarning(guildId, c.roleId), // §2.5
      })),
      bindings,
    };
  }

  @Post('live-role/configs')
  @UseGuards(SessionGuard, CustomerGuard)
  async createLiveRole(
    @Query('guildId') guildId: string,
    @Body() body: { roleId?: string },
    @Req() req: Request,
  ) {
    await this.ensureGuildAccess(guildId, req);
    if (!body?.roleId) throw new BadRequestException('roleId required');
    try {
      return await this.liveRole.createConfig(guildId, body.roleId);
    } catch (e) {
      if ((e as Error).message === 'premium_required') {
        throw new BadRequestException({ message: 'Premium required', reason: 'premium_required' });
      }
      throw new BadRequestException((e as Error).message);
    }
  }

  @Put('live-role/configs/:id')
  @UseGuards(SessionGuard, CustomerGuard)
  async updateLiveRole(
    @Query('guildId') guildId: string,
    @Param('id') id: string,
    @Body() body: { roleId?: string; enabled?: boolean; filterText?: string | null; blacklist?: string[] },
    @Req() req: Request,
  ) {
    await this.ensureGuildAccess(guildId, req);
    return this.liveRole.updateConfig(guildId, id, body as never);
  }

  @Delete('live-role/configs/:id')
  @UseGuards(SessionGuard, CustomerGuard)
  async deleteLiveRole(@Query('guildId') guildId: string, @Param('id') id: string, @Req() req: Request) {
    await this.ensureGuildAccess(guildId, req);
    await this.liveRole.deleteConfig(guildId, id);
    return { ok: true };
  }

  @Post('live-role/bindings')
  @UseGuards(SessionGuard, CustomerGuard)
  async addBinding(
    @Query('guildId') guildId: string,
    @Body() body: { configId?: string; discordUserId?: string; twitchLogin?: string },
    @Req() req: Request,
  ) {
    await this.ensureGuildAccess(guildId, req);
    if (!body?.configId || !body?.discordUserId || !body?.twitchLogin) {
      throw new BadRequestException('configId, discordUserId, twitchLogin required');
    }
    try {
      return await this.liveRole.addBinding(guildId, body.configId, body.discordUserId, body.twitchLogin, 'manual');
    } catch (e) {
      if ((e as Error).message === 'premium_required') {
        throw new BadRequestException({ message: 'Premium required', reason: 'premium_required' });
      }
      throw new BadRequestException((e as Error).message);
    }
  }

  @Delete('live-role/bindings/:id')
  @UseGuards(SessionGuard, CustomerGuard)
  async removeBinding(@Query('guildId') guildId: string, @Param('id') id: string, @Req() req: Request) {
    await this.ensureGuildAccess(guildId, req);
    await this.liveRole.removeBinding(guildId, id);
    return { ok: true };
  }

  // ── §3 Event Alerts ─────────────────────────────────────

  @Get('event-alerts')
  @UseGuards(SessionGuard, CustomerGuard)
  @Header('Cache-Control', 'no-store')
  async eventAlerts(@Query('guildId') guildId: string, @Req() req: Request) {
    await this.ensureGuildAccess(guildId, req);
    return this.alerts.getSettings(guildId);
  }

  @Put('event-alerts/:type')
  @UseGuards(SessionGuard, CustomerGuard)
  async updateEventAlert(
    @Query('guildId') guildId: string,
    @Param('type') type: string,
    @Body() body: Record<string, unknown>,
    @Req() req: Request,
  ) {
    await this.ensureGuildAccess(guildId, req);
    if (!ALERT_EVENT_TYPES.includes(type as AlertEventType)) throw new BadRequestException('Unknown event type');
    return this.alerts.updateSetting(guildId, type as AlertEventType, body as never);
  }

  @Post('event-alerts/:type/test')
  @UseGuards(SessionGuard, CustomerGuard)
  async testEventAlert(@Query('guildId') guildId: string, @Param('type') type: string, @Req() req: Request) {
    await this.ensureGuildAccess(guildId, req);
    if (!ALERT_EVENT_TYPES.includes(type as AlertEventType)) throw new BadRequestException('Unknown event type');
    await this.alerts.sendTest(guildId, type as AlertEventType);
    return { ok: true };
  }

  @Post('event-alerts/:type/copy-card')
  @UseGuards(SessionGuard, CustomerGuard)
  async copyCard(@Query('guildId') guildId: string, @Param('type') type: string, @Req() req: Request) {
    await this.ensureGuildAccess(guildId, req);
    await this.alerts.copyCardToAll(guildId, type as AlertEventType);
    return { ok: true };
  }

  // ── TZ-B §1 Schedule Sync ───────────────────────────────

  @Get('schedule-sync')
  @UseGuards(SessionGuard, CustomerGuard)
  @Header('Cache-Control', 'no-store')
  async scheduleSettings(@Query('guildId') guildId: string, @Req() req: Request) {
    await this.ensureGuildAccess(guildId, req);
    const settings = await this.schedule.getSettings(guildId);
    return { ...settings, manageEvents: this.schedule.hasManageEvents(guildId) }; // §1.5
  }

  @Put('schedule-sync')
  @UseGuards(SessionGuard, CustomerGuard)
  async updateSchedule(
    @Query('guildId') guildId: string,
    @Body() body: Record<string, unknown>,
    @Req() req: Request,
  ) {
    await this.ensureGuildAccess(guildId, req);
    delete body.guildId;
    return this.schedule.updateSettings(guildId, body as never);
  }

  @Post('schedule-sync/now')
  @UseGuards(SessionGuard, CustomerGuard)
  async syncNow(@Query('guildId') guildId: string, @Req() req: Request) {
    await this.ensureGuildAccess(guildId, req);
    return this.schedule.syncGuild(guildId);
  }

  // ── TZ-B §2 Top Fans ────────────────────────────────────

  @Get('top-fans')
  @UseGuards(SessionGuard, CustomerGuard)
  @Header('Cache-Control', 'no-store')
  async topFans(@Query('guildId') guildId: string, @Req() req: Request) {
    await this.ensureGuildAccess(guildId, req);
    const rows = await this.watchXp.topFans(guildId, 20);
    return Promise.all(
      rows.map(async (r) => {
        const user = await this.client.users.fetch(r.discordId).catch(() => null);
        return { ...r, tag: user?.tag ?? null, avatarUrl: user?.displayAvatarURL({ size: 64 }) ?? null };
      }),
    );
  }
}
