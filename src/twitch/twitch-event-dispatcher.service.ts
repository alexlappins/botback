import { Injectable, Logger } from '@nestjs/common';

export type TwitchEventHandler = (
  event: Record<string, unknown>,
  subscription: { id: string; type: string; condition: Record<string, string> },
) => Promise<void> | void;

/**
 * EventSub dispatcher (TZ-A §0.1): ONE webhook intake → routing by event
 * type → any number of subscribers (live notifications, Live Role, Stream
 * Shield, Event Alerts, …). Handlers are isolated — one crashing never
 * blocks the others, and the webhook always acks in time.
 */
@Injectable()
export class TwitchEventDispatcher {
  private readonly logger = new Logger(TwitchEventDispatcher.name);
  private handlers = new Map<string, TwitchEventHandler[]>();

  on(type: string, handler: TwitchEventHandler): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }

  async dispatch(
    type: string,
    event: Record<string, unknown>,
    subscription: { id: string; type: string; condition: Record<string, string> },
  ): Promise<void> {
    const list = this.handlers.get(type);
    if (!list?.length) {
      this.logger.debug(`No subscribers for EventSub type ${type}`);
      return;
    }
    await Promise.all(
      list.map(async (h) => {
        try {
          await h(event, subscription);
        } catch (e) {
          this.logger.error(`Handler for ${type} crashed: ${(e as Error).message}`, (e as Error).stack);
        }
      }),
    );
  }
}
