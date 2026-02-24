/**
 * Voice API server for NanoClaw.
 * Exposes an HTTP endpoint so the iOS voice bridge can execute
 * tool calls through NanoClaw's container agents.
 */
import http from 'http';

import { ASSISTANT_NAME, MAIN_GROUP_FOLDER, VOICE_API_PORT, VOICE_API_TOKEN } from './config.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import { getAllRegisteredGroups, getAllTasks, getSession, setSession } from './db.js';
import { logger } from './logger.js';
import { writeRemindersSnapshot } from './reminders.js';
import { RegisteredGroup } from './types.js';

// Voice uses the main group folder (joi-dm) so it has the same CLAUDE.md,
// workspace, tools, and full main-group capabilities. Session is tracked
// separately so voice and messaging conversations don't share Claude context.
const VOICE_SESSION_KEY = 'voice';

/** Build voice group config, inheriting containerConfig from the registered main group. */
function buildVoiceGroup(): RegisteredGroup {
  // Find the registered main group to inherit its containerConfig (mounts, etc.)
  const groups = getAllRegisteredGroups();
  const mainGroup = Object.values(groups).find((g) => g.folder === MAIN_GROUP_FOLDER);

  return {
    name: 'Voice',
    folder: MAIN_GROUP_FOLDER,
    trigger: `@${ASSISTANT_NAME}`,
    added_at: new Date().toISOString(),
    requiresTrigger: false,
    remindersAccess: true,
    bookmarksAccess: true,
    emailAccess: true,
    containerConfig: mainGroup?.containerConfig,
  };
}

const DEFAULT_TIMEOUT = 300_000; // 5 minutes
const MIN_TIMEOUT = 120_000; // 2 minutes — cold starts need at least this

let voiceSessionId: string | undefined;

/** Load persisted voice session from DB on startup. */
function loadVoiceSession(): void {
  voiceSessionId = getSession(VOICE_SESSION_KEY) || undefined;
}

interface RunRequestBody {
  input: string;
  timeout?: number;
}

async function handleRun(body: RunRequestBody): Promise<{
  success: boolean;
  result: string | null;
  durationMs: number;
  error?: string;
}> {
  const start = Date.now();
  const { input, timeout } = body;

  if (!input || typeof input !== 'string') {
    return { success: false, result: null, durationMs: 0, error: 'Missing "input" string' };
  }

  // Voice transcription context: speech-to-text often mis-transcribes
  // proper nouns. Prepend a hint so the agent interprets them correctly.
  const voiceContext = [
    '[Voice input — transcription aliases:',
    '"the brain" / "jay brain" / "ji brain" / "g brain" = jibrain (knowledge base at /workspace/extra/jibrain/)',
    'Use WebSearch tool when asked to search the web or look something up online.]',
  ].join(' ');
  const prompt = `${voiceContext}\n\n${input}`;

  // Write pre-run snapshots (main group sees all tasks/groups)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    MAIN_GROUP_FOLDER,
    true,
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
  writeGroupsSnapshot(MAIN_GROUP_FOLDER, true, [], new Set());
  writeRemindersSnapshot(MAIN_GROUP_FOLDER);

  // Resolve as soon as the first result arrives (don't wait for container exit).
  // The container stays alive for follow-up IPC, but voice is single-turn.
  const timeoutMs = Math.max(timeout || DEFAULT_TIMEOUT, MIN_TIMEOUT);
  let firstResult: string | null = null;
  let agentError: string | undefined;

  try {
    const voiceGroup = buildVoiceGroup();

    // Promise that resolves on first streaming result (or error)
    const firstResultPromise = new Promise<{ result: string | null; error?: string }>((resolve) => {
      let resolved = false;
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve({ result: firstResult, error: 'Voice API timeout' });
        }
      }, timeoutMs);

      runContainerAgent(
        voiceGroup,
        {
          prompt,
          sessionId: voiceSessionId,
          groupFolder: MAIN_GROUP_FOLDER,
          chatJid: 'voice:session',
          isMain: true,
          remindersAccess: true,
          bookmarksAccess: true,
          emailAccess: true,
          assistantName: ASSISTANT_NAME,
        },
        (_proc, _containerName) => {
          // Voice containers are independent — no queue registration needed
        },
        async (output: ContainerOutput) => {
          if (output.newSessionId) {
            voiceSessionId = output.newSessionId;
            setSession(VOICE_SESSION_KEY, output.newSessionId);
          }
          if (output.status === 'error') {
            agentError = output.error || 'Agent error';
            if (!resolved) {
              resolved = true;
              clearTimeout(timer);
              resolve({ result: null, error: agentError });
            }
            return;
          }
          if (output.result && !resolved) {
            const raw = typeof output.result === 'string'
              ? output.result
              : JSON.stringify(output.result);
            const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
            if (text) {
              firstResult = text;
              resolved = true;
              clearTimeout(timer);
              resolve({ result: text });
            }
          }
        },
      ).catch((err) => {
        // Container exit — resolve if we haven't already
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          const message = err instanceof Error ? err.message : String(err);
          resolve({ result: firstResult, error: message });
        }
      });
    });

    const { result, error } = await firstResultPromise;
    const durationMs = Date.now() - start;

    if (error) {
      return { success: false, result, durationMs, error };
    }

    return { success: true, result, durationMs };
  } catch (err) {
    const durationMs = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'Voice API run error');
    return { success: false, result: firstResult, durationMs, error: message };
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const MAX_BODY = 1024 * 1024; // 1MB
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

export function startVoiceApi(): http.Server {
  loadVoiceSession();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${VOICE_API_PORT}`);

    // Health check (no auth required)
    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }

    // Auth check for all other endpoints
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (token !== VOICE_API_TOKEN) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return;
    }

    // POST /api/run
    if (req.method === 'POST' && url.pathname === '/api/run') {
      try {
        const rawBody = await readBody(req);
        const body: RunRequestBody = JSON.parse(rawBody);
        const result = await handleRun(body);
        sendJson(res, 200, result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ err }, 'Voice API request error');
        sendJson(res, 400, { error: message });
      }
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  });

  server.listen(VOICE_API_PORT, () => {
    logger.info({ port: VOICE_API_PORT }, 'Voice API server started');
  });

  return server;
}
