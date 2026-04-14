/**
 * Channel Config Reader for NanoClaw
 * Reads YAML channel configs from ops/jibot/channels/ and provides
 * floor-level and domain-grant lookups for access control decisions.
 */
import fs from 'fs';
import path from 'path';
import YAML from 'yaml';

import { logger } from './logger.js';

export interface ChannelConfig {
  platform: string;
  workspace: string;
  channel_id: string;
  channel_name: string;
  floor: 'owner' | 'admin' | 'staff' | 'guest';
  domains: string[];
  /**
   * How jibot engages with this channel:
   *   active    — responds to every message (no trigger needed)
   *   attentive — responds only when @jibot is mentioned, ingests all messages
   *   silent    — never responds, never ingests (use with access.intake for filing)
   */
  listening_mode: 'active' | 'attentive' | 'silent';

  /**
   * Access flags (replaces DB registered_groups flags).
   * Populated from YAML, applied to DB on startup.
   */
  access: {
    reminders: boolean;
    bookmarks: boolean;
    email: boolean;
    calendar: boolean;
    file_serving: boolean;
    intake: boolean;
  };

  /**
   * Sender policy (replaces sender-allowlist per-chat mode).
   *   allow   — messages pass through (default)
   *   trigger — messages pass but sender must be on allowlist
   *   drop    — block all messages for this channel
   */
  sender_policy: 'allow' | 'trigger' | 'drop';

  /** Legacy field, still accepted in YAML. Use access.intake instead. */
  confidential_intake?: boolean;
  members: Record<string, { tier: string; person_ref?: string }>;
}

/** Port mapping for access-tiered QMD MCP services */
export const QMD_PORTS: Record<string, number> = {
  public: 7333,
  crm: 7334,
  'domain-gidc': 7335,
  'domain-sankosh': 7336,
  'domain-bhutan': 7337,
  'domain-gmc': 7338,
  'domain-wikipedia': 7339,
} as const;

/** Map from confidential/{slug} path to QMD index name */
function domainToIndexName(domain: string): string | null {
  const match = domain.match(/^confidential\/(.+)$/);
  if (!match) return null;
  return `domain-${match[1]}`;
}

/**
 * Load all channel configs from a directory of YAML files.
 * Returns a Map keyed by channel JID (e.g., "slack:gidc:channel:C12345678").
 */
export function loadChannelConfigs(
  configDir: string,
): Map<string, ChannelConfig> {
  const configs = new Map<string, ChannelConfig>();

  let files: string[];
  try {
    files = fs.readdirSync(configDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
  } catch {
    logger.warn({ configDir }, 'channel-config: cannot read config directory');
    return configs;
  }

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(configDir, file), 'utf-8');
      const parsed = YAML.parse(raw) as ChannelConfig;

      if (!parsed.platform || !parsed.channel_id) {
        logger.warn({ file }, 'channel-config: skipping (missing platform or channel_id)');
        continue;
      }

      // Validate listening_mode
      const modeRaw = String(parsed.listening_mode ?? 'attentive');
      if (!['active', 'attentive', 'silent'].includes(modeRaw)) {
        logger.warn({ file, mode: modeRaw }, 'channel-config: unknown listening_mode, defaulting to "attentive"');
        parsed.listening_mode = 'attentive';
      }

      // Apply access defaults
      if (!parsed.access) {
        parsed.access = {
          reminders: false,
          bookmarks: false,
          email: false,
          calendar: false,
          file_serving: false,
          intake: parsed.confidential_intake ?? (parsed.domains?.length > 0),
        };
      }

      // Apply sender_policy default
      if (!parsed.sender_policy) {
        parsed.sender_policy = 'allow';
      }

      // Build JID key.
      // Each platform's channel module uses a specific JID format for inbound messages.
      // The YAML channel_id can be either the full JID or a bare platform-native ID.
      // If bare, we auto-construct the correct JID using the platform's format.
      //
      // Platform JID formats (from channel modules):
      //   WhatsApp/Signal: platform-native JID used as-is (e.g., "120363...@g.us", "sig:group:...")
      //   Discord: "dc:{guildId}:{channelId}" or "dc:dm:{userId}" (discord.ts L52-54)
      //   Telegram: "tg:{chatId}" (telegram relay)
      //   Slack: "slack:{workspace}:{userId}" (DM) or "slack:{workspace}:channel:{channelId}"
      //   Email: "email:{address}"
      let jid: string;
      const cid = String(parsed.channel_id);
      if (
        // Already a full JID with known prefix — use as-is
        cid.startsWith('dc:') || cid.startsWith('tg:') ||
        cid.startsWith('sig:') || cid.startsWith('slack:') ||
        cid.startsWith('email:') || cid.includes('@')
      ) {
        jid = cid;
      } else if (parsed.platform === 'whatsapp' || parsed.platform === 'signal' || parsed.platform === 'email') {
        // These platforms use platform-native IDs directly
        jid = cid;
      } else if (parsed.platform === 'discord') {
        // Discord uses dc:{guildId}:{channelId}. Workspace = guildId.
        if (parsed.workspace) {
          jid = `dc:${parsed.workspace}:${cid}`;
        } else {
          logger.warn({ file, platform: parsed.platform }, 'channel-config: Discord channel missing workspace (guild ID)');
          jid = `dc:${cid}`;
        }
      } else if (parsed.platform === 'telegram') {
        // Telegram uses tg:{chatId}
        jid = `tg:${cid}`;
      } else {
        // Slack and others: {platform}:{workspace}:channel:{id}
        const ns = parsed.workspace ? `${parsed.platform}:${parsed.workspace}` : parsed.platform;
        jid = `${ns}:channel:${cid}`;
      }
      configs.set(jid, parsed);

      logger.debug({ jid, floor: parsed.floor, mode: parsed.listening_mode, file }, 'channel-config: loaded');
    } catch (err) {
      logger.warn({ file, err }, 'channel-config: failed to parse');
    }
  }

  logger.info({ count: configs.size, configDir }, 'channel-config: loaded configs');
  return configs;
}

