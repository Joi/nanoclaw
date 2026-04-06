import { describe, expect, it, vi, beforeEach } from 'vitest';

import { ReminderAdapter, ReminderRequest } from './email-reminder-adapter.js';

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock the reminders bridge
vi.mock('./reminders.js', () => ({
  callBridge: vi.fn(),
}));

import { callBridge } from './reminders.js';

beforeEach(() => {
  vi.mocked(callBridge).mockReset();
});

describe('ReminderAdapter', () => {
  it('creates a reminder via the bridge', () => {
    vi.mocked(callBridge).mockReturnValue({
      success: true,
      reminder_id: 'rem_123',
    });

    const adapter = new ReminderAdapter();
    const request: ReminderRequest = {
      title: 'Review proposal',
      dueDate: '2026-04-11',
      notes: 'From email thread about Q2 budget',
      listName: 'Inbox',
    };

    const result = adapter.createReminder(request);
    expect(result.success).toBe(true);
    expect(result.reminderId).toBe('rem_123');

    expect(callBridge).toHaveBeenCalledWith('create_reminder', {
      title: 'Review proposal',
      due_date: '2026-04-11',
      notes: 'From email thread about Q2 budget',
      list_name: 'Inbox',
    });
  });

  it('handles bridge failure gracefully', () => {
    vi.mocked(callBridge).mockReturnValue({
      error: 'Bridge call failed: timeout',
    });

    const adapter = new ReminderAdapter();
    const result = adapter.createReminder({
      title: 'Test',
      dueDate: '2026-04-11',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('timeout');
  });

  it('uses default list name when not specified', () => {
    vi.mocked(callBridge).mockReturnValue({ success: true, reminder_id: 'rem_456' });

    const adapter = new ReminderAdapter();
    adapter.createReminder({
      title: 'Remember this',
      dueDate: '2026-04-12',
    });

    expect(callBridge).toHaveBeenCalledWith('create_reminder', expect.objectContaining({
      list_name: 'Inbox',
    }));
  });
});
