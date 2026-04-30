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

// Hoisted mock for fs.createReadStream
const mockCreateReadStream = vi.hoisted(() => vi.fn().mockReturnValue({}));

// Hoisted mock for fs.readFileSync (used by compactUserMentions / expandUserMentions
// to load identity-index.json). Default: no index file (readFileSync throws).
const mockReadFileSync = vi.hoisted(() =>
  vi.fn((..._args: unknown[]): string => {
    throw new Error('ENOENT');
  }),
);

vi.mock("fs", () => ({
  default: {
    createReadStream: mockCreateReadStream,
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: mockReadFileSync,
    appendFileSync: vi.fn(),
  },
  createReadStream: mockCreateReadStream,
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: mockReadFileSync,
  appendFileSync: vi.fn(),
}));


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
      filesUploadV2: mockFilesUploadV2,
    };

    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn().mockResolvedValue(undefined);
    message = vi.fn();
    event = vi.fn();
    error = vi.fn();

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

  // --- compactUserMentions (name → user ID resolution) ---

  describe('compactUserMentions via sendMessage', () => {
    const sampleIndex = {
      // Sean: handle + first+last + no display_name, unique first name
      'slack:joiito:UMS3X3U4S': {
        name: 'seanbonner',
        handle: 'sean',
        first_name: 'Sean',
        last_name: 'Bonner',
        tier: 'guest',
        domains: [],
        display_name: '',
        email: 'Sean@seanbonner.com',
      },
      // Jane: also has a display_name
      'slack:joiito:UJANE001': {
        name: 'janedoe',
        handle: 'jane',
        first_name: 'Jane',
        last_name: 'Doe',
        tier: 'guest',
        domains: [],
        display_name: 'jane',
        email: 'jane@example.com',
      },
      // Two Marks → first-name "mark" is ambiguous
      'slack:joiito:UMARK001': {
        name: 'markone',
        first_name: 'Mark',
        last_name: 'One',
        tier: 'guest',
        domains: [],
        display_name: '',
        email: 'mark1@example.com',
      },
      'slack:joiito:UMARK002': {
        name: 'marktwo',
        first_name: 'Mark',
        last_name: 'Two',
        tier: 'guest',
        domains: [],
        display_name: '',
        email: 'mark2@example.com',
      },
      // Entry in a different namespace — must not leak into joiito's map
      'slack:cit:UCIT001': {
        name: 'citbob',
        handle: 'bob',
        first_name: 'Bob',
        last_name: 'Smith',
        tier: 'guest',
        domains: [],
        display_name: '',
        email: 'bob@example.com',
      },
      // Channel entry in joiito — must be ignored
      'slack:joiito:channel:CGEN0001': {
        name: 'general',
        tier: 'guest',
        domains: [],
        display_name: '',
        email: '',
      },
      // Email-keyed entry — must be ignored
      'other@example.com': {
        name: 'Someone Else',
        tier: 'friend',
        domains: [],
        display_name: '',
        email: 'other@example.com',
      },
    };

    beforeEach(() => {
      mockReadFileSync.mockReturnValue(JSON.stringify(sampleIndex));
    });

    async function sentText(text: string, namespace = 'joiito'): Promise<string> {
      const channel = new SlackChannel(createOpts({ namespace }));
      const app = currentApp();
      await channel.connect();
      await channel.sendMessage(`slack:${namespace}:channel:CTEST001`, text);
      const call = app.client.chat.postMessage.mock.calls.at(-1)?.[0];
      return call?.text ?? '';
    }

    it('resolves @seanbonner (name) to <@UMS3X3U4S>', async () => {
      const out = await sentText('hey @seanbonner can you look at this');
      expect(out).toContain('<@UMS3X3U4S>');
      expect(out).not.toContain('@seanbonner');
    });

    it('resolves @Sean Bonner (first + last) to <@UMS3X3U4S>', async () => {
      const out = await sentText('cc @Sean Bonner on this');
      expect(out).toContain('<@UMS3X3U4S>');
    });

    it('resolves @Sean (unambiguous first name) to <@UMS3X3U4S>', async () => {
      const out = await sentText('thanks @Sean!');
      expect(out).toContain('<@UMS3X3U4S>');
    });

    it('is case-insensitive on every alias', async () => {
      const a = await sentText('@SEANBONNER hi');
      const b = await sentText('@SEAN BONNER hi');
      const c = await sentText('@sean hi');
      expect(a).toContain('<@UMS3X3U4S>');
      expect(b).toContain('<@UMS3X3U4S>');
      expect(c).toContain('<@UMS3X3U4S>');
    });

    it('resolves @sean (handle) to <@UMS3X3U4S>', async () => {
      const out = await sentText('ping @sean');
      expect(out).toContain('<@UMS3X3U4S>');
    });

    it('does NOT resolve @Mark (ambiguous first name shared across users)', async () => {
      const out = await sentText('hi @Mark');
      expect(out).not.toContain('<@UMARK001>');
      expect(out).not.toContain('<@UMARK002>');
      expect(out).toContain('@Mark');
    });

    it('still resolves @Mark One (full name, unambiguous)', async () => {
      const out = await sentText('assigning @Mark One');
      expect(out).toContain('<@UMARK001>');
    });

    it('ignores entries from other namespaces', async () => {
      const out = await sentText('@Bob Smith says hi');
      expect(out).not.toContain('<@UCIT001>');
    });

    it('resolves cross-namespace when the channel runs in that namespace', async () => {
      const out = await sentText('@Bob Smith says hi', 'cit');
      expect(out).toContain('<@UCIT001>');
    });

    it('leaves unknown names untouched', async () => {
      const out = await sentText('@NobodyReal ping');
      expect(out).toContain('@NobodyReal');
    });
  });

  // --- sendFile ---

  describe('sendFile', () => {
    it('uploads a file to a channel JID', async () => {
      const channel = new SlackChannel(createOpts({ namespace: 'gidc' }));
      await channel.connect();

      await channel.sendFile('slack:gidc:channel:C67890DEF', '/tmp/report.pdf', 'report.pdf', 'application/pdf');

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

      await channel.sendFile('slack:gidc:UGIDC456', '/tmp/doc.txt', 'doc.txt', 'text/plain');

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
        channel.sendFile('slack:gidc:channel:C67890DEF', '/tmp/report.pdf', 'report.pdf', 'application/pdf'),
      ).rejects.toThrow('upload_failed');
    });

    it('forwards caption as initial_comment when provided', async () => {
      const channel = new SlackChannel(createOpts({ namespace: 'gidc' }));
      await channel.connect();

      await channel.sendFile(
        'slack:gidc:channel:C67890DEF',
        '/tmp/report.pdf',
        'report.pdf',
        'application/pdf',
        'Bhutan Tea onboarding PDF',
      );

      expect(mockFilesUploadV2).toHaveBeenCalledWith(
        expect.objectContaining({
          channel_id: 'C67890DEF',
          filename: 'report.pdf',
          initial_comment: 'Bhutan Tea onboarding PDF',
        }),
      );
    });

    it('omits initial_comment when caption is not provided', async () => {
      const channel = new SlackChannel(createOpts({ namespace: 'gidc' }));
      await channel.connect();

      await channel.sendFile(
        'slack:gidc:channel:C67890DEF',
        '/tmp/report.pdf',
        'report.pdf',
        'application/pdf',
      );

      expect(mockFilesUploadV2).toHaveBeenCalledWith(
        expect.not.objectContaining({ initial_comment: expect.anything() }),
      );
    });

    it('accepts mimetype param for signature symmetry (Slack auto-detects)', async () => {
      const channel = new SlackChannel(createOpts({ namespace: 'gidc' }));
      await channel.connect();

      await channel.sendFile(
        'slack:gidc:channel:C67890DEF',
        '/tmp/doc.docx',
        'doc.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      );

      expect(mockFilesUploadV2).toHaveBeenCalledWith(
        expect.objectContaining({ filename: 'doc.docx' }),
      );
    });

    it('rejects with a timeout error when filesUploadV2 hangs', async () => {
      const channel = new SlackChannel(createOpts({ namespace: 'gidc' }));

      // Connect with real timers so app.start() etc. resolve normally
      await channel.connect();

      // Switch to fake timers after connect is done
      vi.useFakeTimers();
      // Replace filesUploadV2 with a never-resolving promise (simulates production hang)
      mockFilesUploadV2.mockReturnValue(new Promise<never>(() => {}));

      const sendPromise = channel.sendFile(
        'slack:gidc:channel:C67890DEF',
        '/tmp/test.pdf',
        'test.pdf',
        'application/pdf',
      );

      // Attach the rejection assertion BEFORE advancing timers so the catch handler
      // is registered before the fake setTimeout fires — avoids Node.js
      // "PromiseRejectionHandledWarning: Promise rejection was handled asynchronously"
      const assertion = expect(sendPromise).rejects.toThrow(/timed out after 60s/);

      // Advance fake timers past the 60s timeout
      await vi.advanceTimersByTimeAsync(60_001);

      await assertion;
      vi.useRealTimers();
    });
  });
});
