/**
 * Listening modes for NanoClaw channels.
 * Controls when the bot responds to and ingests messages.
 *
 * - active: responds to all messages, ingests all messages
 * - attentive: responds only when mentioned, ingests all messages
 * - silent: never responds, never ingests
 *
 * Deprecated: "on-call" (removed 2026-04-14, was identical to attentive
 * in practice since channel-config.ts normalized both to "mention")
 */

export type ListeningMode = 'active' | 'attentive' | 'silent';

const VALID_MODES: ReadonlySet<string> = new Set<ListeningMode>([
  'active',
  'attentive',
  'silent',
]);

/**
 * Type guard: returns true if the value is a valid ListeningMode.
 */
export function isValidListeningMode(value: string): value is ListeningMode {
  return VALID_MODES.has(value);
}

/**
 * Parses a "set listening mode to {mode}" command from message text.
 * Returns the mode if valid, null otherwise.
 */
export function parseListeningModeCommand(text: string): ListeningMode | null {
  const match = text.match(/set listening mode to (\S+)/i);
  if (!match) return null;
  const candidate = match[1].toLowerCase();
  // Accept deprecated "on-call" as attentive
  if (candidate === 'on-call') return 'attentive';
  return isValidListeningMode(candidate) ? candidate : null;
}

/**
 * Whether the bot should respond to a message in the given mode.
 * - active: always
 * - attentive: only when mentioned
 * - silent: never
 */
export function shouldRespond(
  mode: ListeningMode,
  isMentioned: boolean,
): boolean {
  switch (mode) {
    case 'active':
      return true;
    case 'attentive':
      return isMentioned;
    case 'silent':
      return false;
  }
}

/**
 * Whether the bot should ingest (store/process) a message in the given mode.
 * - active: always
 * - attentive: always
 * - silent: never
 */
export function shouldIngest(
  mode: ListeningMode,
  isMentioned: boolean,
): boolean {
  switch (mode) {
    case 'active':
    case 'attentive':
      return true;
    case 'silent':
      return false;
  }
}
