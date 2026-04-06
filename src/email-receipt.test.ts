import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createEmailReceipt, EmailReceiptData } from './email-receipt.js';

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-receipt-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('createEmailReceipt', () => {
  it('creates an intake receipt artifact', () => {
    const data: EmailReceiptData = {
      type: 'intake',
      senderEmail: 'alice@ito.com',
      senderName: 'Alice',
      subject: 'Project notes',
      threadId: 'thread_123',
      timestamp: '2026-04-06T10:00:00.000Z',
      body: 'Here are the project notes for Q2.',
    };

    const filePath = createEmailReceipt(tmpDir, data);

    expect(fs.existsSync(filePath)).toBe(true);
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('type: email-intake');
    expect(content).toContain('alice@ito.com');
    expect(content).toContain('Project notes');
    expect(content).toContain('Here are the project notes for Q2.');
  });

  it('creates an action receipt artifact', () => {
    const data: EmailReceiptData = {
      type: 'action',
      senderEmail: 'joi@ito.com',
      senderName: 'Joi',
      subject: 'Schedule meeting',
      threadId: 'thread_456',
      timestamp: '2026-04-06T11:00:00.000Z',
      body: 'Please schedule with Alice next week.',
      actionSubtype: 'calendar',
      actionResult: 'Event created: Team Meeting (April 10, 2pm)',
    };

    const filePath = createEmailReceipt(tmpDir, data);

    expect(fs.existsSync(filePath)).toBe(true);
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('type: email-action');
    expect(content).toContain('calendar');
    expect(content).toContain('Event created');
  });

  it('sanitizes filenames', () => {
    const data: EmailReceiptData = {
      type: 'intake',
      senderEmail: 'user@ito.com',
      senderName: 'User',
      subject: 'Test',
      threadId: 'thread_789',
      timestamp: '2026-04-06T12:30:45.000Z',
      body: 'Content',
    };

    const filePath = createEmailReceipt(tmpDir, data);
    const filename = path.basename(filePath);
    // No colons in filename
    expect(filename).not.toContain(':');
    expect(filename).toMatch(/\.md$/);
  });
});
