import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getGroupWorkstreams,
  getUserWorkstreams,
  AllowlistUser,
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  resolveUser,
  SenderAllowlistConfig,
  shouldDropMessage,
  WorkstreamInfo,
} from './sender-allowlist.js';

let tmpDir: string;

function cfgPath(name = 'sender-allowlist.json'): string {
  return path.join(tmpDir, name);
}

function writeConfig(config: unknown, name?: string): string {
  const p = cfgPath(name);
  fs.writeFileSync(p, JSON.stringify(config));
  return p;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'allowlist-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('loadSenderAllowlist', () => {
  it('returns allow-all defaults when file is missing', () => {
    const cfg = loadSenderAllowlist(cfgPath());
    expect(cfg.default.allow).toBe('*');
    expect(cfg.default.mode).toBe('trigger');
    expect(cfg.logDenied).toBe(true);
  });

  it('loads allow=* config', () => {
    const p = writeConfig({
      default: { allow: '*', mode: 'trigger' },
      chats: {},
      logDenied: false,
    });
    const cfg = loadSenderAllowlist(p);
    expect(cfg.default.allow).toBe('*');
    expect(cfg.logDenied).toBe(false);
  });

  it('loads allow=[] (deny all)', () => {
    const p = writeConfig({
      default: { allow: [], mode: 'trigger' },
      chats: {},
    });
    const cfg = loadSenderAllowlist(p);
    expect(cfg.default.allow).toEqual([]);
  });

  it('loads allow=[list]', () => {
    const p = writeConfig({
      default: { allow: ['alice', 'bob'], mode: 'drop' },
      chats: {},
    });
    const cfg = loadSenderAllowlist(p);
    expect(cfg.default.allow).toEqual(['alice', 'bob']);
    expect(cfg.default.mode).toBe('drop');
  });

  it('per-chat override beats default', () => {
    const p = writeConfig({
      default: { allow: '*', mode: 'trigger' },
      chats: { 'group-a': { allow: ['alice'], mode: 'drop' } },
    });
    const cfg = loadSenderAllowlist(p);
    expect(cfg.chats['group-a'].allow).toEqual(['alice']);
    expect(cfg.chats['group-a'].mode).toBe('drop');
  });

  it('returns allow-all on invalid JSON', () => {
    const p = cfgPath();
    fs.writeFileSync(p, '{ not valid json }}}');
    const cfg = loadSenderAllowlist(p);
    expect(cfg.default.allow).toBe('*');
  });

  it('returns allow-all on invalid schema', () => {
    const p = writeConfig({ default: { oops: true } });
    const cfg = loadSenderAllowlist(p);
    expect(cfg.default.allow).toBe('*');
  });

  it('rejects non-string allow array items', () => {
    const p = writeConfig({
      default: { allow: [123, null, true], mode: 'trigger' },
      chats: {},
    });
    const cfg = loadSenderAllowlist(p);
    expect(cfg.default.allow).toBe('*'); // falls back to default
  });

  it('skips invalid per-chat entries', () => {
    const p = writeConfig({
      default: { allow: '*', mode: 'trigger' },
      chats: {
        good: { allow: ['alice'], mode: 'trigger' },
        bad: { allow: 123 },
      },
    });
    const cfg = loadSenderAllowlist(p);
    expect(cfg.chats['good']).toBeDefined();
    expect(cfg.chats['bad']).toBeUndefined();
  });
});

describe('isSenderAllowed', () => {
  it('allow=* allows any sender', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: '*', mode: 'trigger' },
      chats: {},
      logDenied: true,
    };
    expect(isSenderAllowed('g1', 'anyone', cfg)).toBe(true);
  });

  it('allow=[] denies any sender', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: [], mode: 'trigger' },
      chats: {},
      logDenied: true,
    };
    expect(isSenderAllowed('g1', 'anyone', cfg)).toBe(false);
  });

  it('allow=[list] allows exact match only', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: ['alice', 'bob'], mode: 'trigger' },
      chats: {},
      logDenied: true,
    };
    expect(isSenderAllowed('g1', 'alice', cfg)).toBe(true);
    expect(isSenderAllowed('g1', 'eve', cfg)).toBe(false);
  });

  it('uses per-chat entry over default', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: '*', mode: 'trigger' },
      chats: { g1: { allow: ['alice'], mode: 'trigger' } },
      logDenied: true,
    };
    expect(isSenderAllowed('g1', 'bob', cfg)).toBe(false);
    expect(isSenderAllowed('g2', 'bob', cfg)).toBe(true);
  });
});

