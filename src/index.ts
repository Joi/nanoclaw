import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  CREDENTIAL_PROXY_PORT,
  GROUPS_DIR,
  IDLE_TIMEOUT,
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
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_ONLY,
  TIMEZONE,
  TRIGGER_PATTERN,
  VOICE_API_TOKEN,
  EMAIL_INTAKE_ENABLED,
  CONFIDENTIAL_ROOT,
  EMAIL_INTAKE_FROM_FILTER,
} from './config.js';
import { startCredentialProxy } from './credential-proxy.js';
import { WhatsAppChannel } from './channels/whatsapp.js';
import { SignalChannel } from './channels/signal.js';
import { SlackChannel } from './channels/slack.js';
import { TelegramChannel } from './channels/telegram.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  PROXY_BIND_HOST,
} from './container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  getRegisteredGroup,
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
import { EmailChannel } from './channels/email.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';
import { checkInput, checkOutput } from './guardrails.js';
import { writeRemindersSnapshot } from './reminders.js';
import { writeUsersSnapshot } from './user-snapshot.js';
import { startVoiceApi } from './voice-api.js';
import { writeIntakeFile } from './intake.js';
import { shouldRunIntake } from './intake-routing.js';
import { parseGidcCommand } from './gidc-commands.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

let whatsapp: WhatsAppChannel | undefined;
const channels: Channel[] = [];
const queue = new GroupQueue();

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

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}


// --- Auto-register gate: deny-all catch-all for unknown contacts ---
interface AutoRegisterGate {
  enabled: boolean;
  mode: "allowlist" | "denylist";
  allowed: string[];
  notifyOwnerJid?: string;
  rejectionMessage: string;
}

const AUTO_REGISTER_GATE_PATH = path.join(
  process.env.HOME || "/Users/jibot",
  ".config",
  "nanoclaw",
  "auto-register-gate.json",
);

function loadAutoRegisterGate(): AutoRegisterGate | null {
  try {
    const raw = fs.readFileSync(AUTO_REGISTER_GATE_PATH, "utf-8");
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

  if (gate.mode === "allowlist") {
    return gate.allowed.some((pattern) => chatJid.includes(pattern));
  }
  // denylist mode
  return !gate.allowed.some((pattern) => chatJid.includes(pattern));
}

function getGateRejectionMessage(): string {
  const gate = loadAutoRegisterGate();
  return gate?.rejectionMessage || "I am not configured to chat with unknown contacts.";
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
      "Auto-registration DENIED by gate (not on allowlist)",
    );
    return false;
  }

  // Extract phone from JID (sig:+819048411965 → 819048411965)
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
      "Auto-registration DENIED by gate (not on allowlist)",
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
 * Ensure the email group exists for the owner's email address.
 * Creates the group on first run; subsequent calls are no-ops.
 */
