import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  checkDmAccess,
  GUEST_REDIRECT_MESSAGE,
  isDmJid,
} from './access-control.js';

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'access-control-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeIndex(data: Record<string, unknown>): string {
  const p = path.join(tmpDir, 'identity-index.json');
  fs.writeFileSync(p, JSON.stringify(data));
  return p;
}

describe('isDmJid', () => {
  it('returns true for user DM JIDs', () => {
    expect(isDmJid('slack:gidc:U001')).toBe(true);
    expect(isDmJid('12345@s.whatsapp.net')).toBe(true);
    expect(isDmJid('telegram:12345')).toBe(true);
  });

  it('returns false for channel JIDs', () => {
    expect(isDmJid('slack:gidc:channel:general')).toBe(false);
    expect(isDmJid('slack:team:channel:random')).toBe(false);
  });
});

describe('checkDmAccess', () => {
  it('allows staff users', () => {
    const indexPath = writeIndex({
      'slack:gidc:U001': { tier: 'staff', name: 'Alice', domains: ['dev'] },
    });
    const result = checkDmAccess('slack:gidc:U001', indexPath);
    expect(result.allowed).toBe(true);
    expect(result.tier).toBe('staff');
    expect(result.name).toBe('Alice');
    expect(result.domains).toEqual(['dev']);
  });

  it('allows admin users', () => {
    const indexPath = writeIndex({
      'slack:gidc:U002': { tier: 'admin', name: 'Bob' },
    });
    const result = checkDmAccess('slack:gidc:U002', indexPath);
    expect(result.allowed).toBe(true);
    expect(result.tier).toBe('admin');
    expect(result.name).toBe('Bob');
  });

  it('allows owner users', () => {
    const indexPath = writeIndex({
      'slack:gidc:U003': { tier: 'owner', name: 'Charlie' },
    });
    const result = checkDmAccess('slack:gidc:U003', indexPath);
    expect(result.allowed).toBe(true);
    expect(result.tier).toBe('owner');
    expect(result.name).toBe('Charlie');
  });

  it('blocks unregistered users with redirect message', () => {
    const indexPath = writeIndex({
      'slack:gidc:U001': { tier: 'staff', name: 'Alice' },
    });
    const result = checkDmAccess('slack:gidc:U999', indexPath);
    expect(result.allowed).toBe(false);
    expect(result.redirectMessage).toBe(GUEST_REDIRECT_MESSAGE);
  });

  it('blocks users with blocked tier', () => {
    const indexPath = writeIndex({
      'slack:gidc:U004': { tier: 'blocked', name: 'Blocked User' },
    });
    const result = checkDmAccess('slack:gidc:U004', indexPath);
    expect(result.allowed).toBe(false);
    expect(result.redirectMessage).toBe(GUEST_REDIRECT_MESSAGE);
  });

  it('blocks users with banned tier', () => {
    const indexPath = writeIndex({
      'slack:gidc:U005': { tier: 'banned', name: 'Banned User' },
    });
    const result = checkDmAccess('slack:gidc:U005', indexPath);
    expect(result.allowed).toBe(false);
    expect(result.redirectMessage).toBe(GUEST_REDIRECT_MESSAGE);
  });

  it('returns blocked when identity-index.json is missing', () => {
    const indexPath = path.join(tmpDir, 'nonexistent.json');
    const result = checkDmAccess('slack:gidc:U001', indexPath);
    expect(result.allowed).toBe(false);
    expect(result.redirectMessage).toBe(GUEST_REDIRECT_MESSAGE);
  });
});