describe('shouldDropMessage', () => {
  it('returns false for trigger mode', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: '*', mode: 'trigger' },
      chats: {},
      logDenied: true,
    };
    expect(shouldDropMessage('g1', cfg)).toBe(false);
  });

  it('returns true for drop mode', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: '*', mode: 'drop' },
      chats: {},
      logDenied: true,
    };
    expect(shouldDropMessage('g1', cfg)).toBe(true);
  });

  it('per-chat mode override', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: '*', mode: 'trigger' },
      chats: { g1: { allow: '*', mode: 'drop' } },
      logDenied: true,
    };
    expect(shouldDropMessage('g1', cfg)).toBe(true);
    expect(shouldDropMessage('g2', cfg)).toBe(false);
  });
});

describe('isTriggerAllowed', () => {
  it('allows trigger for allowed sender', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: ['alice'], mode: 'trigger' },
      chats: {},
      logDenied: false,
    };
    expect(isTriggerAllowed('g1', 'alice', cfg)).toBe(true);
  });

  it('denies trigger for disallowed sender', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: ['alice'], mode: 'trigger' },
      chats: {},
      logDenied: false,
    };
    expect(isTriggerAllowed('g1', 'eve', cfg)).toBe(false);
  });

  it('logs when logDenied is true', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: ['alice'], mode: 'trigger' },
      chats: {},
      logDenied: true,
    };
    isTriggerAllowed('g1', 'eve', cfg);
    // Logger.debug is called — we just verify no crash; logger is a real pino instance
  });
});

describe('loadSenderAllowlist users and workstreams', () => {
  it('loads users and workstreams sections from config', () => {
    const p = writeConfig({
      default: { allow: '*', mode: 'trigger' },
      chats: {},
      users: {
        alice: {
          tier: 'owner',
          emails: ['alice@example.com'],
          jids: ['alice@s.whatsapp.net'],
          workstreams: ['ws1'],
        },
      },
      workstreams: {
        ws1: {
          qmd_collection: 'docs',
          drive_folder_id: 'folder123',
          slack_channels: ['#general'],
          mount_path: '/ws1',
        },
      },
    });
    const cfg = loadSenderAllowlist(p);
    const alice = cfg.users?.['alice'] as AllowlistUser;
    expect(alice.tier).toBe('owner');
    expect(alice.emails).toEqual(['alice@example.com']);
    expect(alice.jids).toEqual(['alice@s.whatsapp.net']);
    expect(alice.workstreams).toEqual(['ws1']);
    const ws1 = cfg.workstreams?.['ws1'] as WorkstreamInfo;
    expect(ws1.qmd_collection).toBe('docs');
    expect(ws1.drive_folder_id).toBe('folder123');
    expect(ws1.slack_channels).toEqual(['#general']);
    expect(ws1.mount_path).toBe('/ws1');
  });

  it('drive_folder_id can be null', () => {
    const p = writeConfig({
      default: { allow: '*', mode: 'trigger' },
      chats: {},
      workstreams: {
        ws2: {
          qmd_collection: 'notes',
          drive_folder_id: null,
          slack_channels: [],
          mount_path: '/ws2',
        },
      },
    });
    const cfg = loadSenderAllowlist(p);
    expect(cfg.workstreams?.['ws2'].drive_folder_id).toBeNull();
  });

  it('cfg.users and cfg.workstreams are undefined when not in config (backward compat)', () => {
    const p = writeConfig({
      default: { allow: '*', mode: 'trigger' },
      chats: {},
    });
    const cfg = loadSenderAllowlist(p);
    expect(cfg.users).toBeUndefined();
    expect(cfg.workstreams).toBeUndefined();
  });
});

