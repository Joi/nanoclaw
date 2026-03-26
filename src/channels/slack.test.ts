import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Hoisted mock for files.uploadV2 — accessible in both MockApp and tests
const mockFilesUploadV2 = vi.hoisted(() => vi.fn().mockResolvedValue({ ok: true }));


// Use vi.hoisted to capture app instances created inside the constructor
const appRef = vi.hoisted(() => ({ current: null as any }));

vi.mock('@slack/bolt', () => {
  class MockApp {
    client = {
      auth: {
        test: vi.fn().mockResolvedValue({ user_id: 'UBOTID', team: 'Test Team' }),
      },
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true }),
      },
      conversations: {
        open: vi.fn().mockResolvedValue({ channel: { id: 'D12345' } }),
      },
      users: {
        info: vi.fn().mockResolvedValue({
          user: {
            profile: { display_name: 'Test User' },
            real_name: 'Test User Real',
            name: 'testuser',
          },
        }),
      },
      files: { uploadV2: mockFilesUploadV2 },
    };

    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn().mockResolvedValue(undefined);
    message = vi.fn();

    constructor(_opts: unknown) {
      appRef.current = this;
    }
  }

  return {
    App: MockApp,
    LogLevel: {
      DEBUG: 'DEBUG',
      INFO: 'INFO',
      WARN: 'WARN',
      ERROR: 'ERROR',
    },
  };
});

import { SlackChannel, SlackChannelOpts } from './slack.js';

// --- Test helpers ---

function createOpts(overrides?: Partial<SlackChannelOpts>): SlackChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({})),
    slackBotToken: 'xoxb-test-token',
    slackAppToken: 'xapp-test-token',
    slackSigningSecret: 'test-signing-secret',
    ...overrides,
  };
}

function currentApp() {
  return appRef.current;
}

// --- Tests ---

