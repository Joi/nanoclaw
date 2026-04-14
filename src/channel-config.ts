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
   *   active  — responds to every message (no trigger needed)
   *   mention — responds only when @jibot is mentioned
   *   intake  — silent listener; writes messages to confidential intake, never invokes agent
   *
   * Deprecated aliases still accepted in YAML (normalized on load):
   *   attentive → mention
   *   silent              → intake
   */
  listening_mode: 'active' | 'mention' | 'intake';
  /**
  * When true, messages are written to the confidential intake area
  * (derived from domains[0]) regardless of listening_mode.
  * This decouples "when does the agent respond" (listening_mode)
  * from "where do messages get filed" (confidential_intake).
  * Defaults to true for intake-mode channels with domains, false otherwise.
  */
  confidential_intake?: boolean;
  members: Record<string, { name: string; tier: string; person_ref?: string }>;
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

      // Normalise legacy mode names → canonical 3-mode vocabulary
      const modeRaw = String(parsed.listening_mode ?? '');
      if (modeRaw === 'attentive') {
        logger.warn({ file, was: modeRaw }, 'channel-config: deprecated mode, treating as "mention"');
        parsed.listening_mode = 'mention';
      } else if (modeRaw === 'silent') {
        logger.warn({ file }, 'channel-config: deprecated mode "silent", treating as "intake"');
        parsed.listening_mode = 'intake';
      } else if (!['active', 'mention', 'intake'].includes(modeRaw)) {
        logger.warn({ file, mode: modeRaw }, 'channel-config: unknown listening_mode, defaulting to "mention"');
        parsed.listening_mode = 'mention';
      }

      // Build JID key.
      // WhatsApp and Signal group JIDs are platform-native and stored in the DB as-is,
      // so we use channel_id directly as the lookup key.
      // All other platforms use the namespaced form: {platform}:{workspace}:channel:{id}.
      let jid: string;
      if (parsed.platform === 'whatsapp' || parsed.platform === 'signal') {
        jid = parsed.channel_id;
      } else {
        const ns = parsed.workspace ? `${parsed.platform}:${parsed.workspace}` : parsed.platform;
        jid = `${ns}:channel:${parsed.channel_id}`;
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
): 'active' | 'mention' | 'intake' | null {
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
