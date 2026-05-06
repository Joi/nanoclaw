/**
 * Discord channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 */
import { createDiscordAdapter } from '@chat-adapter/discord';

import { readEnvFile } from '../env.js';
import { createChatSdkBridge, type ReplyContext } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractReplyContext(raw: Record<string, any>): ReplyContext | null {
  if (!raw.referenced_message) return null;
  const reply = raw.referenced_message;
  return {
    text: reply.content || '',
    sender: reply.author?.global_name || reply.author?.username || 'Unknown',
  };
}

registerChannelAdapter('discord', {
  factory: () => {
    const env = readEnvFile(['DISCORD_BOT_TOKEN', 'DISCORD_PUBLIC_KEY', 'DISCORD_APPLICATION_ID']);
    if (!env.DISCORD_BOT_TOKEN) return null;
    const discordAdapter = createDiscordAdapter({
      botToken: env.DISCORD_BOT_TOKEN,
      publicKey: env.DISCORD_PUBLIC_KEY,
      applicationId: env.DISCORD_APPLICATION_ID,
    });
    // Disable auto-thread-on-mention. The chat-sdk Discord adapter has
    // hardcoded behavior at index.js:819 + index.js:1811 — when the bot is
    // mentioned in a non-thread message, it POSTs to
    // /channels/{id}/messages/{id}/threads to start a thread from the
    // user's message. Combined with supportsThreads=false (which makes
    // outbound replies land at channel root, matching 1.x), this leaves an
    // empty thread on every mentioned message. 1.x's hand-rolled
    // discord.ts never created threads. Override the private method to
    // return an empty object so both call sites set
    // `discordThreadId = result.id` to undefined and encodeThreadId
    // produces a channel-only id. No Discord API call, no empty thread.
    // Survives module updates because there is no public config knob;
    // revisit if @chat-adapter/discord adds one.
    (discordAdapter as unknown as { createDiscordThread: () => Promise<unknown> }).createDiscordThread =
      async () => ({});
    return createChatSdkBridge({
      adapter: discordAdapter,
      concurrency: 'concurrent',
      botToken: env.DISCORD_BOT_TOKEN,
      extractReplyContext,
      // Flatten threads to channel-root replies — matches 1.x's hand-rolled
      // discord.ts (sendMessage always posted via channel.send(), never into
      // an originating thread). Discord auto-thread channel settings (Posts
      // / Forum / per-message thread auto-create) otherwise turn every
      // jibot reply into a buried thread post; the active-mode quest
      // channels (jibot-discord-quest, web3-gairon) need replies in the
      // channel proper. supportsThreads=false makes routeInbound strip
      // threadId at entry, so all Discord traffic routes by channel only
      // and the outbound deliver lands at channel root.
      supportsThreads: false,
    });
  },
});
