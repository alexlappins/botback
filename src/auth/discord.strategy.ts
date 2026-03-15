import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import type { Profile } from 'passport-discord';
import { Strategy } from 'passport-discord';
import type { SessionUser } from './session.serializer';

@Injectable()
export class DiscordStrategy extends PassportStrategy(Strategy, 'discord') {
  constructor(config: ConfigService) {
    super({
      clientID: config.getOrThrow<string>('DISCORD_CLIENT_ID'),
      clientSecret: config.getOrThrow<string>('DISCORD_CLIENT_SECRET'),
      callbackURL: config.getOrThrow<string>('DISCORD_CALLBACK_URL'),
      scope: ['identify', 'guilds'],
    });
  }

  validate(
    accessToken: string,
    _refreshToken: string,
    profile: Profile,
  ): SessionUser {
    return {
      id: profile.id,
      username: profile.username ?? '',
      avatar: profile.avatar ?? null,
      discriminator: (profile as { discriminator?: string }).discriminator ?? '0',
      accessToken,
    };
  }
}
