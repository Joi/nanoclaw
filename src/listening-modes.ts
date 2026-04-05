/**
 * Listening modes for NanoClaw channels.
 * Controls when the bot responds to and ingests messages.
 *
 * - active: responds to all messages, ingests all messages
 * - attentive: responds only when mentioned, ingests all messages
 * - on-call: responds only when mentioned, ingests only when mentioned
 * - silent: never responds, never ingests
 */

export type ListeningMode = 'active' | 'attentive' | 'on-call' | 'silent';

const VALID_MODES: ReadonlySet<string> = new Set<ListeningMode>([
  'active',
  'attentive',
  'on-call',
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
  return isValidListeningMode(candidate) ? candidate : null;
}

/**
 * Whether the bot should respond to a message in the given mode.
 * - active: always
 * - attentive: only when mentioned
 * - on-call: only when mentioned
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
    case 'on-call':
      return isMentioned;
    case 'silent':
      return false;
  }
}

/**
 * Whether the bot should ingest (store/process) a message in the given mode.
 * - active: always
 * - attentive: always
 * - on-call: only when mentioned
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
    case 'on-call':
      return isMentioned;
    case 'silent':
      return false;
  }
}
