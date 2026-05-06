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

  // Signal: `sig:group:<base64>=` for groups, `sig:<phone-or-uuid>` for DMs
  // (per src/channels/signal.ts:672 -- the canonical NanoClaw discriminator).
  // Regression: prior to this fix, the catch-all `!jid.includes(':channel:')`
  // misclassified Signal groups as DMs, causing the GUEST_REDIRECT_MESSAGE to
  // fire in real groups (observed in louis-joi 2026-05-05).
  it('returns false for Signal group JIDs', () => {
    expect(isDmJid('sig:group:Zq4PgvNe1Zi+6vzbPtFHGaFj7/uYSH/K+gOmK9L4trA=')).toBe(false);
    expect(isDmJid('sig:group:kfXZv5eENlfVvxRqiRj+sTSgU0FcY5Hqkvoz99ZhnZA=')).toBe(false);
    expect(isDmJid('sig:group:b5fLBq2GtfJarOtPRYwvw5eyTmbOKwzSTV1FEGunrcs=')).toBe(false);
  });

  it('returns true for Signal DM JIDs (phone and UUID forms)', () => {
    expect(isDmJid('sig:+819048411965')).toBe(true);
    expect(isDmJid('sig:+15109124126')).toBe(true);
    expect(isDmJid('sig:f139df88-5862-4ff5-b207-fd6a6c121dd7')).toBe(true);
  });

  it('returns true for Discord DM JIDs and false for Discord channel JIDs', () => {
    // Lock in the existing Discord branch behavior to prevent regression.
    expect(isDmJid('dc:dm:1234567890')).toBe(true);
    expect(isDmJid('dc:913694033031864350:936857224012259339')).toBe(false);
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