describe('resolveUser', () => {
  function cfgWithUsers(): SenderAllowlistConfig {
    return {
      default: { allow: '*' as const, mode: 'trigger' as const },
      chats: {},
      logDenied: false,
      users: {
        joi: {
          tier: 'owner' as const,
          emails: ['joi@example.com'],
          jids: ['sig:+819048411965', 'slack:sankosh:U001', 'wa:joi@s.whatsapp.net'],
          workstreams: ['ws1', 'ws2', 'ws3', 'ws4'],
        },
        karma: {
          tier: 'staff' as const,
          emails: ['karma@example.com'],
          jids: ['slack:sankosh:U002'],
          workstreams: ['ws1'],
        },
      },
    };
  }

  it('resolves user by Signal JID', () => {
    const result = resolveUser('sig:+819048411965', cfgWithUsers());
    expect(result).not.toBeNull();
    expect(result?.name).toBe('joi');
    expect(result?.user.tier).toBe('owner');
  });

  it('resolves user by Slack JID', () => {
    const result = resolveUser('slack:sankosh:U002', cfgWithUsers());
    expect(result).not.toBeNull();
    expect(result?.name).toBe('karma');
    expect(result?.user.tier).toBe('staff');
  });

  it('resolves same user from different JIDs', () => {
    const cfg = cfgWithUsers();
    const fromSignal = resolveUser('sig:+819048411965', cfg);
    const fromSlack = resolveUser('slack:sankosh:U001', cfg);
    expect(fromSignal?.name).toBe('joi');
    expect(fromSlack?.name).toBe('joi');
  });

  it('returns null for unknown JID', () => {
    const result = resolveUser('unknown:xyz', cfgWithUsers());
    expect(result).toBeNull();
  });

  it('returns null when no users section exists', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: '*', mode: 'trigger' },
      chats: {},
      logDenied: false,
    };
    const result = resolveUser('sig:+819048411965', cfg);
    expect(result).toBeNull();
  });
  it('returns null when users is null (malformed config)', () => {
    const cfg = {
      default: { allow: '*' as const, mode: 'trigger' as const },
      chats: {},
      logDenied: false,
      users: null as unknown as Record<string, AllowlistUser>,
    };
    expect(resolveUser('sig:+819048411965', cfg as SenderAllowlistConfig)).toBeNull();
  });

  it('skips entries with non-array jids and returns valid match (malformed config)', () => {
    const cfg = {
      default: { allow: '*' as const, mode: 'trigger' as const },
      chats: {},
      logDenied: false,
      users: {
        bad: {
          tier: 'staff' as const,
          emails: [],
          jids: 'not-an-array' as unknown as string[],
          workstreams: [],
        },
        joi: {
          tier: 'owner' as const,
          emails: ['joi@example.com'],
          jids: ['sig:+819048411965'],
          workstreams: ['ws1'],
        },
      },
    };
    expect(() => resolveUser('sig:+819048411965', cfg as SenderAllowlistConfig)).not.toThrow();
    const result = resolveUser('sig:+819048411965', cfg as SenderAllowlistConfig);
    expect(result?.name).toBe('joi');
  });
});

describe(getUserWorkstreams, () => {
  function cfgWithWorkstreams(): SenderAllowlistConfig {
    return {
      default: { allow: '*' as const, mode: 'trigger' as const },
      chats: {},
      logDenied: false,
      users: {
        karma: {
          tier: 'staff' as const,
          emails: ['karma@example.com'],
          jids: ['slack:sankosh:U002'],
          workstreams: ['sankosh'],
        },
      },
      workstreams: {
        sankosh: {
          qmd_collection: 'sankosh-docs',
          drive_folder_id: 'folder-sankosh-123',
          slack_channels: ['#sankosh'],
          mount_path: '/workstreams/sankosh',
        },
        gidc: {
          qmd_collection: 'gidc-docs',
          drive_folder_id: null,
          slack_channels: ['#gidc'],
          mount_path: '/workstreams/gidc',
        },
      },
    };
  }

  it('returns workstream info for user with one workstream', () => {
    const cfg = cfgWithWorkstreams();
    const user = cfg.users!['karma'];
    const result = getUserWorkstreams(user, cfg);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('sankosh');
    expect(result[0].info.qmd_collection).toBe('sankosh-docs');
    expect(result[0].info.drive_folder_id).toBe('folder-sankosh-123');
  });

  it('returns empty array when workstreams section missing from config', () => {
    const cfg = cfgWithWorkstreams();
    const user = cfg.users!['karma'];
    const cfgWithoutWorkstreams: SenderAllowlistConfig = { ...cfg, workstreams: undefined };
    const result = getUserWorkstreams(user, cfgWithoutWorkstreams);
    expect(result).toEqual([]);
  });

  it('skips workstreams not defined in workstreams section', () => {
    const cfg = cfgWithWorkstreams();
    const userWithNonexistent: AllowlistUser = {
      tier: 'staff' as const,
      emails: ['karma@example.com'],
      jids: ['slack:sankosh:U002'],
      workstreams: ['sankosh', 'nonexistent'],
    };
    const result = getUserWorkstreams(userWithNonexistent, cfg);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('sankosh');
  });

  it("returns empty array when user.workstreams is malformed (null/undefined/non-array)", () => {
    const cfg = cfgWithWorkstreams();
    const malformedNull = {
      tier: "staff" as const,
      emails: ["karma@example.com"],
      jids: ["slack:sankosh:U002"],
      workstreams: null as unknown as string[],
    };
    expect(getUserWorkstreams(malformedNull, cfg)).toEqual([]);

    const malformedUndefined = {
      tier: "staff" as const,
      emails: ["karma@example.com"],
      jids: ["slack:sankosh:U002"],
      workstreams: undefined as unknown as string[],
    };
    expect(getUserWorkstreams(malformedUndefined, cfg)).toEqual([]);

    const malformedString = {
      tier: "staff" as const,
      emails: ["karma@example.com"],
      jids: ["slack:sankosh:U002"],
      workstreams: "sankosh" as unknown as string[],
    };
    expect(getUserWorkstreams(malformedString, cfg)).toEqual([]);
  });
});

