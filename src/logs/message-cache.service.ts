import { Injectable } from '@nestjs/common';
import { Message } from 'discord.js';

export interface CachedAttachment {
  name: string;
  url: string;
  proxyUrl: string;
  size: number;
  contentType: string | null;
}

export interface CachedMessage {
  id: string;
  channelId: string;
  authorId: string;
  authorTag: string;
  authorBot: boolean;
  content: string;
  attachments: CachedAttachment[];
  createdAt: number;
}

const PER_CHANNEL_LIMIT = Number(process.env.LOG_MESSAGE_CACHE_SIZE ?? 200); // TZ §1 preset 3, default 200
export const ATTACHMENT_MAX_BYTES = Number(process.env.LOG_ATTACHMENT_MAX_MB ?? 8) * 1024 * 1024;

/**
 * Ring buffer of the last N messages per channel (TZ §1 preset 3) so
 * delete/edit logs can show the original text and re-attach small files.
 * Bot messages are not cached (they're not logged either).
 */
@Injectable()
export class MessageCacheService {
  private byChannel = new Map<string, CachedMessage[]>();

  remember(message: Message): void {
    if (!message.guildId || message.author?.bot) return;
    const entry: CachedMessage = {
      id: message.id,
      channelId: message.channelId,
      authorId: message.author?.id ?? '',
      authorTag: message.author?.tag ?? 'Unknown',
      authorBot: Boolean(message.author?.bot),
      content: message.content ?? '',
      attachments: [...message.attachments.values()]
        .filter((a) => a.size <= ATTACHMENT_MAX_BYTES)
        .map((a) => ({
          name: a.name ?? 'file',
          url: a.url,
          proxyUrl: a.proxyURL,
          size: a.size,
          contentType: a.contentType ?? null,
        })),
      createdAt: Date.now(),
    };
    let ring = this.byChannel.get(message.channelId);
    if (!ring) {
      ring = [];
      this.byChannel.set(message.channelId, ring);
    }
    ring.push(entry);
    if (ring.length > PER_CHANNEL_LIMIT) ring.splice(0, ring.length - PER_CHANNEL_LIMIT);
  }

  get(channelId: string, messageId: string): CachedMessage | null {
    return this.byChannel.get(channelId)?.find((m) => m.id === messageId) ?? null;
  }

  forget(channelId: string): void {
    this.byChannel.delete(channelId);
  }
}
