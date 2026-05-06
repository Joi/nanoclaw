import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';
import { loadUserIdentity, resolveUser } from './user-identity.js';
import { loadChannelConfigs, getChannelConfig, type ChannelConfig } from './channel-config.js';

export interface IntakeAttachment {
  originalFilename: string;
  savedPath: string;
}

export interface IntakeMessage {
  author: string;
  senderId?: string;  // stable JID like slack:gidc:U12345
  channelId: string;
  channelName: string;
  workstream: string;
  text: string;
  timestamp: string;
  attachments?: IntakeAttachment[];
  /** Frontmatter type field. Defaults to 'slack-intake'. */
  type?: string;
  /** Full source string for frontmatter. Defaults to "slack:gidc:channel:{channelId}". */
  source?: string;
}

/**
 * Replace @Name references with [[Name]] vault wikilinks for known identities.
 * Names are matched case-sensitively against the identity index and sorted by
 * length descending so "Joseph Jailer-Coley" matches before "Joseph".
 * Safe to call when the identity index is missing — returns text unchanged.
 */
export function wikiLinkMentions(text: string, identityIndexPath: string): string {
  let names: string[] = [];
  try {
    const raw = fs.readFileSync(identityIndexPath, 'utf-8');
    const index = JSON.parse(raw) as Record<string, { name?: string }>;
    const nameSet = new Set<string>();
    for (const entry of Object.values(index)) {
      if (typeof entry.name === "string" && entry.name) nameSet.add(entry.name);
    }
    names = [...nameSet];
  } catch {
    return text; // Index unavailable — return unchanged
  }

  if (names.length === 0) return text;

  // Sort by length descending so longer names match before shorter substrings
  names.sort((a, b) => b.length - a.length);

  let result = text;
  for (const name of names) {
    if (!name) continue;
    // Escape regex special characters in the name
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`@${escaped}\\b`, 'g');
    result = result.replace(regex, `[[${name}]]`);
  }

  return result;
}

/**
 * Write an intake markdown file for an inbound Slack message.
 * Creates the intake directory if needed, writes YAML frontmatter + body,
 * and returns the written file path.
 */
// Cached identity config and channel configs (loaded once per process)
let _identityCfg: ReturnType<typeof loadUserIdentity> | null = null;
let _channelCfgs: ReturnType<typeof loadChannelConfigs> | null = null;

function getIdentityConfig() {
  if (!_identityCfg) _identityCfg = loadUserIdentity();
  return _identityCfg;
}

function getChannelConfigs() {
  const cfgDir = path.join(process.env.HOME || "/Users/jibot", "switchboard", "ops", "jibot", "channels");
  if (!_channelCfgs) _channelCfgs = loadChannelConfigs(cfgDir);
  return _channelCfgs;
}

/** Invalidate cached configs (call when configs are reloaded). */
export function resetIntakeConfigCache(): void {
  _identityCfg = null;
  _channelCfgs = null;
}

export function writeIntakeFile(confidentialRoot: string, msg: IntakeMessage): string {
  // (1) Build intakeDir and create it
  const intakeDir = path.join(confidentialRoot, msg.workstream, 'intake');
  fs.mkdirSync(intakeDir, { recursive: true });

  // (2) Build safe filename: replace ':' with '-' in timestamp, lowercase author
  //     replacing non-alphanumeric chars with '-'
  const safeTimestamp = msg.timestamp.replace(/:/g, '-');
  const safeAuthor = msg.author.toLowerCase().replace(/[^a-z0-9]/g, '-');
  const filename = `${safeTimestamp}-${safeAuthor}.md`;
  const filePath = path.join(intakeDir, filename);

  // (3) Generate briefTopic from first ~60 chars of text or 'attachment upload'
  const briefTopic = msg.text ? msg.text.substring(0, 60) : 'attachment upload';

  // (4) Resolve sender_name from identity config (bare JID suffix matching)
  let senderName: string | undefined;
  if (msg.senderId) {
    const resolved = resolveUser(msg.senderId, getIdentityConfig());
    if (resolved) {
      senderName = resolved.name;
    }
  }

  // (5) Resolve channel_name from channel configs
  let channelName: string | undefined;
  const intakeSource = msg.source ?? `slack:gidc:channel:${msg.channelId}`;
  const channelCfg = getChannelConfig(intakeSource, getChannelConfigs());
  if (channelCfg) {
    channelName = (channelCfg as any).group_name || channelCfg.channel_name;
  }

  // (6) Build YAML frontmatter
  const intakeType = msg.type ?? 'slack-intake';
  const frontmatter = [
    '---',
    `type: ${intakeType}`,
    `source: "${intakeSource}"`,
    `author: "${msg.author}"`,
    ...(msg.senderId ? [`sender_id: "${msg.senderId}"`] : []),
    ...(senderName ? [`sender_name: "${senderName}"`] : []),
    ...(channelName ? [`channel_name: "${channelName}"`] : []),
    `date: "${msg.timestamp}"`,
    'classification: confidential',
    `workstream: "${msg.workstream}"`,
    `description: "${briefTopic.replace(/"/g, "'").replace(/\n/g, " ")}"`,
    '---',
  ].join('\n');

  // (5) Build body: apply wikilink mentions then append optional attachments
  const indexPath = path.join(
    process.env.HOME || '/Users/jibot',
    'switchboard', 'ops', 'jibot', 'identity-index.json',
  );
  let body = wikiLinkMentions(msg.text, indexPath);

  if (msg.attachments && msg.attachments.length > 0) {
    body += '\n\n## Attachments\n';
    for (const attachment of msg.attachments) {
      body += `\n- [${attachment.originalFilename}](${attachment.savedPath})`;
    }
  }

  const content = `${frontmatter}\n\n${body}`;

  // (6) Write file with utf-8
  fs.writeFileSync(filePath, content, 'utf-8');

  // (7) Log with logger.info
  logger.info(
    { filePath, author: msg.author, workstream: msg.workstream },
    'Wrote intake file',
  );

  // (8) Return filePath
  return filePath;
}
