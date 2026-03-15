import { Controller, Get, Param, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';

@Controller()
export class DashboardController {
  private readonly frontendUrl: string;

  constructor(config: ConfigService) {
    this.frontendUrl = config.get<string>('FRONTEND_URL', 'http://localhost:5173');
  }

  /** Редирект на фронт: список серверов. */
  @Get()
  index(@Res() res: Response) {
    const base = this.frontendUrl.replace(/\/$/, '');
    return res.redirect(302, base + '/');
  }

  /** Редирект на фронт: страница сервера. */
  @Get('dashboard/:guildId')
  guildPage(@Param('guildId') guildId: string, @Res() res: Response) {
    const base = this.frontendUrl.replace(/\/$/, '');
    return res.redirect(302, `${base}/dashboard/${guildId}`);
  }
}
