import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadEmailAliasMap, resolveEmailAlias } from './email-alias-map.js';

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-alias-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeAliasMap(data: Record<string, unknown>): string {
  const p = path.join(tmpDir, 'email-alias-map.json');
  fs.writeFileSync(p, JSON.stringify(data));
  return p;
}

describe('loadEmailAliasMap', () => {
  it('loads a valid alias map', () => {
    const p = writeAliasMap({
      'alt-email@example.com': { identity: 'sig:+819048411965', name: 'Joi' },
      'work@company.com': { identity: 'sig:+819048411965', name: 'Joi' },
    });
    const map = loadEmailAliasMap(p);
    expect(map.size).toBe(2);
    expect(map.get('alt-email@example.com')?.name).toBe('Joi');
  });

  it('returns empty map for missing file', () => {
    const map = loadEmailAliasMap('/nonexistent/path.json');
    expect(map.size).toBe(0);
  });

  it('returns empty map for invalid JSON', () => {
    const p = path.join(tmpDir, 'bad.json');
    fs.writeFileSync(p, 'not json');
    const map = loadEmailAliasMap(p);
    expect(map.size).toBe(0);
  });

  it('lowercases email keys', () => {
    const p = writeAliasMap({
      'Alice@Example.COM': { identity: 'sig:+1234', name: 'Alice' },
    });
    const map = loadEmailAliasMap(p);
    expect(map.has('alice@example.com')).toBe(true);
  });
});

describe('resolveEmailAlias', () => {
  it('resolves known alias', () => {
    const p = writeAliasMap({
      'alt@example.com': { identity: 'sig:+819048411965', name: 'Joi', tier: 'owner' },
    });
    const map = loadEmailAliasMap(p);
    const result = resolveEmailAlias('alt@example.com', map);
    expect(result).toBeDefined();
    expect(result!.identity).toBe('sig:+819048411965');
    expect(result!.tier).toBe('owner');
  });

  it('returns null for unknown email', () => {
    const map = loadEmailAliasMap('/nonexistent.json');
    expect(resolveEmailAlias('unknown@example.com', map)).toBeNull();
  });

  it('is case-insensitive', () => {
    const p = writeAliasMap({
      'bob@example.com': { identity: 'sig:+5555', name: 'Bob', tier: 'admin' },
    });
    const map = loadEmailAliasMap(p);
    expect(resolveEmailAlias('BOB@Example.com', map)).toBeDefined();
  });
});