function ensureEmailGroup(): void {
  const jid = `email:${EMAIL_INTAKE_FROM_FILTER}`;
  if (registeredGroups[jid]) return;

  const folder = 'email-joi';
  const group: RegisteredGroup = {
    name: 'Joi (Email)',
    folder,
    trigger: `@${ASSISTANT_NAME}`,
    added_at: new Date().toISOString(),
    requiresTrigger: false,
    emailAccess: true,
    bookmarksAccess: true,
    remindersAccess: true,
  };
  registerGroup(jid, group);

  // Copy CLAUDE.md from template if available
  const templateTier = SIGNAL_DEFAULT_TIER || 'assistant-dm';
  const templateClaudeMd = path.join(GROUPS_DIR, templateTier, 'CLAUDE.md');
  const destClaudeMd = path.join(GROUPS_DIR, folder, 'CLAUDE.md');
  if (fs.existsSync(templateClaudeMd) && !fs.existsSync(destClaudeMd)) {
    fs.copyFileSync(templateClaudeMd, destClaudeMd);
  }

  logger.info({ jid, folder }, 'Auto-registered email group');
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

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        TRIGGER_PATTERN.test(m.content.trim()) &&
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

  const prompt = formatMessages(missedMessages, TIMEZONE);

  // --- NeMo Guardrails: Input check ---
  const inputCheck = await checkInput(
    prompt,
    missedMessages[0]?.sender,
    chatJid.startsWith('sig:') ? 'signal' : chatJid.startsWith('slack:') ? 'slack' : 'other',
  );
  if (!inputCheck.allowed) {
    logger.warn(
      { group: group.name, reason: inputCheck.reason },
      'Message blocked by guardrails',
    );
    await channel.sendMessage(chatJid, 'I cannot process that request.');
    return true;
  }

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

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
      if (text) {
        // --- NeMo Guardrails: Output check ---
        const outputCheck = await checkOutput(prompt, text);
        if (outputCheck.allowed) {
          await channel.sendMessage(chatJid, text);
          outputSentToUser = true;
        } else {
          logger.warn(
            { group: group.name, reason: outputCheck.reason },
            'Output blocked by guardrails',
          );
          await channel.sendMessage(
            chatJid,
            'I generated a response but it was blocked by safety filters. Please try rephrasing your request.',
          );
          outputSentToUser = true;
        }
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
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

  // Guard against silent failures: if the agent "succeeded" but never sent
  // any visible output, the user didn't get a response. Roll back the cursor
  // so the messages will be re-processed on the next trigger.
  if (!outputSentToUser) {
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn({ group: group.name }, 'Agent completed with no visible output, rolled back cursor');
    return true; // Don't retry immediately — avoid tight loops on persistent silent failures
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

  // Write reminders snapshot if this group has access
  if (group.remindersAccess) {
    writeRemindersSnapshot(group.folder);
  }

  // Write users snapshot for admin groups (calendarAccess || remindersAccess)
  if (group.calendarAccess || group.remindersAccess) {
    writeUsersSnapshot(group.folder, registeredGroups, 'gidc');
  }

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

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        remindersAccess: !!group.remindersAccess,
        bookmarksAccess: !!group.bookmarksAccess,
        emailAccess: !!group.emailAccess,
        calendarAccess: !!group.calendarAccess,
        assistantName: ASSISTANT_NAME,
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

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

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
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                TRIGGER_PATTERN.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
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
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}


async function main(): Promise<void> {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Start credential proxy (containers route API calls through this)
  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    PROXY_BIND_HOST,
  );

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    proxyServer.close();
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);

      // GIDC intake: write substantive messages to confidential workstream dirs
      if (
        !msg.is_from_me &&
        !msg.is_bot_message &&
        chatJid.startsWith('slack:gidc:') &&
        registeredGroups[chatJid]
      ) {
        const group = registeredGroups[chatJid];
        if (group.intakeAccess && shouldRunIntake(group.channelMode, false)) {
          // folder names are prefixed with workstream (e.g. 'sankosh-intake' -> 'sankosh')
          const workstream = group.folder.split('-')[0];
          // Guard: skip intake if workstream is empty or has no matching directory
          // (prevents silent writes for DM groups or folders without a '-' delimiter)
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
          } // end else: workstream directory exists
        }
      }

      // jibrain intake: write substantive messages to Syncthing-synced jibrain
      if (!msg.is_from_me && !msg.is_bot_message && msg.content.length >= 20) {
        const ch = chatJid.split(":")[0] || "unknown";
        execFile("/bin/bash", [
          path.join(process.env.HOME || "/Users/jibot", "scripts/nanoclaw-jibrain-hook.sh"),
          "process", ch, msg.sender, msg.content,
        ], (err) => { if (err) logger.warn({ err }, "jibrain hook failed"); });
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

  // Create and connect channels
  if (!SIGNAL_ONLY && !TELEGRAM_ONLY) {
    whatsapp = new WhatsAppChannel(channelOpts);
    channels.push(whatsapp);
    await whatsapp.connect();
  }

  // Signal channel (if configured)
  if (SIGNAL_ACCOUNT) {
    const signal = new SignalChannel({
      ...channelOpts,
      signalCliUrl: SIGNAL_CLI_URL,
      signalAccount: SIGNAL_ACCOUNT,
      onNewContact: SIGNAL_DEFAULT_TIER ? (chatJid, senderName) => {
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

  // Slack channel (if configured)
  if (SLACK_BOT_TOKEN && SLACK_APP_TOKEN) {
    const slack = new SlackChannel({
      ...channelOpts,
      slackBotToken: SLACK_BOT_TOKEN,
      slackAppToken: SLACK_APP_TOKEN,
      slackSigningSecret: SLACK_SIGNING_SECRET,
      onNewContact: SIGNAL_DEFAULT_TIER ? (chatJid, nameOrId, isGroup) => {
        const registered = autoRegisterSlackContact(chatJid, nameOrId, isGroup);
        if (!registered && !isAutoRegisterAllowed(chatJid)) {
          logger.warn(
            { chatJid, nameOrId },
            "Slack contact rejected by auto-register gate",
          );
          // Slack rejection handled by the channel (no cross-channel notify needed)
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
      // No onNewContact — contacts linked manually via link_account
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

  // Email channel (polls Gmail, classifies URL-only vs natural language)
  if (EMAIL_INTAKE_ENABLED) {
    ensureEmailGroup();
    const emailChannel = new EmailChannel(channelOpts);
    channels.push(emailChannel);
    try {
      await emailChannel.connect();
      logger.info('Email channel connected');
    } catch (err) {
      logger.error({ err }, 'Failed to connect Email channel');
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
    sendFile: (jid, filePath, filename) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      if (!channel.sendFile) throw new Error(`Channel for JID ${jid} does not support sendFile`);
      return channel.sendFile(jid, filePath, filename);
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
  });

  // Voice API (HTTP endpoint for iOS voice bridge)
  if (VOICE_API_TOKEN) {
    startVoiceApi();
  }

  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop();
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
