import { describe, expect, it, vi, beforeEach } from 'vitest';

import { CalendarAdapter, CalendarRequest } from './email-calendar-adapter.js';

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock execFileAsync to avoid calling real gog
let mockExecImpl: (bin: string, args: string[], opts: unknown) => Promise<{ stdout: string; stderr: string }>;
let capturedArgs: string[];

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('util', () => ({
  promisify: () => async (bin: string, args: string[], opts: unknown) => {
    capturedArgs = args;
    return mockExecImpl(bin, args, opts);
  },
}));

beforeEach(() => {
  capturedArgs = [];
  mockExecImpl = async () => ({
    stdout: JSON.stringify({
      id: 'event_123',
      htmlLink: 'https://calendar.google.com/event?eid=abc',
      summary: 'Team Meeting',
    }),
    stderr: '',
  });
});

describe('CalendarAdapter', () => {
  it('builds correct gog args for event creation', async () => {
    const adapter = new CalendarAdapter({
      gogBin: '/usr/local/bin/gog',
      account: 'jibot@ito.com',
      calendarId: 'joi@ito.com',
      keyringPassword: 'test-password',
    });

    const request: CalendarRequest = {
      summary: 'Team Meeting',
      startTime: '2026-04-10T14:00:00+09:00',
      endTime: '2026-04-10T15:00:00+09:00',
      description: 'Weekly sync',
      attendees: ['alice@ito.com', 'bob@ito.com'],
    };

    const result = await adapter.createEvent(request);

    expect(capturedArgs).toContain('calendar');
    expect(capturedArgs).toContain('create');
    expect(capturedArgs).toContain('joi@ito.com');
    expect(capturedArgs).toContain('--summary');
    expect(capturedArgs).toContain('Team Meeting');
    expect(capturedArgs).toContain('--from');
    expect(capturedArgs).toContain('--to');
    expect(capturedArgs).toContain('--attendees');
    expect(capturedArgs).toContain('alice@ito.com,bob@ito.com');
    expect(result.success).toBe(true);
    expect(result.eventId).toBe('event_123');
  });

  it('handles gog failure gracefully', async () => {
    mockExecImpl = async () => { throw new Error('API error: auth expired'); };

    const adapter = new CalendarAdapter({
      gogBin: 'gog',
      account: 'jibot@ito.com',
      calendarId: 'joi@ito.com',
      keyringPassword: '',
    });

    const request: CalendarRequest = {
      summary: 'Meeting',
      startTime: '2026-04-10T14:00:00+09:00',
      endTime: '2026-04-10T15:00:00+09:00',
    };

    const result = await adapter.createEvent(request);
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});
