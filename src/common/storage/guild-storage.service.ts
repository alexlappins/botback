import { Injectable } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface LogChannelsConfig {
  joinLeave?: string;
  messages?: string;
  moderation?: string;
  channel?: string;
  banKick?: string;
}

/** По messageId: маппинг emojiKey (unicode или "custom:id") → roleId */
export type ReactionRoleBindings = Record<string, Record<string, string>>;

/** messageId → channelId (для отображения в дашборде) */
export type ReactionRoleChannels = Record<string, string>;

export interface GuildConfig {
  logChannels?: LogChannelsConfig;
  /** Привязки "реакция на сообщение → роль" (эмодзи). По guild храним messageId -> { emojiKey -> roleId }. */
  reactionRoleBindings?: ReactionRoleBindings;
  /** Канал для каждого сообщения с привязками (messageId → channelId). */
  reactionRoleChannels?: ReactionRoleChannels;
}

const DATA_DIR = path.join(process.cwd(), 'data');
const FILE_PATH = path.join(DATA_DIR, 'guilds.json');

@Injectable()
export class GuildStorageService {
  private cache: Record<string, GuildConfig> = {};
  private loaded = false;

  private ensureLoaded(): void {
    if (this.loaded) return;
    try {
      if (fs.existsSync(FILE_PATH)) {
        const raw = fs.readFileSync(FILE_PATH, 'utf-8');
        this.cache = JSON.parse(raw) as Record<string, GuildConfig>;
      }
      this.loaded = true;
    } catch {
      this.cache = {};
      this.loaded = true;
    }
  }

  private save(): void {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(FILE_PATH, JSON.stringify(this.cache, null, 2), 'utf-8');
    } catch (e) {
      console.error('GuildStorage save failed:', e);
    }
  }

  getConfig(guildId: string): GuildConfig {
    this.ensureLoaded();
    return this.cache[guildId] ?? {};
  }

  setLogChannel(guildId: string, type: keyof LogChannelsConfig, channelId: string | null): void {
    this.ensureLoaded();
    if (!this.cache[guildId]) this.cache[guildId] = {};
    if (!this.cache[guildId].logChannels) this.cache[guildId].logChannels = {};
    if (channelId) {
      (this.cache[guildId].logChannels as Record<string, string>)[type] = channelId;
    } else {
      delete (this.cache[guildId].logChannels as Record<string, string>)[type];
    }
    this.save();
  }

  getLogChannel(guildId: string, type: keyof LogChannelsConfig): string | undefined {
    return this.getConfig(guildId).logChannels?.[type];
  }

  getReactionRoleBindings(guildId: string): ReactionRoleBindings {
    this.ensureLoaded();
    return this.cache[guildId]?.reactionRoleBindings ?? {};
  }

  setReactionRoleBinding(
    guildId: string,
    messageId: string,
    emojiKey: string,
    roleId: string,
  ): void {
    this.ensureLoaded();
    if (!this.cache[guildId]) this.cache[guildId] = {};
    if (!this.cache[guildId].reactionRoleBindings) this.cache[guildId].reactionRoleBindings = {};
    const bindings = this.cache[guildId].reactionRoleBindings!;
    if (!bindings[messageId]) bindings[messageId] = {};
    (bindings[messageId] as Record<string, string>)[emojiKey] = roleId;
    this.save();
  }

  setReactionRoleChannel(guildId: string, messageId: string, channelId: string): void {
    this.ensureLoaded();
    if (!this.cache[guildId]) this.cache[guildId] = {};
    if (!this.cache[guildId].reactionRoleChannels) this.cache[guildId].reactionRoleChannels = {};
    (this.cache[guildId].reactionRoleChannels as Record<string, string>)[messageId] = channelId;
    this.save();
  }

  getReactionRoleChannels(guildId: string): ReactionRoleChannels {
    this.ensureLoaded();
    return this.cache[guildId]?.reactionRoleChannels ?? {};
  }

  removeReactionRoleBinding(guildId: string, messageId: string, emojiKey: string): void {
    this.ensureLoaded();
    const bindings = this.cache[guildId]?.reactionRoleBindings?.[messageId];
    if (!bindings) return;
    delete (bindings as Record<string, string>)[emojiKey];
    if (Object.keys(bindings).length === 0) {
      delete (this.cache[guildId].reactionRoleBindings as Record<string, unknown>)[messageId];
      const channels = this.cache[guildId].reactionRoleChannels as Record<string, string> | undefined;
      if (channels) delete channels[messageId];
    }
    this.save();
  }
}
