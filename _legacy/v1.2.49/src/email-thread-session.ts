/**
 * Email Thread Session Store for NanoClaw email channel.
 * Persists per-thread conversation context in SQLite so that
 * multi-message email threads behave like ongoing conversations.
 */

import {
  getEmailThreadSession,
  storeEmailThreadSession,
} from './db.js';
import { logger } from './logger.js';

export interface ThreadSession {
  threadId: string;
  subject: string;
  participants: string[];
  lastMessageAt: string;
  contextSummary?: string;
}

export class EmailThreadSessionStore {
  /**
   * Save or update a thread session.
   */
  save(session: ThreadSession): void {
    storeEmailThreadSession({
      thread_id: session.threadId,
      subject: session.subject,
      participants: JSON.stringify(session.participants),
      last_message_at: session.lastMessageAt,
      context_summary: session.contextSummary,
    });
    logger.debug({ threadId: session.threadId }, 'email-thread-session: saved');
  }

  /**
   * Get a thread session by thread ID.
   * Returns null if no session exists for this thread.
   */
  get(threadId: string): ThreadSession | null {
    const row = getEmailThreadSession(threadId);
    if (!row) return null;

    return {
      threadId: row.thread_id,
      subject: row.subject,
      participants: JSON.parse(row.participants) as string[],
      lastMessageAt: row.last_message_at,
      contextSummary: row.context_summary ?? undefined,
    };
  }
}
