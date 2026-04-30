import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import {
  ASSISTANT_NAME,
  CONFIDENTIAL_ROOT,
  DEFAULT_TRIGGER,
  getTriggerPattern,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAX_MESSAGES_PER_PROMPT,
  ONECLI_URL,
  POLL_INTERVAL,
  SIGNAL_ACCOUNT,
  SIGNAL_CLI_URL,
  SIGNAL_DEFAULT_TIER,
  SIGNAL_ONLY,
  SLACK_APP_TOKEN,
  SLACK_BOT_TOKEN,
  SLACK_SIGNING_SECRET,
  SLACK_2_APP_TOKEN,
  SLACK_2_BOT_TOKEN,
  SLACK_2_NAMESPACE,
  SLACK_2_SIGNING_SECRET,
  SLACK_3_APP_TOKEN,
  SLACK_3_BOT_TOKEN,
  SLACK_3_NAMESPACE,
  SLACK_3_SIGNING_SECRET,
  SLACK_4_APP_TOKEN,
  SLACK_4_BOT_TOKEN,
  SLACK_4_NAMESPACE,
  SLACK_4_SIGNING_SECRET,
  EMAIL_CHANNEL_ENABLED,
  EMAIL_INTAKE_ACCOUNT,
  TELEGRAM_BOT_TOKEN,
  DISCORD_BOT_TOKEN,
  LINE_CHANNEL_ACCESS_TOKEN,
  LINE_CHANNEL_SECRET,
  LINE_WEBHOOK_PORT,
  TELEGRAM_ONLY,
  TIMEZONE,
} from './config.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import { WhatsAppChannel } from './channels/whatsapp.js';
import { SignalChannel } from './channels/signal.js';
import { SlackChannel } from './channels/slack.js';
import { EmailChannel } from './channels/email.js';
import { TelegramChannel } from './channels/telegram.js';
import { DiscordChannel } from './channels/discord.js';
import { LineChannel } from './channels/line.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
} from './container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  deleteSession,
  getAllTasks,
  getLastBotMessageTimestamp,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  computePermittedScope,
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,

} from './user-identity.js';
import { startSessionCleanup } from './session-cleanup.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';
import { loadChannelConfigs, getQmdPorts, getListeningMode, getChannelConfig, getSenderPolicy, getAccessFlags,
} from './channel-config.js';
import { writeIntakeFile } from './intake.js';
import { shouldRunIntake } from './intake-routing.js';
import { parseGidcCommand } from './gidc-commands.js';
import { buildSenderContext } from './people-context.js';
import { checkModeration, logModerationEvent } from './moderation.js';
import YAML from 'yaml';
import { parseListeningModeCommand } from './listening-modes.js';
import {
  isRegistrationIntent,
  parseClaimedName,
  lookupIdentity,
  writeClaimFile,
} from './self-registration.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};

// Channel configs for floor-based access control (loaded in main())
const CHANNEL_CONFIGS_DIR = path.join(
  process.env.HOME || '/Users/jibot',
  'switchboard', 'ops', 'jibot', 'channels',
);
let channelConfigs = loadChannelConfigs(CHANNEL_CONFIGS_DIR);
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

let whatsapp: WhatsAppChannel | undefined;
const channels: Channel[] = [];
const queue = new GroupQueue();
// ── jibrain intake batching (Layer 1) ─────────────────────────────────
// Buffer messages per {channel:sender} and flush after a quiet window.
// Collapses multi-message bursts into a single intake file.
const JIBRAIN_HOOK = path.join(process.env.HOME || '/Users/jibot', 'scripts/nanoclaw-jibrain-hook.sh');
const QUIET_MS = 3 * 60 * 1000; // 3 min quiet window
const jibrainBatch = new Map<string, { msgs: string[]; timer: ReturnType<typeof setTimeout> }>();

function queueJibrainIntake(chatJid: string, sender: string, content: string): void {
  const key = `${chatJid}:${sender}`;
  let batch = jibrainBatch.get(key);
  if (!batch) {
    batch = { msgs: [], timer: null as any };
    jibrainBatch.set(key, batch);
  }
  batch.msgs.push(content);
  clearTimeout(batch.timer);
  batch.timer = setTimeout(() => {
    const merged = batch!.msgs.join('\n\n---\n\n');
    const ch = chatJid.split(':')[0] || 'unknown';
    // joi-sd4: pass channel_slug + capture_mode so the hook can route
    // lurker channels to a daily digest file instead of per-message files.
    const group = registeredGroups[chatJid];
    const channelSlug = group?.folder || 'unknown';
    const captureMode = group?.captureMode || 'standalone';
    execFile('/bin/bash', [
      JIBRAIN_HOOK, 'process', ch, sender, merged, channelSlug, captureMode,
    ], (err) => { if (err) logger.warn({ err }, 'jibrain hook failed'); });
    jibrainBatch.delete(key);
  }, QUIET_MS);
}


const onecli = new OneCLI({ url: ONECLI_URL });

