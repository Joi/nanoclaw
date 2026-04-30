import { describe, it, expect, vi, beforeEach } from 'vitest';

import { processMessageIpc, IpcDeps } from './ipc.js';
import type { RegisteredGroup } from './types.js';

// --- Mocks ---

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('./db.js', () => ({
  createTask: vi.fn(),
  deleteTask: vi.fn(),
  getTaskById: vi.fn(),
  updateTask: vi.fn(),
}));

vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/ipc-test-data',
  GROUPS_DIR: '/tmp/ipc-test-groups',
  IPC_POLL_INTERVAL: 1000,
  TIMEZONE: 'UTC',
}));

vi.mock('./group-folder.js', () => ({
  isValidGroupFolder: vi.fn(() => true),
  resolveGroupIpcPath: vi.fn(() => '/tmp/ipc-test-ipc'),
}));

vi.mock('./sender-allowlist.js', () => ({
  addAllowlistEntry: vi.fn(),
  removeAllowlistEntry: vi.fn(),
}));

vi.mock('./observations.js', () => ({
  parseObservation: vi.fn(),
  writePendingObservation: vi.fn(),
}));

vi.mock('cron-parser', () => ({
  CronExpressionParser: {
    parse: vi.fn(() => ({ next: () => ({ toISOString: () => '2026-05-01T00:00:00.000Z' }) })),
  },
}));

// --- Helpers ---

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@jibot',
  added_at: '2024-01-01T00:00:00.000Z',
};

function makeDeps(overrides?: Partial<IpcDeps>): IpcDeps {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendFile: vi.fn().mockResolvedValue(undefined),
    registeredGroups: vi.fn(() => ({})),
    registerGroup: vi.fn(),
    syncGroups: vi.fn().mockResolvedValue(undefined),
    getAvailableGroups: vi.fn(() => []),
    writeGroupsSnapshot: vi.fn(),
    onTasksChanged: vi.fn(),
    ...overrides,
  };
}

// --- Tests ---

describe('processMessageIpc', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- "message" branch (regression: existing behaviour must not break) ---

  describe('"message" branch', () => {
    it('calls deps.sendMessage when isMain', async () => {
      const deps = makeDeps();
      const groups = { 'target@g.us': testGroup };

      await processMessageIpc(
        { type: 'message', chatJid: 'target@g.us', text: 'hello' },
        'other-group',
        true,
        deps,
        groups,
      );

      expect(deps.sendMessage).toHaveBeenCalledWith('target@g.us', 'hello');
      expect(deps.sendFile).not.toHaveBeenCalled();
    });

    it('calls deps.sendMessage when own group', async () => {
      const deps = makeDeps();
      const groups = { 'target@g.us': testGroup };

      await processMessageIpc(
        { type: 'message', chatJid: 'target@g.us', text: 'hi' },
        'test-group',
        false,
        deps,
        groups,
      );

      expect(deps.sendMessage).toHaveBeenCalledWith('target@g.us', 'hi');
    });

    it('blocks message from unauthorized group', async () => {
      const deps = makeDeps();
      const groups = { 'target@g.us': testGroup };

      await processMessageIpc(
        { type: 'message', chatJid: 'target@g.us', text: 'sneaky' },
        'other-group',
        false,
        deps,
        groups,
      );

      expect(deps.sendMessage).not.toHaveBeenCalled();
    });
  });

  // --- "file" branch ---

  describe('"file" branch', () => {
    it('calls deps.sendFile with all params when isMain', async () => {
      const deps = makeDeps();
      const groups = { 'target@g.us': testGroup };

      await processMessageIpc(
        {
          type: 'file',
          chatJid: 'target@g.us',
          filePath: '/tmp/report.pdf',
          filename: 'report.pdf',
          mimetype: 'application/pdf',
          caption: 'Here is the report',
        },
        'source-group',
        true,
        deps,
        groups,
      );

      expect(deps.sendFile).toHaveBeenCalledWith(
        'target@g.us',
        '/tmp/report.pdf',
        'report.pdf',
        'application/pdf',
        'Here is the report',
      );
      expect(deps.sendMessage).not.toHaveBeenCalled();
    });

    it('calls deps.sendFile when own group (no caption)', async () => {
      const deps = makeDeps();
      const groups = { 'target@g.us': testGroup };

      await processMessageIpc(
        {
          type: 'file',
          chatJid: 'target@g.us',
          filePath: '/tmp/doc.pdf',
          filename: 'doc.pdf',
          mimetype: 'application/pdf',
        },
        'test-group',
        false,
        deps,
        groups,
      );

      expect(deps.sendFile).toHaveBeenCalledWith(
        'target@g.us',
        '/tmp/doc.pdf',
        'doc.pdf',
        'application/pdf',
        undefined,
      );
    });

    it('blocks file send from unauthorized group', async () => {
      const deps = makeDeps();
      const groups = { 'target@g.us': testGroup };

      await processMessageIpc(
        {
          type: 'file',
          chatJid: 'target@g.us',
          filePath: '/tmp/doc.pdf',
          filename: 'doc.pdf',
          mimetype: 'application/pdf',
        },
        'other-group',
        false,
        deps,
        groups,
      );

      expect(deps.sendFile).not.toHaveBeenCalled();
    });

    it('ignores payload with missing filePath (file consumed without sending)', async () => {
      const deps = makeDeps();
      const groups = { 'target@g.us': testGroup };

      await processMessageIpc(
        {
          type: 'file',
          chatJid: 'target@g.us',
          // filePath intentionally omitted
          filename: 'doc.pdf',
          mimetype: 'application/pdf',
        },
        'test-group',
        true,
        deps,
        groups,
      );

      expect(deps.sendFile).not.toHaveBeenCalled();
    });

    it('ignores payload with missing mimetype', async () => {
      const deps = makeDeps();
      const groups = { 'target@g.us': testGroup };

      await processMessageIpc(
        {
          type: 'file',
          chatJid: 'target@g.us',
          filePath: '/tmp/doc.pdf',
          filename: 'doc.pdf',
          // mimetype intentionally omitted
        },
        'test-group',
        true,
        deps,
        groups,
      );

      expect(deps.sendFile).not.toHaveBeenCalled();
    });
  });
});
