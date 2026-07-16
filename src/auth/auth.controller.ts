import { Controller, Get, Req, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthGuard } from '@nestjs/passport';
import type { Request, Response } from 'express';
import { DiscordAuthGuard } from './discord-auth.guard';
import { SessionGuard } from './session.guard';
import type { SessionUser } from './session.serializer';

@Controller('api/auth')
export class AuthController {
  constructor(private readonly config: ConfigService) {}

  @Get('discord')
  @UseGuards(DiscordAuthGuard)
  discordLogin() {
    // Passport redirects to Discord. ?returnTo=/path is stashed in the
    // session by DiscordAuthGuard and honoured by the callback below.
  }

  @Get('callback')
  @UseGuards(AuthGuard('discord'))
  discordCallback(@Req() req: Request, @Res() res: Response) {
    const frontendUrl = this.config.get<string>('FRONTEND_URL', 'http://localhost:5173');
    const session = req.session as { save: (cb: (err?: Error) => void) => void };
    // After OAuth: send admins straight to template management, regular
    // users straight to message templates (the shop is hidden until launch,
    // so landing on the public root would just show the marketing page).
    const user = req.user as SessionUser | undefined;
    // OAuth return rule (shop TZ-1 §0): land exactly where the user would
    // have been had they already been logged in when they clicked — e.g. an
    // interrupted Buy resumes checkout. Fallback: role-based landing page.
    const sess = req.session as unknown as Record<string, unknown>;
    const stashed = typeof sess.returnTo === 'string' ? sess.returnTo : null;
    delete sess.returnTo;
    const landingPath =
      stashed && stashed.startsWith('/') && !stashed.startsWith('//')
        ? stashed
        : user?.role === 'admin'
          ? '/server-templates'
          : '/server-messages';

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

        return res.redirect(`${frontendUrl}${landingPath}`);
      });
    });
  }

  @Get('me')
  @UseGuards(SessionGuard)
  me(@Req() req: Request) {
    const user = (req as Request & { user: SessionUser }).user;
    return {
      id: user.id,
      username: user.username,
      avatar: user.avatar,
      discriminator: user.discriminator,
      role: user.role,
    };
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
