import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Client, Guild } from 'discord.js';
import { On } from 'necord';

import { TemplateInstallService } from '../server-templates/template-install.service';
import { ServerTemplate } from '../server-templates/entities/server-template.entity';
import { PendingInstall } from './entities/pending-install.entity';
import { Purchase } from './entities/purchase.entity';
import { StoreTemplate } from './entities/store-template.entity';

const PENDING_TTL_MS = 24 * 60 * 60 * 1000; // §3: pending lives 24h

/**
 * Install flow for purchased servers (TZ-2 v2).
 *
 * A purchase installs ONLY onto a brand-new server the buyer creates from the
 * product's native Discord template. One purchase = one successful install,
 * but ATTEMPTS are unlimited: any failure re-arms the Install button. The
 * deploy itself runs in the background — closing the tab doesn't stop it.
 */
@Injectable()
export class InstallFlowService {
  private readonly logger = new Logger(InstallFlowService.name);

  constructor(
    @InjectRepository(PendingInstall)
    private readonly pendingRepo: Repository<PendingInstall>,
    @InjectRepository(Purchase)
    private readonly purchaseRepo: Repository<Purchase>,
    @InjectRepository(StoreTemplate)
    private readonly storeTemplateRepo: Repository<StoreTemplate>,
    @InjectRepository(ServerTemplate)
    private readonly serverTemplateRepo: Repository<ServerTemplate>,
    private readonly templateInstall: TemplateInstallService,
    private readonly config: ConfigService,
    @Inject(Client) private readonly client: Client,
  ) {}

  // ── Public API (called from the controller) ─────────────

  /**
   * Step 1 (TZ-2 §2): user pressed Install. Reuses a live pending if one
   * exists, otherwise creates a fresh waiting_server row.
   */
  async start(purchaseId: string, userId: string) {
    const purchase = await this.purchaseRepo.findOne({ where: { id: purchaseId, userId } });
    if (!purchase) throw new NotFoundException('Purchase not found');
    if (purchase.status !== 'paid') throw new BadRequestException('This purchase is not payable state');
    if (purchase.deployedGuildId) throw new BadRequestException('This purchase is already installed');

    let pending = await this.activePending(purchaseId);
    if (!pending) {
      pending = this.pendingRepo.create({
        purchaseId,
        discordUserId: userId,
        status: 'waiting_server',
      });
      await this.pendingRepo.save(pending);
    }
    return this.describe(pending, purchase);
  }

  /** Poll endpoint for the install page. */
  async getStatus(pendingId: string, userId: string) {
    const pending = await this.pendingRepo.findOne({ where: { id: pendingId, discordUserId: userId } });
    if (!pending) throw new NotFoundException('Install not found');
    await this.expireIfStale(pending);
    const purchase = await this.purchaseRepo.findOne({ where: { id: pending.purchaseId } });
    return this.describe(pending, purchase);
  }

  /**
   * Manual trigger "I've added the bot" (TZ-2 §2 step 3 safety net): scan the
   * bot's guilds for a fresh server owned by the buyer and start the deploy.
   */
  async trigger(pendingId: string, userId: string) {
    const pending = await this.pendingRepo.findOne({ where: { id: pendingId, discordUserId: userId } });
    if (!pending) throw new NotFoundException('Install not found');
    await this.expireIfStale(pending);
    if (pending.status === 'deploying') return this.getStatus(pendingId, userId);
    if (pending.status !== 'waiting_server') {
      throw new BadRequestException('This installation is not waiting for a server');
    }

    const guild = await this.findCandidateGuild(userId);
    if (!guild) {
      throw new BadRequestException(
        "Couldn't find a new server owned by you with the bot added. Make sure you created the server and added Level Up to it.",
      );
    }
    await this.beginDeploy(pending, guild);
    return this.getStatus(pendingId, userId);
  }

  // ── Autodetect (TZ-2 §2 step 3) ─────────────────────────

  @On('guildCreate')
  async onGuildCreate([guild]: [Guild]) {
    try {
      const pending = await this.pendingRepo.findOne({
        where: { discordUserId: guild.ownerId, status: 'waiting_server' },
        order: { createdAt: 'DESC' },
      });
      if (!pending) return;
      if (Date.now() - pending.createdAt.getTime() > PENDING_TTL_MS) return;
      // Deploy ONLY when the buyer owns the guild (§4) — matched by ownerId above.
      this.logger.log(`Autodetected new guild ${guild.id} for pending install ${pending.id}`);
      await this.beginDeploy(pending, guild);
    } catch (e) {
      this.logger.error(`guildCreate autodetect failed: ${(e as Error).message}`);
    }
  }

  // ── Internals ───────────────────────────────────────────

  private async activePending(purchaseId: string): Promise<PendingInstall | null> {
    const pending = await this.pendingRepo.findOne({
      where: { purchaseId, status: In(['waiting_server', 'deploying']) },
      order: { createdAt: 'DESC' },
    });
    if (!pending) return null;
    if (await this.expireIfStale(pending)) return null;
    return pending;
  }

