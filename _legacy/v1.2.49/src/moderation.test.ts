import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  checkModeration,
  logModerationEvent,
  ModerationEvent,
} from './moderation.js';

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moderation-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeIndex(data: Record<string, unknown>): string {
  const p = path.join(tmpDir, 'identity-index.json');
  fs.writeFileSync(p, JSON.stringify(data));
  return p;
}

describe('checkModeration', () => {
  it('allows unknown senders (not in index)', () => {
    const indexPath = writeIndex({});
    const result = checkModeration('unknown-jid', indexPath);
    expect(result.type).toBe('allow');
  });

  it('allows guest tier', () => {
    const indexPath = writeIndex({
      'user:1': { tier: 'guest' },
    });
    const result = checkModeration('user:1', indexPath);
    expect(result.type).toBe('allow');
    expect(result.tier).toBe('guest');
  });

  it('allows staff tier', () => {
    const indexPath = writeIndex({
      'user:2': { tier: 'staff' },
    });
    const result = checkModeration('user:2', indexPath);
    expect(result.type).toBe('allow');
    expect(result.tier).toBe('staff');
  });

  it('allows owner tier', () => {
    const indexPath = writeIndex({
      'user:3': { tier: 'owner' },
    });
    const result = checkModeration('user:3', indexPath);
    expect(result.type).toBe('allow');
    expect(result.tier).toBe('owner');
  });

  it('blocks blocked tier', () => {
    const indexPath = writeIndex({
      'user:4': { tier: 'blocked' },
    });
    const result = checkModeration('user:4', indexPath);
    expect(result.type).toBe('block');
    expect(result.tier).toBe('blocked');
  });

  it('bans banned tier', () => {
    const indexPath = writeIndex({
      'user:5': { tier: 'banned' },
    });
    const result = checkModeration('user:5', indexPath);
    expect(result.type).toBe('ban');
    expect(result.tier).toBe('banned');
  });

  it('allows when index file is missing', () => {
    const indexPath = path.join(tmpDir, 'nonexistent.json');
    const result = checkModeration('user:1', indexPath);
    expect(result.type).toBe('allow');
  });
});

describe('logModerationEvent', () => {
  it('writes block events to blocked-activity.jsonl', () => {
    const triageDir = path.join(tmpDir, 'triage');
    const event: ModerationEvent = {
      timestamp: '2026-01-01T00:00:00.000Z',
      senderJid: 'user:4',
      chatJid: 'chat:1',
      reason: 'blocked tier',
    };

    logModerationEvent('block', event, triageDir);

    const filePath = path.join(triageDir, 'blocked-activity.jsonl');
    expect(fs.existsSync(filePath)).toBe(true);
    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual(event);
  });

  it('writes ban events to banned-activity.jsonl', () => {
    const triageDir = path.join(tmpDir, 'triage');
    const event: ModerationEvent = {
      timestamp: '2026-01-01T00:00:00.000Z',
      senderJid: 'user:5',
      reason: 'banned tier',
    };

    logModerationEvent('ban', event, triageDir);

    const filePath = path.join(triageDir, 'banned-activity.jsonl');
    expect(fs.existsSync(filePath)).toBe(true);
    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual(event);
  });

  it('does nothing for allow actions', () => {
    const triageDir = path.join(tmpDir, 'triage');
    const event: ModerationEvent = {
      timestamp: '2026-01-01T00:00:00.000Z',
      senderJid: 'user:1',
    };

    logModerationEvent('allow', event, triageDir);

    // triage dir should not even be created
    expect(fs.existsSync(triageDir)).toBe(false);
  });

  it('handles multiple events by appending', () => {
    const triageDir = path.join(tmpDir, 'triage');
    const event1: ModerationEvent = {
      timestamp: '2026-01-01T00:00:00.000Z',
      senderJid: 'user:4',
      reason: 'first',
    };
    const event2: ModerationEvent = {
      timestamp: '2026-01-01T01:00:00.000Z',
      senderJid: 'user:6',
      reason: 'second',
    };

    logModerationEvent('block', event1, triageDir);
    logModerationEvent('block', event2, triageDir);

    const filePath = path.join(triageDir, 'blocked-activity.jsonl');
    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual(event1);
    expect(JSON.parse(lines[1])).toEqual(event2);
  });
});
