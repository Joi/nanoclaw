/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times. Note: when running as a scheduled task, your final output is NOT sent to the user — use this tool if you need to communicate with the user or group.",
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
    schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)'),
    context_mode: z.enum(['group', 'isolated']).default('group').describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
    target_group_jid: z.string().optional().describe('(Main group only) JID of the group to schedule the task for. Defaults to the current group.'),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (/[Zz]$/.test(args.schedule_value) || /[+-]\d{2}:\d{2}$/.test(args.schedule_value)) {
        return {
          content: [{ type: 'text' as const, text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const data = {
      type: 'schedule_task',
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    const filename = writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task scheduled (${filename}): ${args.schedule_type} - ${args.schedule_value}` }],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

server.tool(
  'register_group',
  `Register a new WhatsApp group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name should be lowercase with hyphens (e.g., "family-chat").`,
  {
    jid: z.string().describe('The WhatsApp JID (e.g., "120363336345536173@g.us")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Folder name for group files (lowercase, hyphens, e.g., "family-chat")'),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
    };
  },
);


server.tool(
  'link_account',
  `Link a channel account (JID) to an existing group folder so they share the same session, CLAUDE.md, and context. Main group only.

Use this when the same user has multiple channel accounts (e.g., Signal DM and Slack DM) that should share one agent folder.
The target folder must already have at least one registered group — privileges (reminders, bookmarks) are copied from the existing entry.`,
  {
    jid: z.string().describe('The JID to link (e.g., "slack:U02GY1YS33Q", "sig:+1234567890")'),
    target_folder: z.string().describe('The existing folder name to link to (e.g., "joi-dm")'),
    name: z.string().optional().describe('Display name for this account (defaults to existing name)'),
    requires_trigger: z.boolean().optional().describe('Whether this account needs a trigger word (defaults to existing setting)'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can link accounts.' }],
        isError: true,
      };
    }

    const data: Record<string, unknown> = {
      type: 'link_account',
      jid: args.jid,
      targetFolder: args.target_folder,
      timestamp: new Date().toISOString(),
    };
    if (args.name) data.name = args.name;
    if (args.requires_trigger !== undefined) data.requiresTrigger = args.requires_trigger;

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Account "${args.jid}" linked to folder "${args.target_folder}".` }],
    };
  },
);

// ── Apple Reminders tools (conditional on NANOCLAW_REMINDERS_ACCESS) ──

const hasRemindersAccess = process.env.NANOCLAW_REMINDERS_ACCESS === '1';