/**
 * Get channel config for a specific JID.
 */
export function getChannelConfig(
  jid: string,
  configs: Map<string, ChannelConfig>,
): ChannelConfig | null {
  return configs.get(jid) ?? null;
}

/**
 * Get the floor level for a channel.
 * Returns 'guest' for unknown channels (safe default).
 */
export function getFloorLevel(
  jid: string,
  configs: Map<string, ChannelConfig>,
): 'owner' | 'admin' | 'staff' | 'guest' {
  const config = configs.get(jid);
  return config?.floor ?? 'guest';
}

/**
 * Get the listening mode for a channel.
 * Returns null for unknown channels (caller uses DB requiresTrigger as fallback).
 */
export function getListeningMode(
  jid: string,
  configs: Map<string, ChannelConfig>,
): 'active' | 'attentive' | 'silent' | null {
  const config = configs.get(jid);
  return config?.listening_mode ?? null;
}

/**
 * Get domain grants for a channel.
 * Returns empty array for unknown channels.
 */
export function getDomainGrants(
  jid: string,
  configs: Map<string, ChannelConfig>,
): string[] {
  const config = configs.get(jid);
  return config?.domains ?? [];
}

/**
 * Get the QMD MCP ports that should be mounted for a channel,
 * based on its floor level and domain grants.
 *
 * Returns a Record mapping index name to port number.
 */
export function getQmdPorts(
  jid: string,
  configs: Map<string, ChannelConfig>,
): Record<string, number> {
  const config = configs.get(jid);
  const ports: Record<string, number> = {};

  // Everyone gets public
  ports.public = QMD_PORTS.public;

  if (!config) return ports;

  const floor = config.floor;
  const isAdminOrOwner = floor === 'admin' || floor === 'owner';

  // Admin/Owner get CRM access
  if (isAdminOrOwner) {
    ports.crm = QMD_PORTS.crm;
  }

  // Add domain-specific ports based on grants
  for (const domain of config.domains) {
    const indexName = domainToIndexName(domain);
    if (indexName && QMD_PORTS[indexName]) {
      ports[indexName] = QMD_PORTS[indexName];
    }
  }

  return ports;
}


/**
 * Get access flags for a channel.
 * Returns all-false defaults for unknown channels.
 */
export function getAccessFlags(
  jid: string,
  configs: Map<string, ChannelConfig>,
): ChannelConfig['access'] {
  const config = configs.get(jid);
  return config?.access ?? {
    reminders: false,
    bookmarks: false,
    email: false,
    calendar: false,
    file_serving: false,
    intake: false,
  };
}

/**
 * Get sender policy for a channel.
 * Returns 'allow' for unknown channels (safe default).
 */
export function getSenderPolicy(
  jid: string,
  configs: Map<string, ChannelConfig>,
): 'allow' | 'trigger' | 'drop' {
  const config = configs.get(jid);
  return config?.sender_policy ?? 'allow';
}