  /** §3: waiting rows older than 24h flip to failed. Returns true if expired. */
  private async expireIfStale(pending: PendingInstall): Promise<boolean> {
    if (pending.status !== 'waiting_server') return false;
    if (Date.now() - pending.createdAt.getTime() <= PENDING_TTL_MS) return false;
    pending.status = 'failed';
    pending.error = 'Installation expired (24h). Press Install to start again.';
    await this.pendingRepo.save(pending);
    return true;
  }

  /**
   * Manual-trigger fallback: newest guild owned by the user that the bot
   * joined recently and that isn't already someone's deployed purchase.
   */
  private async findCandidateGuild(userId: string): Promise<Guild | null> {
    const deployed = new Set(
      (await this.purchaseRepo.find({ where: {}, select: ['deployedGuildId'] }))
        .map((p) => p.deployedGuildId)
        .filter(Boolean) as string[],
    );
    const candidates = [...this.client.guilds.cache.values()]
      .filter((g) => g.ownerId === userId && !deployed.has(g.id))
      .filter((g) => {
        const joined = g.members.me?.joinedTimestamp ?? 0;
        return Date.now() - joined < 6 * 60 * 60 * 1000; // bot added within 6h
      })
      .sort((a, b) => (b.members.me?.joinedTimestamp ?? 0) - (a.members.me?.joinedTimestamp ?? 0));
    return candidates[0] ?? null;
  }

  /** Flip to deploying and run the actual install in the background. */
  private async beginDeploy(pending: PendingInstall, guild: Guild): Promise<void> {
    pending.status = 'deploying';
    pending.guildId = guild.id;
    pending.progress = 'preparing';
    pending.error = null;
    await this.pendingRepo.save(pending);

    // Fire-and-forget: the user may close the tab (§4) — progress persists in DB.
    void this.runDeploy(pending.id).catch((e) =>
      this.logger.error(`Deploy runner crashed for pending ${pending.id}: ${(e as Error).message}`),
    );
  }

  private async runDeploy(pendingId: string): Promise<void> {
    const started = Date.now();
    const pending = await this.pendingRepo.findOne({ where: { id: pendingId } });
    if (!pending || pending.status !== 'deploying' || !pending.guildId) return;
    const purchase = await this.purchaseRepo.findOne({ where: { id: pending.purchaseId } });
    if (!purchase) return;

    const setProgress = (step: string) => {
      void this.pendingRepo.update({ id: pendingId }, { progress: step }).catch(() => null);
    };

    try {
      const report = await this.templateInstall.install(pending.guildId, purchase.templateId, {
        levelingMode: 'overwrite',
        onProgress: setProgress,
      });

      if (!report.ok) {
        pending.status = 'failed';
        pending.error = report.error ?? report.errors?.[0] ?? 'Installation failed';
        await this.pendingRepo.save(pending);
        this.logger.warn(
          `Deploy FAILED user=${pending.discordUserId} guild=${pending.guildId} purchase=${purchase.id}: ${pending.error}`,
        );
        return;
      }

      await this.pendingRepo.update({ id: pendingId }, { progress: 'finishing' });
      purchase.deployedGuildId = pending.guildId;
      purchase.deployedAt = new Date();
      await this.purchaseRepo.save(purchase);
      pending.status = 'completed';
      pending.progress = 'done';
      await this.pendingRepo.save(pending);
      this.logger.log(
        `Deploy OK user=${pending.discordUserId} guild=${pending.guildId} purchase=${purchase.id} template=${purchase.templateId} took=${Math.round((Date.now() - started) / 1000)}s warnings=${report.warnings?.length ?? 0}`,
      );
    } catch (e) {
      pending.status = 'failed';
      pending.error = (e as Error).message || 'Installation failed';
      await this.pendingRepo.save(pending);
      this.logger.error(
        `Deploy CRASHED user=${pending.discordUserId} guild=${pending.guildId} purchase=${purchase.id}: ${pending.error}`,
      );
    }
  }

  /** Response shape for the install page. */
  private async describe(pending: PendingInstall, purchase: Purchase | null) {
    let discordTemplateUrl: string | null = null;
    let productName: string | null = null;
    if (purchase) {
      const [tpl, st] = await Promise.all([
        this.serverTemplateRepo.findOne({ where: { id: purchase.templateId } }),
        this.storeTemplateRepo.findOne({ where: { templateId: purchase.templateId } }),
      ]);
      discordTemplateUrl = tpl?.discordTemplateUrl ?? null;
      productName = st?.name ?? tpl?.name ?? null;
    }
    const guild = pending.guildId ? this.client.guilds.cache.get(pending.guildId) : null;
    const clientId = this.config.get<string>('DISCORD_CLIENT_ID', '');
    return {
      id: pending.id,
      purchaseId: pending.purchaseId,
      status: pending.status,
      progress: pending.progress,
      error: pending.error,
      guildId: pending.guildId,
      guildName: guild?.name ?? null,
      productName,
      discordTemplateUrl,
      botInviteUrl: clientId
        ? `https://discord.com/oauth2/authorize?client_id=${clientId}&scope=bot%20applications.commands&permissions=8`
        : null,
      createdAt: pending.createdAt,
    };
  }
}
