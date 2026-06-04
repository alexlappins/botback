import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';

import { StreamNotificationsService } from './stream-notifications.service';

/**
 * Twitch EventSub webhook receiver.
 *
 * Three message types arrive on the same URL — disambiguated by the
 * `Twitch-Eventsub-Message-Type` header:
 *   - `webhook_callback_verification` → we respond with the raw `challenge`
 *      string as plaintext + 200. That promotes the subscription from
 *      `webhook_callback_verification_pending` to `enabled`.
 *   - `notification` → forward the event to the notifier service. We must
 *      respond 2xx within 10 seconds or Twitch retries (up to 3 attempts).
 *   - `revocation` → log + 204. The subscription is gone server-side; the
 *      bootstrap reconciliation step recreates it.
 *
 * Security:
 *   1. HMAC-SHA256 signature verification on every request
 *      (header `Twitch-Eventsub-Message-Signature`, secret in env).
 *   2. Replay protection: reject if message timestamp older than 10 minutes.
 *   3. In-memory dedup ring of recent message ids — Twitch retries on missed
 *      acks and we don't want to double-fire notifications.
 *
 * Raw body: NestJS receives a Buffer here because we configured express.raw()
 * in main.ts for this exact path. The Buffer is what HMAC is computed over;
 * we parse it ourselves with JSON.parse() once the signature checks out.
 */
@Controller('api/twitch/webhook')
export class TwitchWebhookController {
  private readonly logger = new Logger(TwitchWebhookController.name);
  private readonly recentMessageIds = new Set<string>();
  private readonly recentMessageOrder: string[] = [];
  /** Max age of a Twitch message we'll accept (replay-attack guard). */
  private readonly maxMessageAgeMs = 10 * 60 * 1000;

  constructor(
    private readonly config: ConfigService,
    private readonly notifier: StreamNotificationsService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async handle(
    @Headers('twitch-eventsub-message-id') messageId: string | undefined,
    @Headers('twitch-eventsub-message-timestamp') timestamp: string | undefined,
    @Headers('twitch-eventsub-message-signature') signature: string | undefined,
    @Headers('twitch-eventsub-message-type') messageType: string | undefined,
    @Body() rawBody: Buffer,
  ): Promise<string | void> {
    const secret = this.config.get<string>('TWITCH_WEBHOOK_SECRET');
    if (!secret) {
      this.logger.error('TWITCH_WEBHOOK_SECRET not configured — refusing webhook');
      throw new BadRequestException('Webhook not configured');
    }
    if (!messageId || !timestamp || !signature || !messageType) {
      throw new BadRequestException('Missing Twitch EventSub headers');
    }
    if (!Buffer.isBuffer(rawBody)) {
      // If raw parsing wasn't wired up, NestJS will pass an empty object here.
      throw new BadRequestException('Raw body not available — check main.ts wiring');
    }

    // 1) Replay protection
    const messageAge = Date.now() - new Date(timestamp).getTime();
    if (!Number.isFinite(messageAge) || messageAge > this.maxMessageAgeMs || messageAge < -60_000) {
      this.logger.warn(`Rejecting stale webhook: messageAge=${messageAge}ms id=${messageId}`);
      throw new UnauthorizedException('Message timestamp out of window');
    }

    // 2) Signature verification — HMAC-SHA256 over (id + timestamp + raw_body)
    const expected =
      'sha256=' +
      createHmac('sha256', secret).update(messageId).update(timestamp).update(rawBody).digest('hex');
    if (!safeEqual(signature, expected)) {
      this.logger.warn(`Bad signature for message ${messageId}`);
      throw new UnauthorizedException('Invalid signature');
    }

    // 3) Dedup — Twitch retries on missed acks
    if (this.recentMessageIds.has(messageId)) {
      this.logger.debug(`Dedup: dropping retried message ${messageId}`);
      return;
    }
    this.rememberMessageId(messageId);

    // 4) Decode + route
    let payload: WebhookPayload;
    try {
      payload = JSON.parse(rawBody.toString('utf-8')) as WebhookPayload;
    } catch (e) {
      throw new BadRequestException(`Invalid JSON: ${(e as Error).message}`);
    }

    if (messageType === 'webhook_callback_verification') {
      // First request after subscription create. Answer 200 with the raw
      // challenge string — that promotes the sub to `enabled`.
      const challenge = payload.challenge;
      if (typeof challenge !== 'string') {
        throw new BadRequestException('Missing challenge');
      }
      this.logger.log(`Verification challenge for ${payload.subscription?.type}`);
      return challenge;
    }

    if (messageType === 'revocation') {
      this.logger.warn(
        `Subscription revoked: ${payload.subscription?.id} (${payload.subscription?.type}) reason=${payload.subscription?.status}`,
      );
      // Next bootstrap reconcile will notice the gap and recreate. No work here.
      return;
    }

    if (messageType === 'notification') {
      const subType = payload.subscription?.type;
      const event = payload.event ?? {};
      try {
        if (subType === 'stream.online') {
          await this.notifier.onStreamOnline({
            broadcasterUserId: String(event.broadcaster_user_id ?? ''),
            broadcasterUserLogin: String(event.broadcaster_user_login ?? ''),
            broadcasterUserName: String(event.broadcaster_user_name ?? ''),
            streamId: String(event.id ?? ''),
            streamType: String(event.type ?? 'live'),
            startedAt: String(event.started_at ?? new Date().toISOString()),
          });
        } else if (subType === 'stream.offline') {
          await this.notifier.onStreamOffline({
            broadcasterUserId: String(event.broadcaster_user_id ?? ''),
          });
        } else {
          this.logger.debug(`Unhandled subscription type: ${subType}`);
        }
      } catch (e) {
        // Re-throwing would make Twitch retry. We've already deduped the
        // message id, so a retry would be silently dropped. Log + 200.
        this.logger.error(
          `Notification handler crashed for ${subType}: ${(e as Error).message}`,
          (e as Error).stack,
        );
      }
      return;
    }

    this.logger.warn(`Unknown Twitch-Eventsub-Message-Type: ${messageType}`);
  }

  private rememberMessageId(id: string): void {
    this.recentMessageIds.add(id);
    this.recentMessageOrder.push(id);
    if (this.recentMessageOrder.length > 1000) {
      const drop = this.recentMessageOrder.shift();
      if (drop) this.recentMessageIds.delete(drop);
    }
  }
}

interface WebhookPayload {
  challenge?: string;
  subscription?: { id: string; type: string; status: string; condition: Record<string, string> };
  event?: Record<string, unknown>;
}

/** HMAC compare must be constant-time to avoid timing-attack leakage of the secret. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
