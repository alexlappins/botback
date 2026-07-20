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
import { PanicService } from './panic.service';
import { QuarantineService } from './quarantine.service';
import { SecurityActionsService } from './security-actions.service';
import { SecurityService } from './security.service';
import { StreamShieldService } from './stream-shield.service';
import { SnapshotService } from './snapshot.service';
import type { SecurityPreset, SecuritySettings } from './entities/security.entities';

/** Security Suite REST API — /api/guilds/:guildId/security/… */
@Controller('api/guilds/:guildId/security')
@UseGuards(SessionGuard, CustomerGuard)
export class SecurityController {
  constructor(
    private readonly security: SecurityService,
    private readonly panic: PanicService,
    private readonly quarantine: QuarantineService,
    private readonly actions: SecurityActionsService,
    private readonly shield: StreamShieldService,
    private readonly snapshots: SnapshotService,
    private readonly guilds: GuildsService,
    @Inject(Client) private readonly client: Client,
  ) {}

  private async ensureAccess(guildId: string, req: Request): Promise<SessionUser> {
    const user = (req as Request & { user: SessionUser }).user;
    const list = await this.guilds.getUserGuilds(user.accessToken, user.refreshToken, (tokens) => {
      user.accessToken = tokens.accessToken;
      user.refreshToken = tokens.refreshToken;
    });
    if (!list.some((g) => g.id === guildId)) throw new UnauthorizedException('No access to this guild');
    return user;
  }

  // ── Overview / settings ─────────────────────────────────

  @Get()
  @Header('Cache-Control', 'no-store')
  async overview(@Param('guildId') guildId: string, @Req() req: Request) {
    await this.ensureAccess(guildId, req);
    const s = await this.security.getSettings(guildId);
    return {
      settings: s,
      panicActive: await this.panic.isActive(guildId),
      shieldActive: this.shield.isActive(guildId),
      premium: await this.security.isPremium(guildId),
    };
  }

  @Put('settings')
  async updateSettings(
    @Param('guildId') guildId: string,
    @Body() body: Partial<SecuritySettings>,
    @Req() req: Request,
  ) {
    await this.ensureAccess(guildId, req);
    // Never allow client to smuggle identity/system columns.
    delete (body as Record<string, unknown>).guildId;
    delete (body as Record<string, unknown>).panelMessageId;
    const saved = await this.security.updateSettings(guildId, { ...body, preset: null });
    const guild = this.client.guilds.cache.get(guildId);
    if (guild) await this.panic.refreshPanel(guild).catch(() => null);
    return saved;
  }

  @Post('preset/:preset')
  async applyPreset(@Param('guildId') guildId: string, @Param('preset') preset: string, @Req() req: Request) {
    await this.ensureAccess(guildId, req);
    if (!['relaxed', 'standard', 'strict'].includes(preset)) throw new BadRequestException('Unknown preset');
    return this.security.applyPreset(guildId, preset as SecurityPreset);
  }

  // ── §3 Panic ────────────────────────────────────────────

