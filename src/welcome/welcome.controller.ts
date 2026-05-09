import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Inject,
  NotFoundException,
  Param,
  Post,
  Put,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Client, TextChannel, ButtonStyle, AttachmentBuilder } from 'discord.js';

import { CustomerGuard } from '../auth/customer.guard';
import { SessionGuard } from '../auth/session.guard';
import type { SessionUser } from '../auth/session.serializer';
import { GuildsService } from '../dashboard/guilds.service';

import { WelcomeService } from './welcome.service';
import type { WelcomeFormDto, GoodbyeFormDto, ImageFormFields } from './welcome.service';
import { resolveVariables, SUPPORTED_VARIABLES } from './variable-resolver';
import { ImageRendererService } from './image-renderer.service';
import type {
  AvatarConfig,
  ImageTextBlock,
  UsernameConfig,
} from './image-config.types';

interface PreviewImageBody extends ImageFormFields {
  /** Optional sample text to render in the imageTextConfig slot for preview only */
  sampleText?: string;
}

@Controller('api/guilds/:guildId')
@UseGuards(SessionGuard, CustomerGuard)
export class WelcomeController {
  constructor(
    @Inject(Client) private readonly client: Client,
    private readonly welcome: WelcomeService,
    private readonly renderer: ImageRendererService,
    private readonly guilds: GuildsService,
  ) {}

  private async ensureAccess(guildId: string, req: Request): Promise<void> {
    const user = (req as Request & { user: SessionUser }).user;
    const list = await this.guilds.getUserGuilds(user.accessToken, user.refreshToken);
    if (!list.some((g) => g.id === guildId)) {
      throw new UnauthorizedException('No access to this guild');
    }
  }

  // ── Welcome ────────────────────────────────────────────

  @Get('welcome')
  async getWelcome(@Param('guildId') guildId: string, @Req() req: Request) {
    await this.ensureAccess(guildId, req);
    const cfg = await this.welcome.getWelcome(guildId);
    return { ...cfg, variables: SUPPORTED_VARIABLES };
  }

  @Put('welcome')
  async updateWelcome(
    @Param('guildId') guildId: string,
    @Body() body: WelcomeFormDto,
    @Req() req: Request,
  ) {
    await this.ensureAccess(guildId, req);
    return this.welcome.updateWelcome(guildId, body);
  }

  @Post('welcome/test')
  async testWelcome(@Param('guildId') guildId: string, @Req() req: Request) {
    await this.ensureAccess(guildId, req);
    const user = (req as Request & { user: SessionUser }).user;
    const cfg = await this.welcome.getWelcome(guildId);

    const guild =
      this.client.guilds.cache.get(guildId) ??
      (await this.client.guilds.fetch(guildId).catch(() => null));
    if (!guild) throw new NotFoundException('Guild not found');

    const member =
      guild.members.cache.get(user.id) ??
      (await guild.members.fetch(user.id).catch(() => null));
    if (!member) {
      throw new BadRequestException('You must be a member of the guild to test');
    }

    const text = this.welcome.pickWelcomeText(cfg);
    const resolved = text ? resolveVariables(text, { user: member.user, member, guild }) : '';

    const components = buildLinkButtons(cfg.buttonsConfig);
    const files: AttachmentBuilder[] = [];
    if (cfg.imageEnabled) {
      const buf = await this.renderer.render(
        {
          backgroundImageUrl: cfg.backgroundImageUrl,
          backgroundFill: cfg.backgroundFill,
          avatarConfig: cfg.avatarConfig,
          usernameConfig: cfg.usernameConfig,
          imageTextConfig: cfg.imageTextConfig,
        },
        { user: member.user, member, guild },
      );
      if (buf) files.push(new AttachmentBuilder(buf, { name: 'welcome.png' }));
    }

    const messageContent = pickContentByMode(cfg.imageSendMode, resolved, files.length > 0);
    if (!messageContent && !files.length && !components.length) {
      throw new BadRequestException('Nothing to send — configure text or image first');
    }

    if (cfg.sendMode === 'dm') {
      try {
        await member.send({
          content: messageContent || undefined,
          components: components as never,
          files,
        });
      } catch (e) {
        throw new BadRequestException(
          `Failed to send DM: ${(e as Error).message}. The user may have DMs disabled.`,
        );
      }
    } else {
      if (!cfg.channelId) throw new BadRequestException('Welcome channel not selected');
      const channel = guild.channels.cache.get(cfg.channelId);
      if (!channel?.isTextBased()) {
        throw new BadRequestException('Configured channel is not a text channel');
      }
      await (channel as TextChannel).send({
        content: messageContent || undefined,
        components: components as never,
        files,
      });
    }
    return { ok: true, sent: resolved, withImage: files.length > 0 };
  }

