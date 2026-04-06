import { beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase } from './db.js';
import { EmailThreadSessionStore } from './email-thread-session.js';

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

beforeEach(() => {
  _initTestDatabase();
});

describe('EmailThreadSessionStore', () => {
  it('saves and retrieves thread context', () => {
    const store = new EmailThreadSessionStore();
    store.save({
      threadId: 'thread_1',
      subject: 'Meeting planning',
      participants: ['alice@ito.com', 'bob@ito.com'],
      lastMessageAt: '2026-04-06T10:00:00.000Z',
      contextSummary: 'Discussing Q2 planning',
    });

    const session = store.get('thread_1');
    expect(session).toBeDefined();
    expect(session!.subject).toBe('Meeting planning');
    expect(session!.participants).toEqual(['alice@ito.com', 'bob@ito.com']);
    expect(session!.contextSummary).toBe('Discussing Q2 planning');
  });

  it('returns null for unknown thread', () => {
    const store = new EmailThreadSessionStore();
    expect(store.get('nonexistent')).toBeNull();
  });

  it('updates existing thread with new message context', () => {
    const store = new EmailThreadSessionStore();
    store.save({
      threadId: 'thread_2',
      subject: 'Budget review',
      participants: ['joi@ito.com'],
      lastMessageAt: '2026-04-06T09:00:00.000Z',
      contextSummary: 'Initial budget request',
    });

    store.save({
      threadId: 'thread_2',
      subject: 'Budget review',
      participants: ['joi@ito.com', 'carol@ito.com'],
      lastMessageAt: '2026-04-06T10:00:00.000Z',
      contextSummary: 'Carol joined, discussing revisions',
    });

    const session = store.get('thread_2');
    expect(session!.participants).toEqual(['joi@ito.com', 'carol@ito.com']);
    expect(session!.contextSummary).toBe('Carol joined, discussing revisions');
  });
});
