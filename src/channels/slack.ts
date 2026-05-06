/**
 * Slack channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 */
import { createSlackAdapter } from '@chat-adapter/slack';

import { readEnvFile } from '../env.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';
import { compactSlackMentions } from './slack-mentions.js';

registerChannelAdapter('slack', {
  factory: () => {
    const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET']);
    if (!env.SLACK_BOT_TOKEN) return null;
    const slackAdapter = createSlackAdapter({
      botToken: env.SLACK_BOT_TOKEN,
      signingSecret: env.SLACK_SIGNING_SECRET,
    });
    const bridge = createChatSdkBridge({
      adapter: slackAdapter,
      concurrency: 'concurrent',
      supportsThreads: true,
      // Outgoing: rewrite @DisplayName → <@UXXXX> via the curated identity
      // index. 1.x parity for the Sean-Bonner-style multi-alias resolution
      // (commits ef171d6 + a3128a7). Without this the LLM's @PersonName
      // mentions render as plain text in Slack rather than tagged mentions.
      transformOutboundText: compactSlackMentions,
    });
    bridge.resolveChannelName = async (platformId: string) => {
      try {
        const info = await slackAdapter.fetchThread(platformId);
        return (info as { channelName?: string }).channelName ?? null;
      } catch {
        return null;
      }
    };
    return bridge;
  },
});
