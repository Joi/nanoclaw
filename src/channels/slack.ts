/**
 * Slack channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 *
 * Multi-workspace: registers a primary `slack` adapter from `SLACK_*` env
 * vars plus one adapter per namespace from `SLACK_<n>_*` (n=2..). Each
 * extra workspace registers under channelType `slack-<namespace>` with
 * its identity-index lookup scoped to that namespace. Tokens for the
 * extras are loaded lazily so missing creds for an extra workspace don't
 * keep the primary from starting.
 */
import { createSlackAdapter } from '@chat-adapter/slack';

import { readEnvFile } from '../env.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';
import { compactSlackMentions } from './slack-mentions.js';

interface SlackInstanceEnv {
  botToken: string;
  signingSecret?: string;
  appToken?: string;
}

function readSlackInstance(prefix: string): SlackInstanceEnv | null {
  const env = readEnvFile([`${prefix}BOT_TOKEN`, `${prefix}SIGNING_SECRET`, `${prefix}APP_TOKEN`]);
  const botToken = env[`${prefix}BOT_TOKEN`];
  if (!botToken) return null;
  return {
    botToken,
    signingSecret: env[`${prefix}SIGNING_SECRET`],
    appToken: env[`${prefix}APP_TOKEN`],
  };
}

function buildSlackBridge(creds: SlackInstanceEnv, channelType: string, namespace?: string) {
  // Socket mode (outbound WS) avoids needing a public webhook URL — matches
  // 1.x prod on jibotmac. Set SLACK_APP_TOKEN to enable; otherwise fall
  // back to webhook mode.
  const slackAdapter = createSlackAdapter({
    botToken: creds.botToken,
    signingSecret: creds.signingSecret,
    ...(creds.appToken ? { mode: 'socket' as const, appToken: creds.appToken } : {}),
  });
  const bridge = createChatSdkBridge({
    adapter: slackAdapter,
    channelType,
    concurrency: 'concurrent',
    // Flatten threads to channel-root replies — matches the same fix
    // applied to Discord earlier today (src/channels/discord.ts comment).
    // Slack's chat-sdk encodes every inbound's threadId as
    // `slack:CHANNEL:msgts`, even for top-level channel posts (msgts ==
    // thread_ts only when the message anchors a thread, but the SDK
    // forwards it either way). With supportsThreads=true the host
    // preserves the threadId and adapter.postMessage(thread_ts=msgts)
    // makes Slack create/append-to a thread off the user's message —
    // turning every reply into a buried thread. 1.x's hand-rolled Slack
    // posted to channel root via chat.postMessage(channel) without
    // thread_ts. supportsThreads=false here makes routeInbound strip
    // threadId at entry, so the outbound deliver lands at channel root.
    // The `Keep Slack messages brief; use threading for longer content`
    // guidance in personas still applies — the AGENT can opt INTO
    // threads with explicit content if it wants.
    supportsThreads: false,
    // Outgoing: rewrite @DisplayName → <@UXXXX> via the curated identity
    // index. 1.x parity for the Sean-Bonner-style multi-alias resolution
    // (commits ef171d6 + a3128a7). Without this the LLM's @PersonName
    // mentions render as plain text in Slack rather than tagged mentions.
    // Namespace-scoped so Workspace A doesn't resolve a Workspace B userId.
    transformOutboundText: (text) => compactSlackMentions(text, undefined, namespace),
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
}

// Primary workspace — channelType "slack". Mention rewrites are unscoped to
// preserve 1.x behavior on single-workspace deployments where the index has
// only one set of slack: entries.
registerChannelAdapter('slack', {
  factory: () => {
    const creds = readSlackInstance('SLACK_');
    if (!creds) return null;
    return buildSlackBridge(creds, 'slack');
  },
});

// Extra workspaces — SLACK_2_*, SLACK_3_*, … each requires a *_NAMESPACE
// entry that becomes the channelType suffix (e.g. slack-cit). Loop runs at
// import time, so adding a fifth workspace is an env-var change.
const EXTRA_INSTANCES = [2, 3, 4, 5, 6];
for (const n of EXTRA_INSTANCES) {
  const prefix = `SLACK_${n}_`;
  const namespace = readEnvFile([`${prefix}NAMESPACE`])[`${prefix}NAMESPACE`];
  if (!namespace) continue;
  const channelType = `slack-${namespace}`;
  registerChannelAdapter(channelType, {
    factory: () => {
      const creds = readSlackInstance(prefix);
      if (!creds) return null;
      return buildSlackBridge(creds, channelType, namespace);
    },
  });
}
