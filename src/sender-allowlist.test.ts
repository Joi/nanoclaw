import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  addAllowlistEntry,
  ChatAllowlistEntry,
  isSenderAllowed,
  isTriggerAllowed,
  listAllowlistEntries,
  loadSenderAllowlist,
  removeAllowlistEntry,
  saveSenderAllowlist,
  SenderAllowlistConfig,
  shouldDropMessage,
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

describe('saveSenderAllowlist', () => {
  it('writes config back to file', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: ['alice'], mode: 'trigger' },
      chats: { g1: { allow: '*', mode: 'drop' } },
      logDenied: false,
    };
    const p = cfgPath('saved.json');
    saveSenderAllowlist(cfg, p);
    const loaded = loadSenderAllowlist(p);
    expect(loaded.default.allow).toEqual(['alice']);
    expect(loaded.chats['g1'].allow).toBe('*');
    expect(loaded.logDenied).toBe(false);
  });

  it('overwrites existing file', () => {
    const p = writeConfig(
      { default: { allow: '*', mode: 'trigger' }, chats: {}, logDenied: true },
      'overwrite.json',
    );
    const newCfg: SenderAllowlistConfig = {
      default: { allow: ['bob'], mode: 'drop' },
      chats: {},
      logDenied: false,
    };
    saveSenderAllowlist(newCfg, p);
    const loaded = loadSenderAllowlist(p);
    expect(loaded.default.allow).toEqual(['bob']);
    expect(loaded.default.mode).toBe('drop');
    expect(loaded.logDenied).toBe(false);
  });

  it('creates file if it does not exist', () => {
    const p = cfgPath('new-file.json');
    expect(fs.existsSync(p)).toBe(false);
    const cfg: SenderAllowlistConfig = {
      default: { allow: '*', mode: 'trigger' },
      chats: {},
      logDenied: true,
    };
    saveSenderAllowlist(cfg, p);
    expect(fs.existsSync(p)).toBe(true);
    const loaded = loadSenderAllowlist(p);
    expect(loaded.default.allow).toBe("*");
  });
});

describe('addAllowlistEntry', () => {
  it('adds new entry and persists to disk', () => {
    const initial = {
      default: { allow: '*', mode: 'trigger' },
      chats: {},
      logDenied: true,
    };
    const p = writeConfig(initial, 'add-test.json');
    const entry: ChatAllowlistEntry = { allow: ['alice'], mode: 'trigger' };
    addAllowlistEntry('group-a', entry, p);
    const loaded = loadSenderAllowlist(p);
    expect(loaded.chats['group-a']).toEqual(entry);
  });

  it('overwrites existing entry for same JID', () => {
    const initial = {
      default: { allow: '*', mode: 'trigger' },
      chats: { 'group-a': { allow: ['alice'], mode: 'trigger' } },
      logDenied: true,
    };
    const p = writeConfig(initial, 'overwrite-test.json');
    const newEntry: ChatAllowlistEntry = { allow: ['bob'], mode: 'drop' };
    addAllowlistEntry('group-a', newEntry, p);
    const loaded = loadSenderAllowlist(p);
    expect(loaded.chats['group-a']).toEqual(newEntry);
  });

  it('preserves other entries', () => {
    const initial = {
      default: { allow: '*', mode: 'trigger' },
      chats: { 'group-b': { allow: ['carol'], mode: 'trigger' } },
      logDenied: true,
    };
    const p = writeConfig(initial, 'preserve-test.json');
    const newEntry: ChatAllowlistEntry = { allow: ['dave'], mode: 'trigger' };
    addAllowlistEntry('group-a', newEntry, p);
    const loaded = loadSenderAllowlist(p);
    expect(loaded.chats['group-b']).toEqual({ allow: ['carol'], mode: 'trigger' });
    expect(loaded.chats['group-a']).toEqual(newEntry);
  });

  it('creates config file when path does not exist (bootstrap)', () => {
    const p = cfgPath('bootstrap-test.json');
    expect(fs.existsSync(p)).toBe(false);
    const entry: ChatAllowlistEntry = { allow: ['alice'], mode: 'trigger' };
    addAllowlistEntry('group-a', entry, p);
    expect(fs.existsSync(p)).toBe(true);
    const loaded = loadSenderAllowlist(p);
    expect(loaded.chats['group-a']).toEqual(entry);
  });
});

describe('removeAllowlistEntry', () => {
  it('removes existing entry and persists, returning true', () => {
    const initial = {
      default: { allow: '*', mode: 'trigger' },
      chats: { 'group-a': { allow: ['alice'], mode: 'trigger' } },
      logDenied: true,
    };
    const p = writeConfig(initial, 'remove-test.json');
    const result = removeAllowlistEntry('group-a', p);
    expect(result).toBe(true);
    const loaded = loadSenderAllowlist(p);
    expect(loaded.chats['group-a']).toBeUndefined();
  });

  it('returns false if entry does not exist', () => {
    const initial = {
      default: { allow: '*', mode: 'trigger' },
      chats: {},
      logDenied: true,
    };
    const p = writeConfig(initial, 'remove-missing-test.json');
    const result = removeAllowlistEntry('nonexistent', p);
    expect(result).toBe(false);
  });

  it('preserves other entries', () => {
    const initial = {
      default: { allow: '*', mode: 'trigger' },
      chats: {
        'group-a': { allow: ['alice'], mode: 'trigger' },
        'group-b': { allow: ['bob'], mode: 'trigger' },
      },
      logDenied: true,
    };
    const p = writeConfig(initial, 'remove-preserve-test.json');
    removeAllowlistEntry('group-a', p);
    const loaded = loadSenderAllowlist(p);
    expect(loaded.chats['group-a']).toBeUndefined();
    expect(loaded.chats['group-b']).toEqual({ allow: ['bob'], mode: 'trigger' });
  });
});

describe('listAllowlistEntries', () => {
  it('returns all chat entries', () => {
    const initial = {
      default: { allow: '*', mode: 'trigger' },
      chats: {
        'group-a': { allow: ['alice'], mode: 'trigger' },
        'group-b': { allow: '*', mode: 'drop' },
      },
      logDenied: true,
    };
    const p = writeConfig(initial, 'list-test.json');
    const entries = listAllowlistEntries(p);
    expect(entries['group-a']).toEqual({ allow: ['alice'], mode: 'trigger' });
    expect(entries['group-b']).toEqual({ allow: '*', mode: 'drop' });
  });

  it('returns empty object when no entries', () => {
    const initial = {
      default: { allow: '*', mode: 'trigger' },
      chats: {},
      logDenied: true,
    };
    const p = writeConfig(initial, 'list-empty-test.json');
    const entries = listAllowlistEntries(p);
    expect(entries).toEqual({});
  });
});