describe('SlackChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "slack" with no namespace', () => {
      const channel = new SlackChannel(createOpts());
      expect(channel.name).toBe('slack');
    });

    it('has name "slack-cit" for cit namespace', () => {
      const channel = new SlackChannel(createOpts({ namespace: 'cit' }));
      expect(channel.name).toBe('slack-cit');
    });

    it('has name "slack-gidc" for gidc namespace', () => {
      const channel = new SlackChannel(createOpts({ namespace: 'gidc' }));
      expect(channel.name).toBe('slack-gidc');
    });
  });

  // --- ownsJid — default (no namespace) ---

  describe('ownsJid — default (no namespace)', () => {
    let channel: SlackChannel;

    beforeEach(() => {
      channel = new SlackChannel(createOpts());
    });

    it('owns slack:U... (user DM JID)', () => {
      expect(channel.ownsJid('slack:UABC123')).toBe(true);
    });

    it('owns slack:U... with long user ID', () => {
      expect(channel.ownsJid('slack:U01ABCDEF')).toBe(true);
    });

    it('owns slack:channel:C... (channel JID)', () => {
      expect(channel.ownsJid('slack:channel:CABC123')).toBe(true);
    });

    it('owns slack:channel:C... with long channel ID', () => {
      expect(channel.ownsJid('slack:channel:C01ABCDEF')).toBe(true);
    });

    it('does NOT own slack:cit:U... JIDs', () => {
      expect(channel.ownsJid('slack:cit:UABC123')).toBe(false);
    });

    it('does NOT own slack:cit:channel:C... JIDs', () => {
      expect(channel.ownsJid('slack:cit:channel:CABC123')).toBe(false);
    });

    it('does NOT own slack:gidc:U... JIDs', () => {
      expect(channel.ownsJid('slack:gidc:UABC123')).toBe(false);
    });

    it('does NOT own slack:gidc:channel:C... JIDs', () => {
      expect(channel.ownsJid('slack:gidc:channel:CABC123')).toBe(false);
    });

    it('does NOT own tg:... JIDs', () => {
      expect(channel.ownsJid('tg:100200300')).toBe(false);
    });

    it('does NOT own WhatsApp @g.us JIDs', () => {
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('does NOT own WhatsApp @s.whatsapp.net JIDs', () => {
      expect(channel.ownsJid('12345@s.whatsapp.net')).toBe(false);
    });

    it('does NOT own sig:... JIDs', () => {
      expect(channel.ownsJid('sig:+819048411965')).toBe(false);
    });

    it('does NOT own unrecognized JIDs', () => {
      expect(channel.ownsJid('random-string')).toBe(false);
    });
  });

  // --- ownsJid — cit namespace ---

  describe('ownsJid — cit namespace', () => {
    let channel: SlackChannel;

    beforeEach(() => {
      channel = new SlackChannel(createOpts({ namespace: 'cit' }));
    });

    it('owns slack:cit:U... JIDs', () => {
      expect(channel.ownsJid('slack:cit:UABC123')).toBe(true);
    });

    it('owns slack:cit:channel:C... JIDs', () => {
      expect(channel.ownsJid('slack:cit:channel:CABC123')).toBe(true);
    });

    it('does NOT own slack:U... (default namespace) JIDs', () => {
      expect(channel.ownsJid('slack:UABC123')).toBe(false);
    });

    it('does NOT own slack:gidc:U... JIDs', () => {
      expect(channel.ownsJid('slack:gidc:UABC123')).toBe(false);
    });

    it('does NOT own slack:channel:C... (default namespace) JIDs', () => {
      expect(channel.ownsJid('slack:channel:CABC123')).toBe(false);
    });

    it('does NOT own tg:... JIDs', () => {
      expect(channel.ownsJid('tg:100200300')).toBe(false);
    });

    it('does NOT own WhatsApp @g.us JIDs', () => {
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });
  });

  // --- ownsJid — gidc namespace ---

  describe('ownsJid — gidc namespace', () => {
    let channel: SlackChannel;

    beforeEach(() => {
      channel = new SlackChannel(createOpts({ namespace: 'gidc' }));
    });

    it('owns slack:gidc:U... JIDs', () => {
      expect(channel.ownsJid('slack:gidc:UABC123')).toBe(true);
    });

    it('owns slack:gidc:channel:C... JIDs', () => {
      expect(channel.ownsJid('slack:gidc:channel:CABC123')).toBe(true);
    });

    it('does NOT own slack:U... (default namespace) JIDs', () => {
      expect(channel.ownsJid('slack:UABC123')).toBe(false);
    });

    it('does NOT own slack:cit:U... JIDs', () => {
      expect(channel.ownsJid('slack:cit:UABC123')).toBe(false);
    });

    it('does NOT own slack:channel:C... (default namespace) JIDs', () => {
      expect(channel.ownsJid('slack:channel:CABC123')).toBe(false);
    });

    it('does NOT own slack:cit:channel:C... JIDs', () => {
      expect(channel.ownsJid('slack:cit:channel:CABC123')).toBe(false);
    });

    it('does NOT own tg:... JIDs', () => {
      expect(channel.ownsJid('tg:100200300')).toBe(false);
    });

    it('does NOT own WhatsApp @g.us JIDs', () => {
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });
  });

  // --- Three-instance isolation ---

  describe('three-instance isolation', () => {
    it('each instance only owns its own DM JIDs', () => {
      const defaultChannel = new SlackChannel(createOpts());
      const citChannel = new SlackChannel(createOpts({ namespace: 'cit' }));
      const gidcChannel = new SlackChannel(createOpts({ namespace: 'gidc' }));

      const defaultDm = 'slack:UABC123';
      const citDm = 'slack:cit:UABC123';
      const gidcDm = 'slack:gidc:UABC123';

      // Default owns only default DM
      expect(defaultChannel.ownsJid(defaultDm)).toBe(true);
      expect(defaultChannel.ownsJid(citDm)).toBe(false);
      expect(defaultChannel.ownsJid(gidcDm)).toBe(false);

      // CIT owns only cit DM
      expect(citChannel.ownsJid(defaultDm)).toBe(false);
      expect(citChannel.ownsJid(citDm)).toBe(true);
      expect(citChannel.ownsJid(gidcDm)).toBe(false);

      // GIDC owns only gidc DM
      expect(gidcChannel.ownsJid(defaultDm)).toBe(false);
      expect(gidcChannel.ownsJid(citDm)).toBe(false);
      expect(gidcChannel.ownsJid(gidcDm)).toBe(true);
    });

    it('each instance only owns its own channel JIDs', () => {
      const defaultChannel = new SlackChannel(createOpts());
      const citChannel = new SlackChannel(createOpts({ namespace: 'cit' }));
      const gidcChannel = new SlackChannel(createOpts({ namespace: 'gidc' }));

      const defaultChan = 'slack:channel:CABC123';
      const citChan = 'slack:cit:channel:CABC123';
      const gidcChan = 'slack:gidc:channel:CABC123';

      // Default owns only default channel
      expect(defaultChannel.ownsJid(defaultChan)).toBe(true);
      expect(defaultChannel.ownsJid(citChan)).toBe(false);
      expect(defaultChannel.ownsJid(gidcChan)).toBe(false);

      // CIT owns only cit channel
      expect(citChannel.ownsJid(defaultChan)).toBe(false);
      expect(citChannel.ownsJid(citChan)).toBe(true);
      expect(citChannel.ownsJid(gidcChan)).toBe(false);

      // GIDC owns only gidc channel
      expect(gidcChannel.ownsJid(defaultChan)).toBe(false);
      expect(gidcChannel.ownsJid(citChan)).toBe(false);
      expect(gidcChannel.ownsJid(gidcChan)).toBe(true);
    });

    it('all three instances have distinct names', () => {
      const defaultChannel = new SlackChannel(createOpts());
      const citChannel = new SlackChannel(createOpts({ namespace: 'cit' }));
      const gidcChannel = new SlackChannel(createOpts({ namespace: 'gidc' }));

      const names = new Set([defaultChannel.name, citChannel.name, gidcChannel.name]);
      expect(names.size).toBe(3);
      expect(defaultChannel.name).toBe('slack');
      expect(citChannel.name).toBe('slack-cit');
      expect(gidcChannel.name).toBe('slack-gidc');
    });
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('isConnected() returns false before connect', () => {
      const channel = new SlackChannel(createOpts());
      expect(channel.isConnected()).toBe(false);
    });

    it('isConnected() returns true after connect', async () => {
      const channel = new SlackChannel(createOpts());
      await channel.connect();
      expect(channel.isConnected()).toBe(true);
    });

    it('calls app.start() on connect', async () => {
      const channel = new SlackChannel(createOpts());
      const app = currentApp();
      await channel.connect();
      expect(app.start).toHaveBeenCalled();
    });

    it('calls auth.test() on connect to get bot user ID', async () => {
      const channel = new SlackChannel(createOpts());
      const app = currentApp();
      await channel.connect();
      expect(app.client.auth.test).toHaveBeenCalled();
    });

    it('disconnect() sets isConnected to false', async () => {
      const channel = new SlackChannel(createOpts());
      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });

    it('disconnect() calls app.stop()', async () => {
      const channel = new SlackChannel(createOpts());
      const app = currentApp();
      await channel.connect();
      await channel.disconnect();
      expect(app.stop).toHaveBeenCalled();
    });

    it('isConnected() returns false after disconnect', async () => {
      const channel = new SlackChannel(createOpts());
      await channel.connect();
      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends to a channel JID by extracting channel ID', async () => {
      const channel = new SlackChannel(createOpts());
      const app = currentApp();
      await channel.connect();

      await channel.sendMessage('slack:channel:CABC123', 'Hello channel!');

      expect(app.client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'CABC123',
        text: 'Hello channel!',
      });
    });

    it('sends to a namespaced channel JID by extracting channel ID', async () => {
      const channel = new SlackChannel(createOpts({ namespace: 'cit' }));
      const app = currentApp();
      await channel.connect();

      await channel.sendMessage('slack:cit:channel:CABC123', 'Hello CIT!');

      expect(app.client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'CABC123',
        text: 'Hello CIT!',
      });
    });

    it('opens a DM conversation for a user JID', async () => {
      const channel = new SlackChannel(createOpts());
      const app = currentApp();
      app.client.conversations.open.mockResolvedValueOnce({
        channel: { id: 'D99999' },
      });
      await channel.connect();

      await channel.sendMessage('slack:UABC123', 'Hello DM!');

      expect(app.client.conversations.open).toHaveBeenCalledWith({
        users: 'UABC123',
      });
      expect(app.client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'D99999',
        text: 'Hello DM!',
      });
    });

    it('opens a DM conversation for a namespaced user JID', async () => {
      const channel = new SlackChannel(createOpts({ namespace: 'cit' }));
      const app = currentApp();
      app.client.conversations.open.mockResolvedValueOnce({
        channel: { id: 'D88888' },
      });
      await channel.connect();

      await channel.sendMessage('slack:cit:UABC123', 'Hello namespaced DM!');

      expect(app.client.conversations.open).toHaveBeenCalledWith({
        users: 'UABC123',
      });
      expect(app.client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'D88888',
        text: 'Hello namespaced DM!',
      });
    });

    it('throws when conversations.open returns no channel ID', async () => {
      const channel = new SlackChannel(createOpts());
      const app = currentApp();
      app.client.conversations.open.mockResolvedValueOnce({ channel: null });
      await channel.connect();

      await expect(
        channel.sendMessage('slack:UABC123', 'Hello'),
      ).rejects.toThrow('Failed to open DM with UABC123');
    });
  });

  // --- sendFile ---

  describe('sendFile', () => {
    it('uploads a file to a channel JID', async () => {
      const channel = new SlackChannel(createOpts({ namespace: 'gidc' }));
      await channel.connect();

      await channel.sendFile('slack:gidc:channel:C67890DEF', '/tmp/report.pdf', 'report.pdf');

      expect(mockFilesUploadV2).toHaveBeenCalledWith(
        expect.objectContaining({
          channel_id: 'C67890DEF',
          filename: 'report.pdf',
        }),
      );
    });

    it('uploads a file to a DM JID', async () => {
      const channel = new SlackChannel(createOpts({ namespace: 'gidc' }));
      const app = currentApp();
      app.client.conversations.open.mockResolvedValueOnce({
        channel: { id: 'D_DM_CHAN' },
      });
      await channel.connect();

      await channel.sendFile('slack:gidc:UGIDC456', '/tmp/doc.txt', 'doc.txt');

      expect(app.client.conversations.open).toHaveBeenCalledWith({
        users: 'UGIDC456',
      });
      expect(mockFilesUploadV2).toHaveBeenCalledWith(
        expect.objectContaining({
          channel_id: 'D_DM_CHAN',
          filename: 'doc.txt',
        }),
      );
    });

    it('throws on upload failure', async () => {
      const channel = new SlackChannel(createOpts({ namespace: 'gidc' }));
      mockFilesUploadV2.mockRejectedValueOnce(new Error('upload_failed'));
      await channel.connect();

      await expect(
        channel.sendFile('slack:gidc:channel:C67890DEF', '/tmp/report.pdf', 'report.pdf'),
      ).rejects.toThrow('upload_failed');
    });
  });
});
