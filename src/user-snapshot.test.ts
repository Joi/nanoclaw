import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildUsersSnapshot, writeUsersSnapshot } from './user-snapshot.js';
import { RegisteredGroup } from './types.js';

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'user-snapshot-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('buildUsersSnapshot', () => {
  it('extracts GIDC users with tier info from registered groups filtering by namespace prefix', () => {
    const registeredGroups: Record<string, RegisteredGroup> = {
      'slack:gidc:U123': {
        name: 'slack:gidc:U123',
        folder: 'gidc-template-owner',
        trigger: '@Andy',
        added_at: '2026-01-01T00:00:00.000Z',
        remindersAccess: true,
        calendarAccess: true,
      },
      'slack:gidc:U456': {
        name: 'slack:gidc:U456',
        folder: 'gidc-template-staff',
        trigger: '@Andy',
        added_at: '2026-01-02T00:00:00.000Z',
      },
      // Different namespace — should be excluded
      'slack:other:U789': {
        name: 'slack:other:U789',
        folder: 'gidc-template-staff',
        trigger: '@Andy',
        added_at: '2026-01-03T00:00:00.000Z',
      },
      // Channel JID — should be skipped
      'slack:gidc:channel:general': {
        name: 'slack:gidc:channel:general',
        folder: 'gidc-template-staff',
        trigger: '@Andy',
        added_at: '2026-01-04T00:00:00.000Z',
      },
    };

    const snapshot = buildUsersSnapshot(registeredGroups, 'gidc');

    expect(snapshot.namespace).toBe('gidc');
    expect(snapshot.users).toHaveLength(2);

    const owner = snapshot.users.find((u) => u.slackUserId === 'U123');
    expect(owner).toBeDefined();
    expect(owner?.jid).toBe('slack:gidc:U123');
    expect(owner?.tier).toBe('owner');
    expect(owner?.remindersAccess).toBe(true);
    expect(owner?.calendarAccess).toBe(true);
    expect(owner?.addedAt).toBe('2026-01-01T00:00:00.000Z');

    const staff = snapshot.users.find((u) => u.slackUserId === 'U456');
    expect(staff).toBeDefined();
    expect(staff?.tier).toBe('staff');
    expect(staff?.remindersAccess).toBe(false);
    expect(staff?.calendarAccess).toBe(false);
  });

  it('returns empty array when no GIDC users', () => {
    const registeredGroups: Record<string, RegisteredGroup> = {
      'main@g.us': {
        name: 'Main',
        folder: 'main',
        trigger: 'always',
        added_at: '2026-01-01T00:00:00.000Z',
        isMain: true,
      },
      'slack:other:U999': {
        name: 'slack:other:U999',
        folder: 'gidc-template-staff',
        trigger: '@Andy',
        added_at: '2026-01-01T00:00:00.000Z',
      },
    };

    const snapshot = buildUsersSnapshot(registeredGroups, 'gidc');

    expect(snapshot.namespace).toBe('gidc');
    expect(snapshot.users).toHaveLength(0);
    expect(snapshot.generatedAt).toBeDefined();
  });
});

describe('writeUsersSnapshot', () => {
  it('writes snapshot JSON to IPC directory and verifies content', () => {
    const registeredGroups: Record<string, RegisteredGroup> = {
      'slack:gidc:U100': {
        name: 'slack:gidc:U100',
        folder: 'gidc-template-assistant',
        trigger: '@Andy',
        added_at: '2026-02-01T00:00:00.000Z',
        remindersAccess: true,
        calendarAccess: true,
      },
    };

    writeUsersSnapshot('gidc-template-owner', registeredGroups, 'gidc', tmpDir);

    const snapshotPath = path.join(
      tmpDir,
      'ipc',
      'gidc-template-owner',
      'users_snapshot.json',
    );
    expect(fs.existsSync(snapshotPath)).toBe(true);

    const content = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'));
    expect(content.namespace).toBe('gidc');
    expect(content.generatedAt).toBeDefined();
    expect(content.users).toHaveLength(1);
    expect(content.users[0].slackUserId).toBe('U100');
    expect(content.users[0].jid).toBe('slack:gidc:U100');
    expect(content.users[0].tier).toBe('assistant');
    expect(content.users[0].remindersAccess).toBe(true);
    expect(content.users[0].calendarAccess).toBe(true);
    expect(content.users[0].addedAt).toBe('2026-02-01T00:00:00.000Z');
  });
});