  @Post('welcome/preview-image')
  @Header('Content-Type', 'image/png')
  @Header('Cache-Control', 'no-store')
  async previewWelcomeImage(
    @Param('guildId') guildId: string,
    @Body() body: PreviewImageBody,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.ensureAccess(guildId, req);
    const user = (req as Request & { user: SessionUser }).user;
    const guild =
      this.client.guilds.cache.get(guildId) ??
      (await this.client.guilds.fetch(guildId).catch(() => null));
    if (!guild) throw new NotFoundException('Guild not found');

    const member =
      guild.members.cache.get(user.id) ??
      (await guild.members.fetch(user.id).catch(() => null));

    const buf = await this.renderer.render(
      {
        backgroundImageUrl: body.backgroundImageUrl ?? null,
        backgroundFill: body.backgroundFill ?? null,
        avatarConfig: body.avatarConfig ?? null,
        usernameConfig: body.usernameConfig ?? null,
        imageTextConfig: applySampleTextOverride(body.imageTextConfig ?? null, body.sampleText),
      },
      {
        user: member?.user ?? (await this.client.users.fetch(user.id)),
        member,
        guild,
      },
    );
    if (!buf) throw new BadRequestException('Failed to render preview');
    res.end(buf);
  }

  // ── Goodbye ────────────────────────────────────────────

  @Get('goodbye')
  async getGoodbye(@Param('guildId') guildId: string, @Req() req: Request) {
    await this.ensureAccess(guildId, req);
    const cfg = await this.welcome.getGoodbye(guildId);
    return { ...cfg, variables: SUPPORTED_VARIABLES };
  }

  @Put('goodbye')
  async updateGoodbye(
    @Param('guildId') guildId: string,
    @Body() body: GoodbyeFormDto,
    @Req() req: Request,
  ) {
    await this.ensureAccess(guildId, req);
    return this.welcome.updateGoodbye(guildId, body);
  }

  @Post('goodbye/test')
  async testGoodbye(@Param('guildId') guildId: string, @Req() req: Request) {
    await this.ensureAccess(guildId, req);
    const user = (req as Request & { user: SessionUser }).user;
    const cfg = await this.welcome.getGoodbye(guildId);

    const guild =
      this.client.guilds.cache.get(guildId) ??
      (await this.client.guilds.fetch(guildId).catch(() => null));
    if (!guild) throw new NotFoundException('Guild not found');
    if (!cfg.channelId) throw new BadRequestException('Goodbye channel not selected');
    const channel = guild.channels.cache.get(cfg.channelId);
    if (!channel?.isTextBased()) {
      throw new BadRequestException('Configured channel is not a text channel');
    }

    const member =
      guild.members.cache.get(user.id) ??
      (await guild.members.fetch(user.id).catch(() => null));
    const userObj = member?.user ?? (await this.client.users.fetch(user.id));

    const text = this.welcome.pickGoodbyeText(cfg);
    const resolved = text ? resolveVariables(text, { user: userObj, member, guild }) : '';

    const files: AttachmentBuilder[] = [];
    if (cfg.imageEnabled) {
      const buf = await this.renderer.render(
        {
          backgroundImageUrl: cfg.backgroundImageUrl,
          backgroundFill: cfg.backgroundFill,
          avatarConfig: cfg.avatarConfig,
          usernameConfig: cfg.usernameConfig,
          imageTextConfig: cfg.imageTextConfig,
        },
        { user: userObj, member, guild },
      );
      if (buf) files.push(new AttachmentBuilder(buf, { name: 'goodbye.png' }));
    }

    const messageContent = pickContentByMode(cfg.imageSendMode, resolved, files.length > 0);
    if (!messageContent && !files.length) {
      throw new BadRequestException('Nothing to send — configure text or image first');
    }
    await (channel as TextChannel).send({ content: messageContent || undefined, files });
    return { ok: true, sent: resolved, withImage: files.length > 0 };
  }

  @Post('goodbye/preview-image')
  @Header('Content-Type', 'image/png')
  @Header('Cache-Control', 'no-store')
  async previewGoodbyeImage(
    @Param('guildId') guildId: string,
    @Body() body: PreviewImageBody,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    return this.previewWelcomeImage(guildId, body, req, res);
  }
}

function buildLinkButtons(
  buttons: { label: string; url: string; emoji?: string | null }[] | null,
): unknown[] {
  if (!buttons || !buttons.length) return [];
  return [
    {
      type: 1,
      components: buttons.slice(0, 3).map((b) => ({
        type: 2,
        style: ButtonStyle.Link,
        label: b.label,
        url: b.url,
        ...(b.emoji ? { emoji: parseEmoji(b.emoji) } : {}),
      })),
    },
  ];
}

function parseEmoji(raw: string): { id?: string; name?: string; animated?: boolean } {
  const m = /^<(a?):([^:]+):(\d+)>$/.exec(raw.trim());
  if (m) return { animated: m[1] === 'a', name: m[2], id: m[3] };
  return { name: raw.trim() };
}

function pickContentByMode(
  mode: 'with_text' | 'before_text' | 'image_only' | undefined,
  text: string,
  hasImage: boolean,
): string {
  if (!hasImage) return text;
  if (mode === 'image_only') return '';
  // 'with_text' and 'before_text' both attach the text — Discord renders the image either way.
  return text;
}

function applySampleTextOverride(
  text: ImageTextBlock | null,
  sample?: string,
): ImageTextBlock | null {
  if (!text || !sample) return text;
  return { ...text, text: sample };
}

export type { AvatarConfig, ImageTextBlock, UsernameConfig };
