import { Injectable, Logger } from '@nestjs/common';
import { Context, On, Once } from 'necord';
import type { ContextOf } from 'necord';

@Injectable()
export class DiscordUpdate {
  private readonly logger = new Logger(DiscordUpdate.name);

  @Once('clientReady')
  onReady(@Context() [client]: ContextOf<'clientReady'>) {
    this.logger.log(`Bot logged in as ${client.user?.tag ?? 'unknown'}`);
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
