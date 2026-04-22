import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { NecordModule } from 'necord';
import { GatewayIntentBits, Partials } from 'discord.js';
import { DiscordUpdate } from './discord.update';

@Module({
  imports: [
    NecordModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        token: config.getOrThrow<string>('DISCORD_TOKEN'),
        // Привилегированные интенты нужно включить в Discord Developer Portal:
        // https://discord.com/developers/applications → твоё приложение → Bot → Privileged Gateway Intents
        // Включи: "Server Members Intent" и "Message Content Intent"
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMembers,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
          GatewayIntentBits.GuildMessageReactions,
          GatewayIntentBits.DirectMessages,
          GatewayIntentBits.GuildModeration,
          GatewayIntentBits.GuildEmojisAndStickers,
          // Нужен для счётчика "В сети" в ServerStats. Privileged — включить в Dev Portal:
          // https://discord.com/developers/applications/<APP_ID>/bot → Privileged Gateway Intents
          GatewayIntentBits.GuildPresences,
        ],
        partials: [Partials.Message, Partials.Reaction],
        development: config.get<string>('DISCORD_GUILD_ID')
          ? [config.get<string>('DISCORD_GUILD_ID')!]
          : false,
      }),
      inject: [ConfigService],
    }),
  ],
  providers: [DiscordUpdate],
})
export class DiscordModule {}