function ensureOneCLIAgent(jid: string, group: RegisteredGroup): void {
  if (group.isMain) return;
  const identifier = group.folder.toLowerCase().replace(/_/g, '-');
  onecli.ensureAgent({ name: group.name, identifier }).then(
    (res) => {
      logger.info(
        { jid, identifier, created: res.created },
        'OneCLI agent ensured',
      );
    },
    (err) => {
      logger.debug(
        { jid, identifier, err: String(err) },
        'OneCLI agent ensure skipped',
      );
    },
  );
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

/**
 * Startup migration: fix trigger patterns that reference a stale ASSISTANT_NAME.
 * Groups registered under a previous name silently fail because their trigger
 * regex never matches messages transformed with the current name.
 */
function migrateStaleTriggersOnStartup(): void {
  const expectedTrigger = DEFAULT_TRIGGER;
  let migrated = 0;
  for (const [jid, group] of Object.entries(registeredGroups)) {
    if (
      group.trigger &&
      group.trigger.startsWith('@') &&
      group.trigger !== expectedTrigger &&
      group.trigger !== 'always'
    ) {
      logger.warn(
        { jid, oldTrigger: group.trigger, newTrigger: expectedTrigger },
        'Migrating stale trigger pattern to current ASSISTANT_NAME',
      );
      group.trigger = expectedTrigger;
      setRegisteredGroup(jid, group);
      migrated++;
    }
  }
  if (migrated > 0) {
    logger.info({ migrated }, 'Trigger pattern migration complete');
  }
}

/**
 * Return the message cursor for a group, recovering from the last bot reply
 * if lastAgentTimestamp is missing (new group, corrupted state, restart).
 */
function getOrRecoverCursor(chatJid: string): string {
  const existing = lastAgentTimestamp[chatJid];
  if (existing) return existing;

  const botTs = getLastBotMessageTimestamp(chatJid, ASSISTANT_NAME);
  if (botTs) {
    logger.info(
      { chatJid, recoveredFrom: botTs },
      'Recovered message cursor from last bot reply',
    );
    lastAgentTimestamp[chatJid] = botTs;
    saveState();
    return botTs;
  }
  return '';
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // Copy CLAUDE.md template into the new group folder so agents have
  // identity and instructions from the first run.  (Fixes #1391)
  const groupMdFile = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(groupMdFile)) {
    const templateFile = path.join(
      GROUPS_DIR,
      group.isMain ? 'main' : 'global',
      'CLAUDE.md',
    );
    if (fs.existsSync(templateFile)) {
      let content = fs.readFileSync(templateFile, 'utf-8');
      if (ASSISTANT_NAME !== 'jibot') {
        content = content.replace(/^# jibot$/m, `# ${ASSISTANT_NAME}`);
        content = content.replace(/You are jibot/g, `You are ${ASSISTANT_NAME}`);
      }
      fs.writeFileSync(groupMdFile, content);
      logger.info({ folder: group.folder }, 'Created CLAUDE.md from template');
    }
  }

  // Ensure a corresponding OneCLI agent exists (best-effort, non-blocking)
  ensureOneCLIAgent(jid, group);

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const missedMessages = getMessagesSince(
    chatJid,
    getOrRecoverCursor(chatJid),
    ASSISTANT_NAME,
    MAX_MESSAGES_PER_PROMPT,
  );

  if (missedMessages.length === 0) return true;

  // listening_mode from YAML channel config takes precedence over DB requiresTrigger.
  // intake  → silent listener only; never invoke agent (intake written on message receipt)
  // mention → trigger (@jibot mention) required
  // active  → no trigger required (invoke on all messages)
  // null    → fall back to DB requiresTrigger field
  const listeningMode = getListeningMode(chatJid, channelConfigs);
  if (listeningMode === 'silent') return true;

  const effectiveNeedsTrigger = listeningMode === 'active'
    ? false
    : listeningMode === 'attentive'
      ? true
      : !isMainGroup && group.requiresTrigger !== false;

  if (effectiveNeedsTrigger) {
    const triggerPattern = getTriggerPattern(group.trigger);
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        triggerPattern.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  // GIDC @jibot commands: handle mode and scan before running the agent
  if (chatJid.startsWith('slack:gidc:') && missedMessages.length === 1) {
    const msg = missedMessages[0];
    const cmd = parseGidcCommand(msg.content);
    if (cmd) {
      if (cmd.type === 'mode') {
        group.channelMode = cmd.value;
        setRegisteredGroup(chatJid, group);
        const modeDesc =
          cmd.value === 'listening'
            ? 'All messages will be captured as intake.'
            : 'Intake only runs on explicit command.';
        await channel.sendMessage(chatJid, `Mode set to ${cmd.value}. ${modeDesc}`);
        return true;
      }
      if (cmd.type === 'scan') {
        await channel.sendMessage(chatJid, 'Starting QMD re-index scan...');
        execFile('qmd', ['index', '--all'], (err) => {
          if (err) {
            channel.sendMessage(chatJid, `QMD scan failed: ${err.message}`).catch((e) => logger.warn({ chatJid, err: e }, 'Failed to send QMD scan error'));
          } else {
            channel.sendMessage(chatJid, 'QMD re-index scan complete.').catch(() => {});
          }
        });
        return true;
      }
    }
  }

  // Self-registration: detect "@jibot add me" / "@jibot I'm [Name]"
  // Also enforce: guests cannot DM jibot
  const identityIndexPath = path.join(
    process.env.HOME || '/Users/jibot',
    'switchboard', 'ops', 'jibot', 'identity-index.json',
  );
  if (missedMessages.length === 1) {
    const singleMsg = missedMessages[0];
    const isDm = !group.isMain && (chatJid.startsWith("line:") ? chatJid.startsWith("line:dm:") : chatJid.startsWith("dc:") ? chatJid.includes(":dm:") : (chatJid.startsWith("tg:") ? !chatJid.startsWith("tg:-") : (chatJid.includes(":D") || !chatJid.includes(":channel:"))));

    // Guest DM enforcement: unregistered users cannot DM jibot
    if (isDm) {
      const identity = lookupIdentity(singleMsg.sender, identityIndexPath);
      const isRegistered = identity && identity.tier !== 'guest';
      if (!isRegistered) {
        await channel.sendMessage(
          chatJid,
          "I can only have direct conversations with registered members. An admin can get you set up — try messaging in a channel first.",
        );
        return true;
      }
    }

    // Self-registration intent detection
    if (isRegistrationIntent(singleMsg.content)) {
      const existingIdentity = lookupIdentity(singleMsg.sender, identityIndexPath);
      if (existingIdentity && existingIdentity.tier !== 'guest') {
        // Already registered
        await channel.sendMessage(
          chatJid,
          `You're already registered as ${existingIdentity.name} (${existingIdentity.tier}). No action needed!`,
        );
        return true;
      }

      // Parse claimed name from message
      const claimedName = parseClaimedName(singleMsg.content);

      // Create claim file
      const claimsDir = path.join(
        process.env.HOME || '/Users/jibot',
        'switchboard', 'ops', 'jibot', 'claims',
      );
      const [platformPart, workspacePart, ...rest] = chatJid.split(':');
      const userId = singleMsg.sender.split(':').pop() || singleMsg.sender;

      writeClaimFile({
        platform: platformPart || 'unknown',
        workspace: workspacePart || 'unknown',
        user_id: userId,
        display_name: singleMsg.sender_name || 'Unknown',
        claimed_identity: claimedName,
        matched_people_file: null,
        platform_email: null,
        conversation_log: `User: ${singleMsg.content}`,
        channel: chatJid,
      }, claimsDir);

      const namePhrase = claimedName ? `, ${claimedName}` : '';
      await channel.sendMessage(
        chatJid,
        `Thanks${namePhrase}! I've logged a registration request for review. An admin or owner will confirm your identity and set up your access.`,
      );
      logger.info({ sender: singleMsg.sender, claimedName, chatJid }, '[self-registration] claim file created');
      return true;
    }
  }

  // Listening mode admin command: "@jibot set listening mode to X"
  // Any admin/owner can change the listening mode of a channel
  if (missedMessages.length === 1) {
    const singleMsg = missedMessages[0];
    const newMode = parseListeningModeCommand(singleMsg.content);
    if (newMode) {
      // Update the channel YAML config file directly
      const channelCfg = getChannelConfig(chatJid, channelConfigs);
      if (channelCfg) {
        const configDir = CHANNEL_CONFIGS_DIR;
        // Find the YAML file that matches this JID by reloading with filename tracking
        const files = fs.readdirSync(configDir).filter((f: string) => f.endsWith('.yaml') || f.endsWith('.yml'));
        for (const file of files) {
          try {
            const filePath = path.join(configDir, file);
            const raw = fs.readFileSync(filePath, 'utf-8');
            const parsed = YAML.parse(raw) as Record<string, unknown>;
            // Check if this config matches the chatJid (simple: channel_id in JID)
            const channelId = String(parsed.channel_id || '');
            if (chatJid.includes(channelId) && channelId.length > 4) {
              parsed.listening_mode = newMode;
              fs.writeFileSync(filePath, YAML.stringify(parsed));
              channelConfigs = loadChannelConfigs(CHANNEL_CONFIGS_DIR);
              await channel.sendMessage(chatJid, `Listening mode set to *${newMode}*.`);
              logger.info({ chatJid, newMode, file }, '[listening-mode] updated via admin command');
              return true;
            }
          } catch { /* skip files that fail to parse */ }
        }
      }
      // No matching config file - acknowledge but note it won't persist
      await channel.sendMessage(chatJid, `Listening mode set to *${newMode}* (in-memory only — no channel config file found).`);
      return true;
    }
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);

  // People-context enrichment: look up sender people pages via QMD
  const uniqueSenders = [...new Set(
    missedMessages
      .filter((m) => !m.is_from_me)
      .map((m) => m.sender_name)
      .filter(Boolean),
  )];
  const senderContext = await buildSenderContext(uniqueSenders);
  const enrichedPrompt = senderContext
    ? `${senderContext}

${prompt}`
    : prompt;

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(group, enrichedPrompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.length} chars`);

      // Suppress API error results — the SDK emits these as "successful" results
      // when its built-in retries are exhausted. Don't forward to the user;
      // instead let group-queue backoff retry the whole invocation.
      if (/^API Error: \d{3}\b/.test(text)) {
        logger.warn(
          { group: group.name },
          `Suppressing API error from user output: ${text.slice(0, 200)}`,
        );
        hadError = true;
        return;
      }

      if (text) {
        await channel.sendMessage(chatJid, text);
        outputSentToUser = true;
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'success') {
      queue.notifyIdle(chatJid);
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script || undefined,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  const allowlistCfg = loadSenderAllowlist();
  const scope = computePermittedScope(chatJid, chatJid, allowlistCfg);
  const extraEnv: Record<string, string> = {};
  if (scope) {
    extraEnv.PERMITTED_WORKSTREAMS = scope.workstreams;
    extraEnv.PERMITTED_QMD_COLLECTIONS = scope.qmdCollections;
    extraEnv.PERMITTED_MOUNT_PATHS = scope.mountPaths;
    extraEnv.PERMITTED_WORKSTREAM_NAMES = scope.workstreamNames;
  }
  if (process.env.JIBOT_INTERNAL_SECRET) {
    extraEnv.JIBOT_INTERNAL_SECRET = process.env.JIBOT_INTERNAL_SECRET;
  }

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
        qmdPorts: getQmdPorts(chatJid, channelConfigs),
        extraEnv: Object.keys(extraEnv).length > 0 ? extraEnv : undefined,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      // Detect stale/corrupt session — clear it so the next retry starts fresh.
      // The session .jsonl can go missing after a crash mid-write, manual
      // deletion, or disk-full. The existing backoff in group-queue.ts
      // handles the retry; we just need to remove the broken session ID.
      const isStaleSession =
        sessionId &&
        output.error &&
        /no conversation found|ENOENT.*\.jsonl|session.*not found/i.test(
          output.error,
        );

      if (isStaleSession) {
        logger.warn(
          { group: group.name, staleSessionId: sessionId, error: output.error },
          'Stale session detected — clearing for next retry',
        );
        delete sessions[group.folder];
        deleteSession(group.folder);
      }

      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (default trigger: ${DEFAULT_TRIGGER})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;

          // listening_mode from YAML channel config takes precedence over DB requiresTrigger.
          // intake  → silent listener only; never invoke agent
          // mention → trigger (@jibot mention) required
          // active  → no trigger required
          // null    → fall back to DB requiresTrigger field
          const loopListeningMode = getListeningMode(chatJid, channelConfigs);
          if (loopListeningMode === 'silent') continue;

          const needsTrigger = loopListeningMode === 'active'
            ? false
            : loopListeningMode === 'attentive'
              ? true
              : !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const triggerPattern = getTriggerPattern(group.trigger);
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                triggerPattern.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            getOrRecoverCursor(chatJid),
            ASSISTANT_NAME,
            MAX_MESSAGES_PER_PROMPT,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const pending = getMessagesSince(
      chatJid,
      getOrRecoverCursor(chatJid),
      ASSISTANT_NAME,
      MAX_MESSAGES_PER_PROMPT,
    );
    if (pending.length > 0) {
      // Skip groups with no channel owner to avoid clogging the GroupQueue
      if (!findChannel(channels, chatJid)) {
        logger.debug({ group: group.name, chatJid }, 'Recovery: skipping (no channel owner)');
        continue;
      }
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

// --- Auto-register gate: deny-all catch-all for unknown contacts ---
interface AutoRegisterGate {
  enabled: boolean;
  mode: 'allowlist' | 'denylist';
  allowed: string[];
  notifyOwnerJid?: string;
  rejectionMessage: string;
}

const AUTO_REGISTER_GATE_PATH = path.join(
  process.env.HOME || '/Users/jibot',
  '.config',
  'nanoclaw',
  'auto-register-gate.json',
);

function loadAutoRegisterGate(): AutoRegisterGate | null {
  try {
    const raw = fs.readFileSync(AUTO_REGISTER_GATE_PATH, 'utf-8');
    const gate = JSON.parse(raw) as AutoRegisterGate;
    if (!gate.enabled) return null;
    return gate;
  } catch {
    return null; // No gate file = no restriction (backward compatible)
  }
}

function isAutoRegisterAllowed(chatJid: string): boolean {
  const gate = loadAutoRegisterGate();
  if (!gate) return true; // No gate = allow all (backward compatible)

  if (gate.mode === 'allowlist') {
    return gate.allowed.some((pattern) => chatJid.includes(pattern));
  }
  // denylist mode
  return !gate.allowed.some((pattern) => chatJid.includes(pattern));
}

function getGateRejectionMessage(): string {
  const gate = loadAutoRegisterGate();
  return gate?.rejectionMessage || 'I am not configured to chat with unknown contacts.';
}

function getGateNotifyOwnerJid(): string | undefined {
  const gate = loadAutoRegisterGate();
  return gate?.notifyOwnerJid;
}

/**
 * Auto-register a new Signal DM contact using the default tier template.
 * Creates a per-contact folder (sig-{phone}) with CLAUDE.md copied from the template.
 */
function autoRegisterSignalContact(chatJid: string, senderName: string): boolean {
  if (!SIGNAL_DEFAULT_TIER) return false;

  // Deny-all gate: check if this contact is approved for auto-registration
  if (!isAutoRegisterAllowed(chatJid)) {
    logger.warn(
      { chatJid, senderName },
      'Auto-registration DENIED by gate (not on allowlist)',
    );
    return false;
  }

  // Extract phone from JID (sig:+819048411965 -> 819048411965)
  const phone = chatJid.replace(/^sig:\+?/, '');
  const folder = `sig-${phone}`;
  const displayName = senderName || phone;

  // Check template folder exists
  const templateDir = path.join(GROUPS_DIR, SIGNAL_DEFAULT_TIER);
  const templateClaudeMd = path.join(templateDir, 'CLAUDE.md');
  if (!fs.existsSync(templateClaudeMd)) {
    logger.warn(
      { template: SIGNAL_DEFAULT_TIER, chatJid },
      'Signal default tier template CLAUDE.md not found, skipping auto-registration',
    );
    return false;
  }

  const group: RegisteredGroup = {
    name: displayName,
    folder,
    trigger: `@${ASSISTANT_NAME}`,
    added_at: new Date().toISOString(),
    requiresTrigger: true,
  };

  registerGroup(chatJid, group);

  // Copy CLAUDE.md from template
  const groupDir = path.join(GROUPS_DIR, folder);
  const destClaudeMd = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(destClaudeMd)) {
    fs.copyFileSync(templateClaudeMd, destClaudeMd);
  }

  logger.info(
    { chatJid, folder, template: SIGNAL_DEFAULT_TIER, senderName: displayName },
    'Auto-registered new Signal contact',
  );
  return true;
}

/**
 * Auto-register a new Slack DM or channel.
 * DMs use the Signal default tier template; channels get requiresTrigger: true.
 */
function autoRegisterSlackContact(chatJid: string, nameOrId: string, isGroup: boolean): boolean {
  if (!SIGNAL_DEFAULT_TIER) return false;

  // Deny-all gate: check if this contact is approved for auto-registration
  if (!isAutoRegisterAllowed(chatJid)) {
    logger.warn(
      { chatJid, nameOrId },
      'Auto-registration DENIED by gate (not on allowlist)',
    );
    return false;
  }

  const idPart = chatJid.replace(/^slack:(?:channel:)?/, '');
  const folder = `slack-${idPart}`;
  const displayName = nameOrId || idPart;

  // Check template folder exists
  const templateDir = path.join(GROUPS_DIR, SIGNAL_DEFAULT_TIER);
  const templateClaudeMd = path.join(templateDir, 'CLAUDE.md');
  if (!fs.existsSync(templateClaudeMd)) {
    logger.warn(
      { template: SIGNAL_DEFAULT_TIER, chatJid },
      'Default tier template CLAUDE.md not found, skipping Slack auto-registration',
    );
    return false;
  }

  const group: RegisteredGroup = {
    name: displayName,
    folder,
    trigger: `@${ASSISTANT_NAME}`,
    added_at: new Date().toISOString(),
    requiresTrigger: isGroup,
  };

  registerGroup(chatJid, group);

  // Copy CLAUDE.md from template
  const groupDir = path.join(GROUPS_DIR, folder);
  const destClaudeMd = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(destClaudeMd)) {
    fs.copyFileSync(templateClaudeMd, destClaudeMd);
  }

  logger.info(
    { chatJid, folder, template: SIGNAL_DEFAULT_TIER, name: displayName, isGroup },
    'Auto-registered new Slack contact',
  );
  return true;
}

/**
 * Log a startup summary of listening modes for all registered groups.
 * Groups with no YAML config fall back to DB requiresTrigger — these are flagged
 * as ungoverned so the operator knows to add a channel config.
 */

/**
 * Sync YAML channel configs → DB registered_groups on startup.
 * Ensures YAML is the single source of truth for group configuration.
 * New YAML configs get auto-registered; existing ones get access flags updated.
 */
function syncYamlToDb(): void {
  const ASSISTANT = process.env.ASSISTANT_NAME || 'jibot';
  let created = 0;
  let updated = 0;

  for (const [jid, config] of channelConfigs) {
    const existing = registeredGroups[jid];
    const access = getAccessFlags(jid, channelConfigs);
    const requiresTrigger = config.listening_mode !== 'active';
    const logTriggeredOnly = false; // silent mode still logs all messages for intake

    if (existing) {
      // Update access flags and listening-mode-derived fields from YAML
      const group: RegisteredGroup = {
        ...existing,
        requiresTrigger,
        logTriggeredOnly: logTriggeredOnly || undefined,
        remindersAccess: access.reminders || undefined,
        bookmarksAccess: access.bookmarks || undefined,
        emailAccess: access.email || undefined,
        calendarAccess: access.calendar || undefined,
        fileServingAccess: access.file_serving || undefined,
        intakeAccess: access.intake || undefined,
        captureMode: (config as any).capture_mode === 'digest' ? 'digest' : undefined,
      };
      setRegisteredGroup(jid, group);
      registeredGroups[jid] = group;
      updated++;
    } else {
      // Auto-register new YAML config
      const group: RegisteredGroup = {
        name: (config as any).group_name || config.channel_name,
        folder: config.channel_name,
        trigger: `@${ASSISTANT}`,
        added_at: new Date().toISOString(),
        requiresTrigger,
        logTriggeredOnly: logTriggeredOnly || undefined,
        remindersAccess: access.reminders || undefined,
        bookmarksAccess: access.bookmarks || undefined,
        emailAccess: access.email || undefined,
        calendarAccess: access.calendar || undefined,
        fileServingAccess: access.file_serving || undefined,
        intakeAccess: access.intake || undefined,
        captureMode: (config as any).capture_mode === 'digest' ? 'digest' : undefined,
      };
      try {
        setRegisteredGroup(jid, group);
        registeredGroups[jid] = group;
        created++;
        logger.info({ jid, folder: group.folder }, 'Auto-registered group from YAML config');
      } catch (err) {
        logger.warn({ jid, folder: group.folder, err }, 'Failed to auto-register group from YAML');
      }
    }
  }

  if (created > 0 || updated > 0) {
    logger.info({ created, updated }, 'YAML → DB sync complete');
  }
}

function validateListeningModes(): void {
  const ungoverned: string[] = [];

  for (const [jid, group] of Object.entries(registeredGroups)) {
    const mode = getListeningMode(jid, channelConfigs);
    if (mode) {
      logger.info(
        { jid, group: group.name, mode },
        'channel-config: listening mode',
      );
    } else {
      // No YAML config — effective mode derived from DB
      const effectiveMode = group.isMain
        ? 'active (main)'
        : group.requiresTrigger === false
          ? 'active (DB fallback)'
          : 'mention (DB fallback)';
      ungoverned.push(`  ${group.name} [${group.folder}] → ${effectiveMode}`);
    }
  }

  if (ungoverned.length > 0) {
    logger.warn(
      `channel-config: ${ungoverned.length} groups have no YAML config (add ops/jibot/channels/{platform}-{name}.yaml to govern):\n${ungoverned.join('\n')}`,
    );
  }
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();
  syncYamlToDb();
  migrateStaleTriggersOnStartup();
  validateListeningModes();

  // Start credential proxy for container API access
  const { startCredentialProxy } = await import('./credential-proxy.js');
  const CREDENTIAL_PROXY_PORT = 10254;
  try {
    await startCredentialProxy(CREDENTIAL_PROXY_PORT);
  } catch (err) {
    logger.warn({ err }, 'Failed to start credential proxy — containers may lack API access');
  }

  // Start Agent API server (HTTP endpoint for Zoom bot and other external callers)
  const { startAgentApi } = await import('./agent-api.js');
  startAgentApi();

  // Reload channel configs periodically (every 5 minutes) in case configs change via Syncthing
  setInterval(() => {
    channelConfigs = loadChannelConfigs(CHANNEL_CONFIGS_DIR);
  }, 300_000);

  // Ensure OneCLI agents exist for all registered groups.
  // Recovers from missed creates (e.g. OneCLI was down at registration time).
  for (const [jid, group] of Object.entries(registeredGroups)) {
    ensureOneCLIAgent(jid, group);
  }

  // Ensure email group has additionalMounts for ~/jibrain/intake
  for (const [jid, group] of Object.entries(registeredGroups)) {
    if (group.folder === 'email-joi') {
      const mounts = group.containerConfig?.additionalMounts || [];
      const hasIntake = mounts.some((m) => m.hostPath.includes('jibrain/intake'));
      if (!hasIntake) {
        group.containerConfig = {
          ...group.containerConfig,
          additionalMounts: [
            ...mounts,
            { hostPath: '~/jibrain/intake', readonly: false },
          ],
        };
        registeredGroups[jid] = group;
        setRegisteredGroup(jid, group);
        logger.info({ jid }, 'Added ~/jibrain/intake mount to email group');
      }
    }
  }

  restoreRemoteControl();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          getSenderPolicy(chatJid, channelConfigs) === 'drop' &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'channel-config: dropping message (sender_policy=drop)',
            );
          }
          return;
        }
      }

      // Moderation check: silently log blocked users, drop banned users
      if (!msg.is_from_me && !msg.is_bot_message) {
        const triageDir = path.join(
          process.env.HOME || '/Users/jibot',
          'switchboard', 'ops', 'jibot', 'triage',
        );
        const identityIndexPath = path.join(
          process.env.HOME || '/Users/jibot',
          'switchboard', 'ops', 'jibot', 'identity-index.json',
        );
        const modAction = checkModeration(msg.sender, identityIndexPath);
        if (modAction.type === 'block') {
          logModerationEvent('block', {
            timestamp: new Date().toISOString(),
            senderJid: msg.sender,
            chatJid,
            reason: 'blocked tier',
          }, triageDir);
          // Blocked: log silently, don't invoke agent
          return;
        }
        if (modAction.type === 'ban') {
          logModerationEvent('ban', {
            timestamp: new Date().toISOString(),
            senderJid: msg.sender,
            chatJid,
            reason: 'banned tier',
          }, triageDir);
          logger.warn({ senderJid: msg.sender, chatJid }, '[moderation] BANNED user message dropped');
          // TODO(ix8): Kick from channel via Slack API when scopes are available
          return;
        }
      }

      // logTriggeredOnly: skip storing non-trigger messages for noisy groups
      const grp = registeredGroups[chatJid];
      if (grp?.logTriggeredOnly && !msg.is_from_me && !msg.is_bot_message) {
        const trigPat = getTriggerPattern(grp.trigger);
        if (!trigPat.test(msg.content.trim())) {
          return; // don't store — saves DB space for high-volume groups
        }
      }

      storeMessage(msg);
      // Enqueue for agent processing (event-driven, supplements polling loop).
      if (registeredGroups[chatJid]) {
          logger.info({ chatJid }, "onMessage: enqueuing for agent processing");
          queue.enqueueMessageCheck(chatJid);
      } else {
          logger.warn({ chatJid }, "onMessage: NOT enqueuing (not in registeredGroups)");
      }

      // GIDC intake: write substantive messages to confidential workstream dirs
      if (
        !msg.is_from_me &&
        !msg.is_bot_message &&
        chatJid.startsWith('slack:gidc:') &&
        registeredGroups[chatJid]
      ) {
        const group = registeredGroups[chatJid];
        if (group.intakeAccess && shouldRunIntake(group.channelMode ?? 'listening', false)) {
          const workstream = group.folder.split('-')[0];
          if (!workstream || !fs.existsSync(path.join(CONFIDENTIAL_ROOT, workstream))) {
            logger.warn(
              { folder: group.folder, workstream, group: chatJid },
              'GIDC intake skipped: no matching workstream directory',
            );
          } else {
            const channelId = chatJid.split(':').pop() || '';
            const channelName = group.name;
            try {
              writeIntakeFile(CONFIDENTIAL_ROOT, {
                author: msg.sender_name,
                channelId,
                channelName,
                workstream,
                text: msg.content,
                timestamp: msg.timestamp,
              });
            } catch (err) {
              logger.warn({ err }, 'GIDC intake write failed');
            }
          }
        }
      }

      // Channel-config intake mode: write to confidential domain intake for
      // any non-GIDC channel configured with listening_mode: intake.
      if (!msg.is_from_me && !msg.is_bot_message) {
        const chCfg = getChannelConfig(chatJid, channelConfigs);
        // confidential_intake flag (explicit) takes precedence; defaults to true for intake-mode channels with domains
          const wantsIntake = chCfg?.confidential_intake !== undefined
            ? chCfg.confidential_intake
            : chCfg?.listening_mode === 'silent';
          if (wantsIntake && chCfg!.domains.length > 0) {
          const domain = chCfg!.domains[0];
          const workstream = domain.replace(/^confidential\//, '');
          if (workstream && fs.existsSync(path.join(CONFIDENTIAL_ROOT, workstream))) {
            try {
              writeIntakeFile(CONFIDENTIAL_ROOT, {
                author: msg.sender_name,
                senderId: msg.sender,
                channelId: chatJid,
                channelName: registeredGroups[chatJid]?.name ?? chatJid,
                workstream,
                text: msg.content,
                timestamp: msg.timestamp,
                type: `${chCfg!.platform}-intake`,
                source: chatJid,
              });
            } catch (err) {
              logger.warn({ err, chatJid }, 'intake-mode write failed');
            }
          }
        }
      }

      // jibrain intake: write substantive messages to Syncthing-synced jibrain
      // Skip channels that write to confidential intake (prevent leak to shared jibrain)
      const jbChCfg = getChannelConfig(chatJid, channelConfigs);
      const wantsConfIntake = jbChCfg?.confidential_intake !== undefined
        ? jbChCfg.confidential_intake
        : jbChCfg?.listening_mode === 'silent' && (jbChCfg?.domains?.length ?? 0) > 0;
      if (!wantsConfIntake && !msg.is_from_me && !msg.is_bot_message && msg.content.length >= 20) {
        queueJibrainIntake(chatJid, msg.sender, msg.content);
      }
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Signal channel (if configured)
  if (SIGNAL_ACCOUNT) {
    const signal = new SignalChannel({
      ...channelOpts,
      signalCliUrl: SIGNAL_CLI_URL,
      signalAccount: SIGNAL_ACCOUNT,
      botUuid: process.env.SIGNAL_BOT_UUID || '2e28a309-9ead-4cf4-9186-a5d133d50e70',
      onNewContact: SIGNAL_DEFAULT_TIER ? (chatJid: string, senderName: string) => {
        const registered = autoRegisterSignalContact(chatJid, senderName);
        if (!registered && !isAutoRegisterAllowed(chatJid)) {
          // Deny-all catch-all: send rejection + notify owner
          signal.sendMessage(chatJid, getGateRejectionMessage()).catch(() => {});
          const ownerJid = getGateNotifyOwnerJid();
          if (ownerJid) {
            signal.sendMessage(
              ownerJid,
              `[gate] Unknown contact tried to message: ${senderName} (${chatJid})`,
            ).catch(() => {});
          }
        }
        return registered;
      } : undefined,
    });
    channels.push(signal);
    try {
      await signal.connect();
      logger.info('Signal channel connected');
    } catch (err) {
      logger.error({ err }, 'Failed to connect Signal channel');
    }
  }

  // First Slack workspace (if configured)
  if (SLACK_BOT_TOKEN && SLACK_APP_TOKEN) {
    const slack = new SlackChannel({
      ...channelOpts,
      slackBotToken: SLACK_BOT_TOKEN,
      slackAppToken: SLACK_APP_TOKEN,
      slackSigningSecret: SLACK_SIGNING_SECRET,
      onNewContact: SIGNAL_DEFAULT_TIER ? (chatJid: string, nameOrId: string, isGroup: boolean) => {
        const registered = autoRegisterSlackContact(chatJid, nameOrId, isGroup);
        if (!registered && !isAutoRegisterAllowed(chatJid)) {
          logger.warn(
            { chatJid, nameOrId },
            'Slack contact rejected by auto-register gate',
          );
        }
        return registered;
      } : undefined,
    });
    channels.push(slack);
    try {
      await slack.connect();
      logger.info('Slack channel connected');
    } catch (err) {
      logger.error({ err }, 'Failed to connect Slack channel');
    }
  }

  // Second Slack workspace (if configured)
  if (SLACK_2_BOT_TOKEN && SLACK_2_APP_TOKEN && SLACK_2_NAMESPACE) {
    const slack2 = new SlackChannel({
      ...channelOpts,
      slackBotToken: SLACK_2_BOT_TOKEN,
      slackAppToken: SLACK_2_APP_TOKEN,
      slackSigningSecret: SLACK_2_SIGNING_SECRET,
      namespace: SLACK_2_NAMESPACE,
    });
    channels.push(slack2);
    try {
      await slack2.connect();
      logger.info({ namespace: SLACK_2_NAMESPACE }, 'Slack 2 channel connected');
    } catch (err) {
      logger.error({ err, namespace: SLACK_2_NAMESPACE }, 'Failed to connect Slack 2 channel');
    }
  }

  // Third Slack workspace — GIDC (if configured)
  // No onNewContact — contacts linked manually
  if (SLACK_3_BOT_TOKEN && SLACK_3_APP_TOKEN && SLACK_3_NAMESPACE) {
    const slack3 = new SlackChannel({
      ...channelOpts,
      slackBotToken: SLACK_3_BOT_TOKEN,
      slackAppToken: SLACK_3_APP_TOKEN,
      slackSigningSecret: SLACK_3_SIGNING_SECRET,
      namespace: SLACK_3_NAMESPACE,
    });
    channels.push(slack3);
    try {
      await slack3.connect();
      logger.info({ namespace: SLACK_3_NAMESPACE }, 'Slack 3 channel connected');
    } catch (err) {
      logger.error({ err, namespace: SLACK_3_NAMESPACE }, 'Failed to connect Slack 3 channel');
    }
  }

  // Fourth Slack workspace — joiito (if configured)
  if (SLACK_4_BOT_TOKEN && SLACK_4_APP_TOKEN && SLACK_4_NAMESPACE) {
    const slack4 = new SlackChannel({
      ...channelOpts,
      slackBotToken: SLACK_4_BOT_TOKEN,
      slackAppToken: SLACK_4_APP_TOKEN,
      slackSigningSecret: SLACK_4_SIGNING_SECRET,
      namespace: SLACK_4_NAMESPACE,
    });
    channels.push(slack4);
    try {
      await slack4.connect();
      logger.info({ namespace: SLACK_4_NAMESPACE }, 'Slack 4 channel connected');
    } catch (err) {
      logger.error({ err, namespace: SLACK_4_NAMESPACE }, 'Failed to connect Slack 4 channel');
    }
  }

  // Telegram channel (if configured)
  if (TELEGRAM_BOT_TOKEN) {
    const telegram = new TelegramChannel(TELEGRAM_BOT_TOKEN, channelOpts);
    channels.push(telegram);
    try {
      await telegram.connect();
      logger.info('Telegram channel connected');
    } catch (err) {
      logger.error({ err }, 'Failed to connect Telegram channel');
    }
  }

  // Discord channel (if configured)
  if (DISCORD_BOT_TOKEN) {
    const discord = new DiscordChannel(DISCORD_BOT_TOKEN, channelOpts);
    channels.push(discord);
    try {
      await discord.connect();
      logger.info('Discord channel connected');
    } catch (err) {
      logger.error({ err }, 'Failed to connect Discord channel');
    }
  }

  // LINE channel (if configured)
  if (LINE_CHANNEL_ACCESS_TOKEN && LINE_CHANNEL_SECRET) {
    const line = new LineChannel(
      LINE_CHANNEL_ACCESS_TOKEN,
      LINE_CHANNEL_SECRET,
      LINE_WEBHOOK_PORT,
      channelOpts,
    );
    channels.push(line);
    try {
      await line.connect();
      logger.info('LINE channel connected');
    } catch (err) {
      logger.error({ err }, 'Failed to connect LINE channel');
    }
  }

  // WhatsApp channel (if not in Signal-only or Telegram-only mode)
  if (!SIGNAL_ONLY && !TELEGRAM_ONLY) {
    whatsapp = new WhatsAppChannel(channelOpts);
    channels.push(whatsapp);
    try {
      await whatsapp.connect();
      logger.info('WhatsApp channel connected');
    } catch (err) {
      logger.error({ err }, 'Failed to connect WhatsApp channel');
    }
  }

  // Email channel v2 (if configured)
  if (EMAIL_CHANNEL_ENABLED && EMAIL_INTAKE_ACCOUNT) {
    const emailChannel = new EmailChannel({
      ...channelOpts,
      ownerSignalJid: 'sig:+819048411965',
      sendSignalMessage: async (jid: string, text: string) => {
        // Use the Signal channel to send approval notifications
        const signalCh = channels.find((c) => c.name === 'signal');
        if (signalCh) {
          await signalCh.sendMessage(jid, text);
        } else {
          logger.warn({ jid }, 'No Signal channel available for email approval notification');
        }
      },
    });
    channels.push(emailChannel);
    try {
      await emailChannel.connect();
      logger.info('Email channel v2 connected');
    } catch (err) {
      logger.error({ err }, 'Failed to connect Email channel v2');
    }
  }

  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    sendFile: async (jid, filePath, filename) => {
      const channel = findChannel(channels, jid) as any;
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      if (typeof channel.sendFile === 'function') {
        return channel.sendFile(jid, filePath, filename);
      }
      logger.warn({ jid }, 'Channel does not support sendFile');
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    onTasksChanged: () => {
      const tasks = getAllTasks();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        script: t.script || undefined,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      }));
      for (const group of Object.values(registeredGroups)) {
        writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
      }
    },
  });
  startSessionCleanup();
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