if (hasRemindersAccess) {
  const REMINDERS_DIR = path.join(IPC_DIR, 'reminders');

  function writeRemindersIpc(data: object): string {
    fs.mkdirSync(REMINDERS_DIR, { recursive: true });
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
    const filepath = path.join(REMINDERS_DIR, filename);
    const tempPath = `${filepath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
    fs.renameSync(tempPath, filepath);
    return filename;
  }

  function readRemindersSnapshot(): object | null {
    const snapshotPath = path.join(IPC_DIR, 'reminders_snapshot.json');
    try {
      if (fs.existsSync(snapshotPath)) {
        return JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'));
      }
    } catch {}
    return null;
  }

  server.tool(
    'list_reminders',
    `List Apple Reminders. Shows all incomplete reminders across synced lists (Inbox, Next Actions, Waiting For, Someday/Maybe, Joi/Mika To Do).
Reminders are sorted with overdue items first, then by due date. Each reminder has an id, title, list_name, due_date, priority, and notes.`,
    {
      list_name: z.string().optional().describe('Filter to a specific list (e.g., "Inbox", "Next Actions", "Waiting For")'),
    },
    async (args) => {
      const snapshot = readRemindersSnapshot();
      if (!snapshot) {
        return {
          content: [{ type: 'text' as const, text: 'Reminders data not available. It may still be loading.' }],
        };
      }

      const data = snapshot as { reminders?: Array<Record<string, unknown>>; by_list?: Record<string, Array<Record<string, unknown>>>; total?: number };

      if (args.list_name) {
        const byList = data.by_list || {};
        // Case-insensitive match
        const key = Object.keys(byList).find(k => k.toLowerCase() === args.list_name!.toLowerCase());
        if (!key) {
          const available = Object.keys(byList).join(', ');
          return {
            content: [{ type: 'text' as const, text: `List "${args.list_name}" not found. Available: ${available}` }],
          };
        }
        const items = byList[key];
        const formatted = items.map((r: Record<string, unknown>) =>
          `- [${r.priority ? '!' : ' '}] ${r.title}${r.due_date ? ` (due: ${r.due_date})` : ''}${r.notes ? ` — ${(r.notes as string).slice(0, 50)}` : ''}
  ID: ${r.id}`
        ).join('\n');
        return {
          content: [{ type: 'text' as const, text: `**${key}** (${items.length} items):\n${formatted}` }],
        };
      }

      // Show all lists summary
      const byList = data.by_list || {};
      let output = `**All Reminders** (${data.total || 0} total)\n\n`;
      for (const [listName, items] of Object.entries(byList)) {
        output += `**${listName}** (${(items as unknown[]).length}):\n`;
        for (const r of items as Array<Record<string, unknown>>) {
          output += `- ${r.title}${r.due_date ? ` (due: ${r.due_date})` : ''}\n  ID: ${r.id}\n`;
        }
        output += '\n';
      }
      return { content: [{ type: 'text' as const, text: output }] };
    },
  );

  server.tool(
    'create_reminder',
    'Create a new Apple Reminder. Defaults to the Inbox list.',
    {
      title: z.string().describe('The reminder title'),
      list_name: z.string().default('Inbox').describe('Which list (Inbox, Next Actions, Waiting For, Someday/Maybe, Joi/Mika To Do)'),
      due_date: z.string().optional().describe('Due date in YYYY-MM-DD format'),
      notes: z.string().optional().describe('Additional notes'),
      priority: z.number().optional().describe('Priority: 0=none, 1=high, 5=medium, 9=low'),
    },
    async (args) => {
      writeRemindersIpc({
        operation: 'create_reminder',
        params: {
          title: args.title,
          list_name: args.list_name,
          due_date: args.due_date,
          notes: args.notes,
          priority: args.priority || 0,
        },
      });
      return {
        content: [{ type: 'text' as const, text: `Reminder "${args.title}" created in ${args.list_name}.` }],
      };
    },
  );

  server.tool(
    'complete_reminder',
    'Mark an Apple Reminder as complete. Use the ID from list_reminders, or match by title.',
    {
      reminder_id: z.string().optional().describe('The reminder ID (from list_reminders)'),
      title_match: z.string().optional().describe('Partial title match (case-insensitive)'),
    },
    async (args) => {
      if (!args.reminder_id && !args.title_match) {
        return {
          content: [{ type: 'text' as const, text: 'Provide either reminder_id or title_match.' }],
          isError: true,
        };
      }
      writeRemindersIpc({
        operation: 'complete_reminder',
        params: {
          reminder_id: args.reminder_id,
          title_match: args.title_match,
        },
      });
      return {
        content: [{ type: 'text' as const, text: `Reminder completion requested.` }],
      };
    },
  );

  server.tool(
    'update_reminder',
    'Update an existing Apple Reminder (title, due date, notes, priority, or move to different list).',
    {
      reminder_id: z.string().optional().describe('The reminder ID'),
      title_match: z.string().optional().describe('Partial title match to find the reminder'),
      title: z.string().optional().describe('New title'),
      due_date: z.string().optional().describe('New due date (YYYY-MM-DD or empty to clear)'),
      notes: z.string().optional().describe('New notes'),
      priority: z.number().optional().describe('New priority: 0=none, 1=high, 5=medium, 9=low'),
      list_name: z.string().optional().describe('Move to this list'),
    },
    async (args) => {
      if (!args.reminder_id && !args.title_match) {
        return {
          content: [{ type: 'text' as const, text: 'Provide either reminder_id or title_match.' }],
          isError: true,
        };
      }
      const params: Record<string, unknown> = {};
      if (args.reminder_id) params.reminder_id = args.reminder_id;
      if (args.title_match) params.title_match = args.title_match;
      if (args.title !== undefined) params.title = args.title;
      if (args.due_date !== undefined) params.due_date = args.due_date;
      if (args.notes !== undefined) params.notes = args.notes;
      if (args.priority !== undefined) params.priority = args.priority;
      if (args.list_name !== undefined) params.list_name = args.list_name;

      writeRemindersIpc({
        operation: 'update_reminder',
        params,
      });
      return {
        content: [{ type: 'text' as const, text: 'Reminder update requested.' }],
      };
    },
  );
}

// ── Bookmark tools (conditional on NANOCLAW_BOOKMARKS_ACCESS) ──

const hasBookmarksAccess = process.env.NANOCLAW_BOOKMARKS_ACCESS === '1';

if (hasBookmarksAccess) {
  const BOOKMARKS_DIR = path.join(IPC_DIR, 'bookmarks');

  function writeBookmarkIpc(data: object): { reqFile: string; respFile: string } {
    fs.mkdirSync(BOOKMARKS_DIR, { recursive: true });
    const ts = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const reqFile = `req-${ts}.json`;
    const respFile = `resp-${ts}.json`;
    const filepath = path.join(BOOKMARKS_DIR, reqFile);
    const tempPath = `${filepath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify({ ...data, responseFile: respFile }, null, 2));
    fs.renameSync(tempPath, filepath);
    return { reqFile, respFile };
  }

  async function waitForResponse(respFile: string, timeoutMs: number = 120_000): Promise<object> {
    const respPath = path.join(BOOKMARKS_DIR, respFile);
    const start = Date.now();
    const pollInterval = 500;
    while (Date.now() - start < timeoutMs) {
      if (fs.existsSync(respPath)) {
        const content = fs.readFileSync(respPath, 'utf-8');
        fs.unlinkSync(respPath);
        return JSON.parse(content);
      }
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }
    return { error: `Bookmark operation timed out after ${timeoutMs / 1000}s` };
  }

  server.tool(
    'bookmark_url',
    `Bookmark a URL for knowledge extraction. The bookmark service fetches the page, extracts clean markdown content, classifies it, and saves it to the knowledge base.
Extraction can take 30-60 seconds. The result includes the file path, title, and classification.`,
    {
      url: z.string().describe('The URL to bookmark'),
      hint: z.string().optional().describe('Classification hint: person, concept, organization, reference, event, or project'),
    },
    async (args) => {
      const { respFile } = writeBookmarkIpc({
        operation: 'bookmark_url',
        params: { url: args.url, hint: args.hint },
      });

      const result = await waitForResponse(respFile);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    'bookmark_health',
    'Check if the bookmark extraction service is healthy and available.',
    {},
    async () => {
      const { respFile } = writeBookmarkIpc({
        operation: 'bookmark_health',
      });

      const result = await waitForResponse(respFile, 15_000);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    'bookmark_recent',
    'List recently bookmarked URLs and their extraction status.',
    {},
    async () => {
      const { respFile } = writeBookmarkIpc({
        operation: 'bookmark_recent',
      });

      const result = await waitForResponse(respFile, 15_000);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
