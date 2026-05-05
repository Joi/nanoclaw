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
 * Run a single turn against amplifierd. Mirrors the shape of runContainerAgent
 * so the dispatch in runAgent() is symmetric.
 *
 * Returns ContainerOutput { status, result, newSessionId, error }.
 * On failure → status='error' with error message; the caller decides whether
 * to surface to user or fall through to claude-agent-sdk.
 */
export async function runAmplifierRemoteAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  let result: ContainerOutput;

  try {
    // Reuse an existing session if the caller passed one (multi-turn continuity).
    // Otherwise create a fresh session bound to the joi bundle.
    let sessionId = input.sessionId;
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

    result = {
      status: 'success',
      result: response,
      newSessionId: sessionId,
    };
  } catch (err) {
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
