/**
 * Amplifier-remote runner — top-level entry point.
 *
 * Drop-in alternative to runContainerAgent (claude-agent-sdk) that forwards
 * the prompt to amplifierd over HTTP instead of spawning a local container.
 *
 * SAFETY: This runner trusts that the caller (src/index.ts:runAgent) has
 * already invoked isAmplifierRemoteAllowed() and gotten ok=true. The runner
 * itself does NOT re-validate. This is a deliberate single-source-of-truth
 * pattern for the dispatch decision — the caller knows the channel context,
 * the runner just executes.
 *
 * If you need to call this from somewhere new, ALWAYS run the safety
 * predicate first (./safety.ts) and only call here when ok=true.
 *
 * Session strategy: each call creates a fresh session unless input.sessionId
 * is provided. This keeps the canary stateless and predictable. Per-day
 * persistence is a future enhancement (joi-1l51 follow-up).
 *
 * @added 2026-05-05 for joi-1l51 (NanoClaw → remote Amplifier session pipe)
 */

import { logger } from '../../logger.js';
import type { RegisteredGroup } from '../../types.js';
import type { ContainerInput, ContainerOutput } from '../../container-runner.js';
import { createSession, executePrompt } from './client.js';

/** Bundle name on amplifierd that owns the joi tools (gtd, vault, beads, etc.) */
const AMPLIFIER_BUNDLE = 'joi';

/**
 * Detect whether an error indicates a stale (forgotten) amplifierd session.
 * NanoClaw persists session_id per group_folder in messages.db; the session
 * can outlive its amplifierd peer (daemon restart, hot-replace, daily cleanup).
 * When this happens, executePrompt throws "amplifierd 404 ... session not found".
 * The runner detects that pattern and rotates to a fresh session.
 */
function isStaleSessionError(err: unknown): boolean {
  const msg = (err as Error)?.message ?? '';
  return /\b404\b/.test(msg) || /session.*not.*found/i.test(msg) || /Session Not Found/i.test(msg);
}

/**
 * Inner helper: run one turn against amplifierd with the given session-id (or
 * create a fresh one). Throws on any failure — the caller decides whether to
 * retry with a fresh session or surface the error.
 */
async function executeOneTurn(
  input: ContainerInput,
  sessionIdOverride?: string,
): Promise<{ sessionId: string; response: string }> {
  let sessionId = sessionIdOverride ?? input.sessionId;
  if (!sessionId) {
    sessionId = await createSession(AMPLIFIER_BUNDLE, {
      folder: input.groupFolder,
      chatJid: input.chatJid,
      purpose: 'nanoclaw-amplifier-remote',
    });
    logger.info(
      { sessionId, folder: input.groupFolder, chatJid: input.chatJid },
      'amplifier-remote: created new session',
    );
  } else {
    logger.debug(
      { sessionId, folder: input.groupFolder },
      'amplifier-remote: reusing existing session',
    );
  }

  const { response } = await executePrompt(sessionId, input.prompt);
  return { sessionId, response };
}

/**
 * Run a single turn against amplifierd. Mirrors the shape of runContainerAgent
 * so the dispatch in runAgent() is symmetric.
 *
 * Stale-session auto-recovery (added 2026-05-05 after live-test discovery):
 * if we attempted with a cached input.sessionId and got a 404 / session-not-found
 * error, drop the stale ID, create a fresh session, and retry once. This makes
 * NanoClaw's persisted session-id store self-healing across amplifierd restarts.
 *
 * Returns ContainerOutput { status, result, newSessionId, error }.
 * On failure (after one retry where applicable) → status='error' with error
 * message; the caller decides whether to surface to user or fall through to
 * claude-agent-sdk.
 */
export async function runAmplifierRemoteAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  let result: ContainerOutput;

  try {
    const turn = await executeOneTurn(input);
    result = {
      status: 'success',
      result: turn.response,
      newSessionId: turn.sessionId,
    };
  } catch (err) {
    // Auto-recovery: if we tried with a CACHED session-id and got a stale-session
    // error from amplifierd, drop the ID and retry with a fresh session ONCE.
    if (input.sessionId && isStaleSessionError(err)) {
      const staleMsg = (err as Error).message;
      logger.warn(
        {
          staleSessionId: input.sessionId,
          folder: input.groupFolder,
          chatJid: input.chatJid,
          err: staleMsg,
        },
        'amplifier-remote: stale session detected, retrying with fresh session',
      );
      try {
        // Pass sessionIdOverride='' so executeOneTurn ignores input.sessionId
        // and creates a new one (we treat empty-string as 'no cached id').
        const turn = await executeOneTurn({ ...input, sessionId: undefined });
        result = {
          status: 'success',
          result: turn.response,
          newSessionId: turn.sessionId,
        };
      } catch (retryErr) {
        const retryMsg = (retryErr as Error).message;
        logger.error(
          {
            folder: input.groupFolder,
            chatJid: input.chatJid,
            originalErr: staleMsg,
            retryErr: retryMsg,
          },
          'amplifier-remote: retry with fresh session also failed',
        );
        result = {
          status: 'error',
          result: null,
          error: retryMsg,
        };
      }
    } else {
      // Non-stale error or no cached session-id to rotate from — surface as-is.
      const message = (err as Error).message;
      logger.error(
        { folder: input.groupFolder, chatJid: input.chatJid, err: message },
        'amplifier-remote: runner failed',
      );
      result = {
        status: 'error',
        result: null,
        error: message,
      };
    }
  }

  // Fire the onOutput callback (success or error — caller decides what to do)
  if (onOutput) {
    try {
      await onOutput(result);
    } catch (cbErr) {
      logger.warn({ cbErr: (cbErr as Error).message }, 'amplifier-remote: onOutput callback threw');
    }
  }

  return result;
}

// Re-export safety helpers for the dispatcher (single import surface).
export { isAmplifierRemoteAllowed, isDmJid, type SafetyDecision } from './safety.js';
