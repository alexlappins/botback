import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import type { Profile } from 'passport-discord';
import { Strategy } from 'passport-discord';
import type { SessionUser } from './session.serializer';
import type { UserRole } from './user-role';

@Injectable()
export class DiscordStrategy extends PassportStrategy(Strategy, 'discord') {
  private readonly adminIds: Set<string>;

  constructor(config: ConfigService) {
    super({
      clientID: config.getOrThrow<string>('DISCORD_CLIENT_ID'),
      clientSecret: config.getOrThrow<string>('DISCORD_CLIENT_SECRET'),
      callbackURL: config.getOrThrow<string>('DISCORD_CALLBACK_URL'),
      scope: ['identify', 'guilds'],
    });
    const rawAdminIds = config.get<string>('ADMIN_DISCORD_IDS', '');
    this.adminIds = new Set(
      rawAdminIds
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    );
  }

  validate(
    accessToken: string,
    _refreshToken: string,
    profile: Profile,
  ): SessionUser {
    const role: UserRole = this.adminIds.has(profile.id) ? 'admin' : 'customer';
    return {
      id: profile.id,
      username: profile.username ?? '',
      avatar: profile.avatar ?? null,
      discriminator: (profile as { discriminator?: string }).discriminator ?? '0',
      accessToken,
      role,
    };
  }
}
