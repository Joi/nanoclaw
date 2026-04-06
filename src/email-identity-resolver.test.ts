import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EmailIdentityResolver } from './email-identity-resolver.js';

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-identity-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeIdentityIndex(data: Record<string, unknown>): string {
  const p = path.join(tmpDir, 'identity-index.json');
  fs.writeFileSync(p, JSON.stringify(data));
  return p;
}

function writeAliasMap(data: Record<string, unknown>): string {
  const p = path.join(tmpDir, 'email-alias-map.json');
  fs.writeFileSync(p, JSON.stringify(data));
  return p;
}

describe('EmailIdentityResolver', () => {
  it('resolves owner by primary email in identity-index', () => {
    const indexPath = writeIdentityIndex({
      'email:joi@ito.com': { tier: 'owner', name: 'Joi' },
    });
    const aliasPath = writeAliasMap({});
    const resolver = new EmailIdentityResolver(indexPath, aliasPath);

    const result = resolver.resolve('joi@ito.com');
    expect(result.resolved).toBe(true);
    expect(result.tier).toBe('owner');
    expect(result.name).toBe('Joi');
  });

  it('falls back to alias map when not in identity-index', () => {
    const indexPath = writeIdentityIndex({});
    const aliasPath = writeAliasMap({
      'joi.alt@gmail.com': { identity: 'email:joi@ito.com', name: 'Joi', tier: 'owner' },
    });
    const resolver = new EmailIdentityResolver(indexPath, aliasPath);

    const result = resolver.resolve('joi.alt@gmail.com');
    expect(result.resolved).toBe(true);
    expect(result.tier).toBe('owner');
    expect(result.name).toBe('Joi');
  });

  it('returns unresolved for unknown sender', () => {
    const indexPath = writeIdentityIndex({});
    const aliasPath = writeAliasMap({});
    const resolver = new EmailIdentityResolver(indexPath, aliasPath);

    const result = resolver.resolve('stranger@external.com');
    expect(result.resolved).toBe(false);
    expect(result.tier).toBeUndefined();
  });

  it('is case-insensitive', () => {
    const indexPath = writeIdentityIndex({
      'email:alice@example.com': { tier: 'admin', name: 'Alice' },
    });
    const aliasPath = writeAliasMap({});
    const resolver = new EmailIdentityResolver(indexPath, aliasPath);

    const result = resolver.resolve('Alice@Example.COM');
    expect(result.resolved).toBe(true);
    expect(result.tier).toBe('admin');
  });

  it('resolves staff tier', () => {
    const indexPath = writeIdentityIndex({
      'email:bob@ito.com': { tier: 'staff', name: 'Bob' },
    });
    const aliasPath = writeAliasMap({});
    const resolver = new EmailIdentityResolver(indexPath, aliasPath);

    const result = resolver.resolve('bob@ito.com');
    expect(result.resolved).toBe(true);
    expect(result.tier).toBe('staff');
  });

  it('prefers identity-index over alias map', () => {
    const indexPath = writeIdentityIndex({
      'email:carol@ito.com': { tier: 'admin', name: 'Carol (primary)' },
    });
    const aliasPath = writeAliasMap({
      'carol@ito.com': { identity: 'email:carol@ito.com', name: 'Carol (alias)', tier: 'staff' },
    });
    const resolver = new EmailIdentityResolver(indexPath, aliasPath);

    const result = resolver.resolve('carol@ito.com');
    expect(result.resolved).toBe(true);
    expect(result.name).toBe('Carol (primary)');
    expect(result.tier).toBe('admin');
  });

  it('can reload alias map', () => {
    const indexPath = writeIdentityIndex({});
    const aliasPath = writeAliasMap({});
    const resolver = new EmailIdentityResolver(indexPath, aliasPath);

    expect(resolver.resolve('new@example.com').resolved).toBe(false);

    // Update alias map on disk
    fs.writeFileSync(aliasPath, JSON.stringify({
      'new@example.com': { identity: 'sig:+1234', name: 'New', tier: 'staff' },
    }));
    resolver.reload();

    expect(resolver.resolve('new@example.com').resolved).toBe(true);
  });
});