  @Post('panic/:state')
  async setPanic(@Param('guildId') guildId: string, @Param('state') state: string, @Req() req: Request) {
    const user = await this.ensureAccess(guildId, req);
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) throw new BadRequestException('Bot is not on this server');
    const result =
      state === 'on' ? await this.panic.activate(guild, user.id) : await this.panic.deactivate(guild, user.id);
    return { active: await this.panic.isActive(guildId), notes: result.notes };
  }

  /** Re-post the Security Panel after the channel was picked. */
  @Post('panel/refresh')
  async refreshPanel(@Param('guildId') guildId: string, @Req() req: Request) {
    await this.ensureAccess(guildId, req);
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) throw new BadRequestException('Bot is not on this server');
    await this.panic.refreshPanel(guild);
    return { ok: true };
  }

  // ── §1 Whitelist ────────────────────────────────────────

  @Get('whitelist')
  @Header('Cache-Control', 'no-store')
  async listWhitelist(@Param('guildId') guildId: string, @Req() req: Request) {
    await this.ensureAccess(guildId, req);
    const entries = await this.security.listWhitelist(guildId);
    const guild = this.client.guilds.cache.get(guildId);
    return Promise.all(
      entries.map(async (e) => {
        let name: string | null = null;
        if (e.entityType === 'role') name = guild?.roles.cache.get(e.entityId)?.name ?? null;
        else name = await this.client.users.fetch(e.entityId).then((u) => u.tag).catch(() => null);
        return { id: e.id, entityType: e.entityType, entityId: e.entityId, name };
      }),
    );
  }

  @Post('whitelist')
  async addWhitelist(
    @Param('guildId') guildId: string,
    @Body() body: { entityType?: 'user' | 'role'; entityId?: string },
    @Req() req: Request,
  ) {
    await this.ensureAccess(guildId, req);
    if (!body?.entityId || !['user', 'role'].includes(body?.entityType ?? '')) {
      throw new BadRequestException('entityType (user|role) and entityId required');
    }
    return this.security.addWhitelist(guildId, body.entityType!, body.entityId.trim());
  }

  @Delete('whitelist/:id')
  async removeWhitelist(@Param('guildId') guildId: string, @Param('id') id: string, @Req() req: Request) {
    await this.ensureAccess(guildId, req);
    await this.security.removeWhitelist(guildId, id);
    return { ok: true };
  }

  // ── §6 Quarantine ───────────────────────────────────────

  @Post('quarantine/setup')
  async setupQuarantine(@Param('guildId') guildId: string, @Req() req: Request) {
    await this.ensureAccess(guildId, req);
    if (!(await this.security.isPremium(guildId))) {
      throw new BadRequestException('Premium required');
    }
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) throw new BadRequestException('Bot is not on this server');
    return this.quarantine.setup(guild);
  }

  @Get('quarantine')
  @Header('Cache-Control', 'no-store')
  async listQuarantine(@Param('guildId') guildId: string, @Req() req: Request) {
    await this.ensureAccess(guildId, req);
    const records = await this.quarantine.listActive(guildId);
    return Promise.all(
      records.map(async (r) => ({
        id: r.id,
        userId: r.userId,
        userTag: await this.client.users.fetch(r.userId).then((u) => u.tag).catch(() => null),
        reason: r.reason,
        source: r.source,
        createdAt: r.createdAt,
      })),
    );
  }

  @Post('quarantine/:recordId/:action')
  async resolveQuarantine(
    @Param('guildId') guildId: string,
    @Param('recordId') recordId: string,
    @Param('action') action: string,
    @Req() req: Request,
  ) {
    await this.ensureAccess(guildId, req);
    if (!['approve', 'kick', 'ban'].includes(action)) throw new BadRequestException('Bad action');
    await this.quarantine.resolveFromDashboard(guildId, recordId, action as never);
    return { ok: true };
  }

  // ── §5 Nuke incidents ───────────────────────────────────

  @Get('nuke-incidents')
  @Header('Cache-Control', 'no-store')
  async nukeIncidents(@Param('guildId') guildId: string, @Req() req: Request) {
    await this.ensureAccess(guildId, req);
    const rows = await this.actions.listNukeIncidents(guildId);
    const guild = this.client.guilds.cache.get(guildId);
    return Promise.all(
      rows.map(async (r) => ({
        id: r.id,
        userId: r.userId,
        userTag: await this.client.users.fetch(r.userId).then((u) => u.tag).catch(() => null),
        roles: r.strippedRoleIds.map((id) => guild?.roles.cache.get(id)?.name ?? id),
        detector: r.detector,
        restored: r.restored,
        createdAt: r.createdAt,
      })),
    );
  }

  // ── §10 Snapshots ───────────────────────────────────────

  @Get('snapshots')
  @Header('Cache-Control', 'no-store')
  async listSnapshots(@Param('guildId') guildId: string, @Req() req: Request) {
    await this.ensureAccess(guildId, req);
    const rows = await this.snapshots.list(guildId);
    return rows.map((r) => {
      const d = r.data as { roles?: unknown[]; categories?: unknown[]; channels?: unknown[] };
      return {
        id: r.id,
        type: r.type,
        createdAt: r.createdAt,
        counts: {
          roles: d.roles?.length ?? 0,
          categories: d.categories?.length ?? 0,
          channels: d.channels?.length ?? 0,
        },
      };
    });
  }

  @Post('snapshots')
  async takeSnapshot(@Param('guildId') guildId: string, @Req() req: Request) {
    await this.ensureAccess(guildId, req);
    if (!(await this.security.isPremium(guildId))) throw new BadRequestException('Premium required');
    const row = await this.snapshots.takeSnapshot(guildId, 'manual');
    return { id: row.id, createdAt: row.createdAt };
  }

  @Get('snapshots/:id/preview')
  @Header('Cache-Control', 'no-store')
  async previewSnapshot(@Param('guildId') guildId: string, @Param('id') id: string, @Req() req: Request) {
    await this.ensureAccess(guildId, req);
    return this.snapshots.preview(guildId, id);
  }

  @Post('snapshots/:id/restore')
  async restoreSnapshot(@Param('guildId') guildId: string, @Param('id') id: string, @Req() req: Request) {
    await this.ensureAccess(guildId, req);
    try {
      await this.snapshots.startRestore(guildId, id);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    return { ok: true };
  }

  @Get('snapshots/restore/progress')
  @Header('Cache-Control', 'no-store')
  async restoreProgress(@Param('guildId') guildId: string, @Req() req: Request) {
    await this.ensureAccess(guildId, req);
    return this.snapshots.getRestoreProgress(guildId) ?? { status: 'idle' };
  }

  @Post('nuke-incidents/:id/restore')
  async restoreNuke(@Param('guildId') guildId: string, @Param('id') id: string, @Req() req: Request) {
    await this.ensureAccess(guildId, req);
    return this.actions.restoreStripped(guildId, id);
  }
}
