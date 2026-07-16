import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { Request } from 'express';

/**
 * Discord OAuth entry guard with a "return to where you were" contract
 * (shop TZ-1 §0): `/api/auth/discord?returnTo=/shop/slug?buy=1` stashes the
 * path in the session BEFORE redirecting to Discord; the callback then lands
 * the user exactly there — e.g. straight back into an interrupted Buy click.
 *
 * Only same-site relative paths are accepted — anything else is dropped so
 * the parameter can't be abused as an open redirect.
 */
@Injectable()
export class DiscordAuthGuard extends AuthGuard('discord') {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const returnTo = (req.query?.returnTo ?? '').toString();
    if (returnTo.startsWith('/') && !returnTo.startsWith('//')) {
      (req.session as unknown as Record<string, unknown>).returnTo = returnTo;
    }
    return (await super.canActivate(context)) as boolean;
  }
}
