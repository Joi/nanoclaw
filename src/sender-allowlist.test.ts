import { describe, expect, it } from 'vitest';
import { loadUserIdentity, resolveUser, computePermittedScope } from './user-identity.js';

describe('user-identity (migrated from sender-allowlist)', () => {
  it('loads config without crashing when file is missing', () => {
    const cfg = loadUserIdentity('/nonexistent/path.json');
    expect(cfg.logDenied).toBe(true);
  });

  it('resolveUser returns null for unknown JID', () => {
    const cfg = loadUserIdentity('/nonexistent/path.json');
    const result = resolveUser('unknown-jid', cfg);
    expect(result).toBeNull();
  });
});

// Original sender-allowlist tests are deprecated.
// Per-chat mode tests removed: modes moved to YAML channel configs.
// User identity and workstream tests are in user-identity.test.ts.
