import { beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase, setRegisteredGroup } from './db.js';
import { processTaskIpc, IpcDeps } from './ipc.js';
import { RegisteredGroup } from './types.js';

// Mock sender-allowlist functions
vi.mock('./sender-allowlist.js', () => ({
  addAllowlistEntry: vi.fn(),
  removeAllowlistEntry: vi.fn(),
}));

import {
  addAllowlistEntry,
  removeAllowlistEntry,
} from './sender-allowlist.js';

const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'whatsapp_main',
  trigger: 'always',
  added_at: '2024-01-01T00:00:00.000Z',
  isMain: true,
};

const OTHER_GROUP: RegisteredGroup = {
  name: 'Other',
  folder: 'other-group',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

let groups: Record<string, RegisteredGroup>;
let deps: IpcDeps;
let registerGroupCalls: Array<[string, RegisteredGroup]>;

beforeEach(() => {
  _initTestDatabase();
  vi.clearAllMocks();

  groups = {
    'main@g.us': MAIN_GROUP,
    'other@g.us': OTHER_GROUP,
  };

  setRegisteredGroup('main@g.us', MAIN_GROUP);
  setRegisteredGroup('other@g.us', OTHER_GROUP);

  registerGroupCalls = [];

  deps = {
    sendMessage: async () => {},
    sendFile: async () => {},
    registeredGroups: () => groups,
    registerGroup: (jid, group) => {
      groups[jid] = group;
      setRegisteredGroup(jid, group);
      registerGroupCalls.push([jid, group]);
    },
    syncGroups: async () => {},
    getAvailableGroups: () => [],
    writeGroupsSnapshot: () => {},
    onTasksChanged: () => {},
  };
});

// --- security check ---

describe('user_manage security check', () => {
  it('blocks non-main group from user_manage', async () => {
    await processTaskIpc(
      {
        type: 'user_manage',
        action: 'add',
        slackUserId: 'U123',
        namespace: 'testns',
        tier: 'staff',
      },
      'other-group',
      false,
      deps,
    );

    expect(registerGroupCalls).toHaveLength(0);
    expect(addAllowlistEntry).not.toHaveBeenCalled();
  });
});

// --- validation ---

describe('user_manage validation', () => {
  it('rejects when slackUserId is missing', async () => {
    await processTaskIpc(
      {
        type: 'user_manage',
        action: 'add',
        namespace: 'testns',
        tier: 'staff',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(registerGroupCalls).toHaveLength(0);
    expect(addAllowlistEntry).not.toHaveBeenCalled();
  });

  it('rejects when namespace is missing', async () => {
    await processTaskIpc(
      {
        type: 'user_manage',
        action: 'add',
        slackUserId: 'U123',
        tier: 'staff',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(registerGroupCalls).toHaveLength(0);
    expect(addAllowlistEntry).not.toHaveBeenCalled();
  });
});

// --- add action ---

describe('user_manage add action', () => {
  it('registers group and adds allowlist entry for staff tier', async () => {
    await processTaskIpc(
      {
        type: 'user_manage',
        action: 'add',
        slackUserId: 'U123',
        namespace: 'testns',
        tier: 'staff',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(registerGroupCalls).toHaveLength(1);
    const [jid, group] = registerGroupCalls[0];
    expect(jid).toBe('slack:testns:U123');
    expect(group.folder).toBe('gidc-U123');
    // spec: name defaults to `GIDC ${tier} (${slackUserId})`
    expect(group.name).toBe('GIDC staff (U123)');
    // spec: trigger is '@gibot'
    expect(group.trigger).toBe('@gibot');
    // spec: requiresTrigger is false
    expect(group.requiresTrigger).toBe(false);
    // staff is not admin tier — remindersAccess/calendarAccess are false (not undefined)
    expect(group.remindersAccess).toBe(false);
    expect(group.calendarAccess).toBe(false);

    expect(addAllowlistEntry).toHaveBeenCalledWith('slack:testns:U123', {
      allow: '*',
      mode: 'trigger',
    });
  });

  it('uses provided name when name is specified', async () => {
    await processTaskIpc(
      {
        type: 'user_manage',
        action: 'add',
        slackUserId: 'U123',
        namespace: 'testns',
        tier: 'staff',
        name: 'Alice Johnson',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(registerGroupCalls).toHaveLength(1);
    const [, group] = registerGroupCalls[0];
    expect(group.name).toBe('Alice Johnson');
  });

  it('registers group with reminders+calendar access for owner tier (admin)', async () => {
    await processTaskIpc(
      {
        type: 'user_manage',
        action: 'add',
        slackUserId: 'U456',
        namespace: 'testns',
        tier: 'owner',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(registerGroupCalls).toHaveLength(1);
    const [jid, group] = registerGroupCalls[0];
    expect(jid).toBe('slack:testns:U456');
    expect(group.folder).toBe('gidc-U456');
    expect(group.name).toBe('GIDC owner (U456)');
    expect(group.trigger).toBe('@gibot');
    expect(group.requiresTrigger).toBe(false);
    expect(group.remindersAccess).toBe(true);
    expect(group.calendarAccess).toBe(true);

    expect(addAllowlistEntry).toHaveBeenCalledWith('slack:testns:U456', {
      allow: '*',
      mode: 'trigger',
    });
  });

  it('registers group with reminders+calendar access for assistant tier (admin)', async () => {
    await processTaskIpc(
      {
        type: 'user_manage',
        action: 'add',
        slackUserId: 'U789',
        namespace: 'testns',
        tier: 'assistant',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(registerGroupCalls).toHaveLength(1);
    const [jid, group] = registerGroupCalls[0];
    expect(jid).toBe('slack:testns:U789');
    expect(group.folder).toBe('gidc-U789');
    expect(group.name).toBe('GIDC admin (U789)');
    expect(group.trigger).toBe('@gibot');
    expect(group.requiresTrigger).toBe(false);
    expect(group.remindersAccess).toBe(true);
    expect(group.calendarAccess).toBe(true);
  });

  it('rejects add with invalid tier', async () => {
    await processTaskIpc(
      {
        type: 'user_manage',
        action: 'add',
        slackUserId: 'U123',
        namespace: 'testns',
        tier: 'superadmin',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(registerGroupCalls).toHaveLength(0);
    expect(addAllowlistEntry).not.toHaveBeenCalled();
  });

  it('constructs userJid as slack:namespace:slackUserId', async () => {
    await processTaskIpc(
      {
        type: 'user_manage',
        action: 'add',
        slackUserId: 'UABC123',
        namespace: 'myorg',
        tier: 'staff',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(registerGroupCalls[0][0]).toBe('slack:myorg:UABC123');
    expect(addAllowlistEntry).toHaveBeenCalledWith(
      'slack:myorg:UABC123',
      expect.any(Object),
    );
  });
});

// --- remove action ---

describe('user_manage remove action', () => {
  it('removes allowlist entry only (does not call registerGroup)', async () => {
    await processTaskIpc(
      {
        type: 'user_manage',
        action: 'remove',
        slackUserId: 'U123',
        namespace: 'testns',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(removeAllowlistEntry).toHaveBeenCalledWith('slack:testns:U123');
    expect(registerGroupCalls).toHaveLength(0);
  });
});

// --- unknown action ---

describe('user_manage unknown action', () => {
  it('logs warning for unknown action and does nothing', async () => {
    await processTaskIpc(
      {
        type: 'user_manage',
        action: 'invalidaction',
        slackUserId: 'U123',
        namespace: 'testns',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(registerGroupCalls).toHaveLength(0);
    expect(addAllowlistEntry).not.toHaveBeenCalled();
    expect(removeAllowlistEntry).not.toHaveBeenCalled();
  });
});
