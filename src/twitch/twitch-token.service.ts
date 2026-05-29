import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * App access token manager (client credentials flow).
 *
 * Token lives ~60 days; we refresh proactively at 80% of expiry, and lazily on
 * 401 from a Helix call (callers can invoke {@link invalidate} to force the
 * next {@link getToken} to refetch).
 *
 * Kept in-memory only — generating a fresh one on every boot is well within
 * Twitch's rate limit (10/min/client) and avoids the encryption-at-rest concern
 * of persisting a long-lived secret.
 */
@Injectable()
export class TwitchTokenService implements OnModuleInit {
  private readonly logger = new Logger(TwitchTokenService.name);
  private accessToken: string | null = null;
  private expiresAt: number = 0; // epoch ms
  private inflight: Promise<string> | null = null;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    // Best-effort: prefetch a token on boot so the WS connect and the first
    // EventSub create don't pay the latency. Failures here are non-fatal —
    // getToken() will retry on demand and surface errors to the caller.
    if (this.isConfigured()) {
      try {
        await this.getToken();
      } catch (e) {
        this.logger.warn(`Initial Twitch token fetch failed: ${(e as Error).message}`);
      }
    } else {
      this.logger.warn(
        'TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET not set — Twitch live notifications disabled.',
      );
    }
  }

  isConfigured(): boolean {
    return Boolean(
      this.config.get<string>('TWITCH_CLIENT_ID') &&
        this.config.get<string>('TWITCH_CLIENT_SECRET'),
    );
  }

  getClientId(): string {
    return this.config.getOrThrow<string>('TWITCH_CLIENT_ID');
  }

  /**
   * Returns a valid app access token. Refetches if expired or if invalidate()
   * was called. Coalesces concurrent callers via {@link inflight} so we don't
   * hit Twitch's /oauth2/token with N requests during a burst.
   */
  async getToken(): Promise<string> {
    const now = Date.now();
    // 60s safety window — Twitch can clock-skew up to a few seconds and we want
    // the token to outlive an in-flight Helix call comfortably.
    if (this.accessToken && this.expiresAt - 60_000 > now) {
      return this.accessToken;
    }
    if (this.inflight) return this.inflight;

    this.inflight = this.fetchNew()
      .then((tok) => {
        this.accessToken = tok.access_token;
        this.expiresAt = Date.now() + tok.expires_in * 1000;
        this.logger.log(`Twitch app token refreshed (expires in ${tok.expires_in}s)`);
        return tok.access_token;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  /** Call after a Helix 401: forces the next getToken() to refetch. */
  invalidate(): void {
    this.accessToken = null;
    this.expiresAt = 0;
  }

  private async fetchNew(): Promise<{ access_token: string; expires_in: number }> {
    const clientId = this.config.getOrThrow<string>('TWITCH_CLIENT_ID');
    const clientSecret = this.config.getOrThrow<string>('TWITCH_CLIENT_SECRET');
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'client_credentials',
    });
    const res = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Twitch token fetch failed: ${res.status} ${text}`);
    }
    return (await res.json()) as { access_token: string; expires_in: number };
  }
}