describe("getGroupWorkstreams", () => {
  function cfgForGroup(): SenderAllowlistConfig {
    return {
      default: { allow: "*" as const, mode: "trigger" as const },
      chats: {},
      logDenied: false,
      users: {
        joi: {
          tier: "owner" as const,
          emails: ["joi@example.com"],
          jids: ["sig:+819048411965"],
          workstreams: ["sankosh", "gidc", "bhutan", "gmc"],
        },
        kesang: {
          tier: "admin" as const,
          emails: ["kesang@example.com"],
          jids: ["slack:sankosh:U003"],
          workstreams: ["sankosh", "gidc", "bhutan", "gmc"],
        },
        karma: {
          tier: "staff" as const,
          emails: ["karma@example.com"],
          jids: ["slack:sankosh:U002"],
          workstreams: ["sankosh"],
        },
      },
      workstreams: {
        sankosh: {
          qmd_collection: "sankosh-docs",
          drive_folder_id: "folder-sankosh-123",
          slack_channels: ["#sankosh"],
          mount_path: "/workstreams/sankosh",
        },
        gidc: {
          qmd_collection: "gidc-docs",
          drive_folder_id: null,
          slack_channels: ["#gidc"],
          mount_path: "/workstreams/gidc",
        },
        bhutan: {
          qmd_collection: "bhutan-docs",
          drive_folder_id: null,
          slack_channels: ["#bhutan"],
          mount_path: "/workstreams/bhutan",
        },
        gmc: {
          qmd_collection: "gmc-docs",
          drive_folder_id: null,
          slack_channels: ["#gmc"],
          mount_path: "/workstreams/gmc",
        },
      },
    };
  }

  it("returns all 4 workstreams when two members have identical workstreams (joi + kesang)", () => {
    const cfg = cfgForGroup();
    const result = getGroupWorkstreams(
      ["sig:+819048411965", "slack:sankosh:U003"],
      cfg,
    );
    expect(result).toHaveLength(4);
    const names = result.map((r) => r.name);
    expect(names).toContain("sankosh");
    expect(names).toContain("gidc");
    expect(names).toContain("bhutan");
    expect(names).toContain("gmc");
  });

  it("returns only sankosh when one member has fewer workstreams (joi + karma)", () => {
    const cfg = cfgForGroup();
    const result = getGroupWorkstreams(
      ["sig:+819048411965", "slack:sankosh:U002"],
      cfg,
    );
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("sankosh");
  });

  it("returns empty when a member JID is unknown (U999)", () => {
    const cfg = cfgForGroup();
    const result = getGroupWorkstreams(
      ["sig:+819048411965", "slack:sankosh:U999"],
      cfg,
    );
    expect(result).toEqual([]);
  });

  it("returns empty for empty member list", () => {
    const cfg = cfgForGroup();
    const result = getGroupWorkstreams([], cfg);
    expect(result).toEqual([]);
  });

  it("returns full workstreams for single member (karma alone → sankosh)", () => {
    const cfg = cfgForGroup();
    const result = getGroupWorkstreams(["slack:sankosh:U002"], cfg);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("sankosh");
    expect(result[0].info.drive_folder_id).toBe("folder-sankosh-123");
  });
});
