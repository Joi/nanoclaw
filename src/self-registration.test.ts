import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import YAML from 'yaml';

import {
  ClaimData,
  isRegistrationIntent,
  lookupIdentity,
  parseClaimedName,
  writeClaimFile,
} from './self-registration.js';

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-registration-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('isRegistrationIntent', () => {
  it('detects "add me" variants', () => {
    expect(isRegistrationIntent('add me')).toBe(true);
    expect(isRegistrationIntent('Add me please')).toBe(true);
    expect(isRegistrationIntent('@jibot add me')).toBe(true);
  });

  it('detects "I\'m Name" variants', () => {
    expect(isRegistrationIntent("I'm Karma Chophel")).toBe(true);
    expect(isRegistrationIntent("i'm karma")).toBe(true);
    expect(isRegistrationIntent('I am Karma Chophel')).toBe(true);
  });

  it('detects "register me"', () => {
    expect(isRegistrationIntent('register me')).toBe(true);
  });

  it('rejects unrelated messages', () => {
    expect(isRegistrationIntent('hello')).toBe(false);
    expect(isRegistrationIntent('what is the sankosh timeline?')).toBe(false);
    expect(isRegistrationIntent('add the report to the drive')).toBe(false);
  });
});

describe('parseClaimedName', () => {
  it('extracts name from "I\'m Name"', () => {
    expect(parseClaimedName("I'm Karma Chophel")).toBe('Karma Chophel');
  });

  it('extracts name from "I am Name"', () => {
    expect(parseClaimedName('I am Karma Chophel')).toBe('Karma Chophel');
  });

  it('returns null when no name claim is found', () => {
    expect(parseClaimedName('add me')).toBeNull();
  });

  it('normalizes whitespace in claimed name', () => {
    expect(parseClaimedName("I'm  Karma  Chophel ")).toBe('Karma Chophel');
  });
});

describe('lookupIdentity', () => {
  it('returns matched identity for a known JID', () => {
    const indexPath = path.join(tmpDir, 'identity-index.json');
    const index = {
      'slack:gidc:U87654321': {
        name: 'Karma Chophel',
        tier: 'staff',
        domains: ['confidential/gidc'],
      },
    };
    fs.writeFileSync(indexPath, JSON.stringify(index));

    const result = lookupIdentity('slack:gidc:U87654321', indexPath);
    expect(result).toEqual({
      name: 'Karma Chophel',
      tier: 'staff',
      domains: ['confidential/gidc'],
    });
  });

  it('returns null for an unknown JID', () => {
    const indexPath = path.join(tmpDir, 'identity-index.json');
    const index = {
      'slack:gidc:U87654321': {
        name: 'Karma Chophel',
        tier: 'staff',
        domains: ['confidential/gidc'],
      },
    };
    fs.writeFileSync(indexPath, JSON.stringify(index));

    const result = lookupIdentity('slack:gidc:UNKNOWN', indexPath);
    expect(result).toBeNull();
  });

  it('returns null when the index file is missing', () => {
    const result = lookupIdentity(
      'slack:gidc:U87654321',
      path.join(tmpDir, 'nonexistent.json'),
    );
    expect(result).toBeNull();
  });

  it('returns matched identity for an email key', () => {
    const indexPath = path.join(tmpDir, 'identity-index.json');
    const index = {
      'email:karma@example.com': {
        name: 'Karma Chophel',
        tier: 'staff',
        domains: ['confidential/gidc'],
      },
    };
    fs.writeFileSync(indexPath, JSON.stringify(index));

    const result = lookupIdentity('email:karma@example.com', indexPath);
    expect(result).toEqual({
      name: 'Karma Chophel',
      tier: 'staff',
      domains: ['confidential/gidc'],
    });
  });
});

describe('writeClaimFile', () => {
  it('writes YAML with correct fields', () => {
    const claimsDir = path.join(tmpDir, 'claims');
    const claim: ClaimData = {
      platform: 'slack',
      workspace: 'henkaku',
      user_id: 'U12345678',
      display_name: 'Karma Chophel',
      claimed_identity: 'Karma Chophel',
      matched_people_file: 'people/karma-chophel.md',
      platform_email: 'karma@example.com',
      conversation_log: 'User said: add me',
      channel: 'general',
    };

    const filePath = writeClaimFile(claim, claimsDir);
    const content = YAML.parse(fs.readFileSync(filePath, 'utf-8'));

    expect(content.platform).toBe('slack');
    expect(content.workspace).toBe('henkaku');
    expect(content.user_id).toBe('U12345678');
    expect(content.display_name).toBe('Karma Chophel');
    expect(content.claimed_identity).toBe('Karma Chophel');
    expect(content.matched_people_file).toBe('people/karma-chophel.md');
    expect(content.platform_email).toBe('karma@example.com');
    expect(content.status).toBe('pending_review');
    expect(content.channel).toBe('general');
  });

  it('generates filename with correct format', () => {
    const claimsDir = path.join(tmpDir, 'claims');
    const claim: ClaimData = {
      platform: 'slack',
      workspace: 'henkaku',
      user_id: 'U12345678',
      display_name: 'Karma Chophel',
      claimed_identity: 'Karma Chophel',
      matched_people_file: 'people/karma-chophel.md',
      platform_email: 'karma@example.com',
      conversation_log: 'User said: add me',
      channel: 'general',
    };

    const filePath = writeClaimFile(claim, claimsDir);
    const filename = path.basename(filePath);

    expect(filename).toMatch(
      /^\d{4}-\d{2}-\d{2}-slack-henkaku-U12345678\.yaml$/,
    );
  });

  it('handles null fields correctly', () => {
    const claimsDir = path.join(tmpDir, 'claims');
    const claim: ClaimData = {
      platform: 'slack',
      workspace: 'henkaku',
      user_id: 'U12345678',
      display_name: 'Unknown',
      claimed_identity: null,
      matched_people_file: null,
      platform_email: null,
      conversation_log: 'User said: add me',
      channel: 'general',
    };

    const filePath = writeClaimFile(claim, claimsDir);
    const raw = fs.readFileSync(filePath, 'utf-8');

    expect(raw).toContain('claimed_identity: null');
  });
});
