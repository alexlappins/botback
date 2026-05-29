import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Context, On, Once } from 'necord';
import type { ContextOf } from 'necord';

@Injectable()
export class DiscordUpdate {
  private readonly logger = new Logger(DiscordUpdate.name);

  constructor(private readonly config: ConfigService) {}

  @Once('clientReady')
  async onReady(@Context() [client]: ContextOf<'clientReady'>) {
    this.logger.log(`Bot logged in as ${client.user?.tag ?? 'unknown'}`);
    this.logger.log(`Connected to ${client.guilds.cache.size} guild(s)`);
    // Surface exactly how slash commands got registered — this is the #1 thing
    // to check when "commands don't appear". necord registers on startup only.
    await this.reportSlashCommands(client);
  }

  /**
   * Logs which slash commands are visible to Discord and in what scope:
   *   - GLOBAL: registered for every guild the bot is in (the production mode).
   *   - GUILD <id>: dev-mode registration (NecordModule `development` option),
   *     visible ONLY on that one guild. If a tester is on any other server they
   *     will see no commands at all — that's expected for dev mode.
   */
  private async reportSlashCommands(
    client: ContextOf<'clientReady'>[0],
  ): Promise<void> {
    try {
      const global = await client.application?.commands.fetch();
      const globalNames = global ? [...global.values()].map((c) => c.name) : [];
      this.logger.log(
        `Global slash commands (${globalNames.length}): ${globalNames.join(', ') || '— none —'}`,
      );

      const devGuildId = this.config.get<string>('DISCORD_GUILD_ID');
      if (devGuildId) {
        const guildCmds = await client.application?.commands
          .fetch({ guildId: devGuildId })
          .catch(() => null);
        const guildNames = guildCmds ? [...guildCmds.values()].map((c) => c.name) : [];
        this.logger.warn(
          `DISCORD_GUILD_ID is set → DEV MODE: commands register only to guild ${devGuildId}. ` +
            `Guild commands (${guildNames.length}): ${guildNames.join(', ') || '— none —'}. ` +
            `For production (commands on every client server) remove DISCORD_GUILD_ID and restart.`,
        );
      }
    } catch (e) {
      this.logger.warn(`Could not fetch registered commands: ${(e as Error).message}`);
    }
  }

  @On('warn')
  onWarn(@Context() [message]: ContextOf<'warn'>) {
    this.logger.warn(message);
  }

  @On('error')
  onError(@Context() [error]: ContextOf<'error'>) {
    this.logger.error(error);
  }
}
