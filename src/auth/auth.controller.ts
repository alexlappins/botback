import { Controller, Get, Req, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthGuard } from '@nestjs/passport';
import type { Request, Response } from 'express';
import { SessionGuard } from './session.guard';

@Controller('api/auth')
export class AuthController {
  constructor(private readonly config: ConfigService) {}

  @Get('discord')
  @UseGuards(AuthGuard('discord'))
  discordLogin() {
    // Passport redirects to Discord
  }

  @Get('callback')
  @UseGuards(AuthGuard('discord'))
  discordCallback(@Req() req: Request, @Res() res: Response) {
    const frontendUrl = this.config.get<string>('FRONTEND_URL', 'http://localhost:5173');
    const session = req.session as { save: (cb: (err?: Error) => void) => void };

    console.log('callback user:', req.user);
    console.log('before login sessionID:', req.sessionID);

    req.logIn(req.user as Express.User, (loginErr) => {
      if (loginErr) {
        console.error('req.logIn error:', loginErr);
        return res.status(500).json({ error: 'Login session failed' });
      }

      session.save((saveErr) => {
        if (saveErr) {
          console.error('session save error:', saveErr);
          return res.status(500).json({ error: 'Session save failed' });
        }

        console.log('after login sessionID:', req.sessionID);
        return res.redirect(frontendUrl);
      });
    });
  }

  @Get('me')
  @UseGuards(SessionGuard)
  me(@Req() req: Request) {
    console.log('me user:', req.user);
    console.log('me session:', req.session);
    console.log('me cookie header:', req.headers.cookie);
    return (req as Request & { user: unknown }).user;
  }

  @Get('logout')
  logout(@Req() req: Request, @Res() res: Response) {
    const frontendUrl = this.config.get<string>('FRONTEND_URL', '');
    req.logout((err) => {
      if (err) {
        res.status(500).json({ error: 'Logout failed' });
        return;
      }
      req.session.destroy(() => {
        res.redirect(frontendUrl || '/');
      });
    });
  }
}
