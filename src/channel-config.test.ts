import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ChannelConfig,
  loadChannelConfigs,
  getChannelConfig,
  getFloorLevel,
  getDomainGrants,
  getQmdPorts,
} from './channel-config.js';

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-config-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeConfig(filename: string, content: string): void {
  fs.writeFileSync(path.join(tmpDir, filename), content);
}

describe('loadChannelConfigs', () => {
  it('loads all YAML files from directory', () => {
    writeConfig('slack-gidc-general.yaml', `
platform: slack
workspace: gidc
channel_id: C12345678
channel_name: general
floor: staff
domains:
  - confidential/gidc
listening_mode: attentive
members: {}
`);
    writeConfig('slack-gidc-admin.yaml', `
platform: slack
workspace: gidc
channel_id: C87654321
channel_name: admin
floor: admin
domains:
  - confidential/gidc
  - confidential/sankosh
listening_mode: attentive
members: {}
`);

    const configs = loadChannelConfigs(tmpDir);
    expect(configs.size).toBe(2);
  });

  it('skips non-yaml files', () => {
    writeConfig('_SCHEMA.md', '# Schema docs');
    writeConfig('slack-gidc-general.yaml', `
platform: slack
workspace: gidc
channel_id: C12345678
channel_name: general
floor: staff
domains: []
listening_mode: on-call
members: {}
`);
    const configs = loadChannelConfigs(tmpDir);
    expect(configs.size).toBe(1);
  });

  it('returns empty map for missing directory', () => {
    const configs = loadChannelConfigs('/nonexistent/path');
    expect(configs.size).toBe(0);
  });
});

describe('getChannelConfig', () => {
  it('looks up by platform:workspace:channel: JID prefix', () => {
    writeConfig('slack-gidc-general.yaml', `
platform: slack
workspace: gidc
channel_id: C12345678
channel_name: general
floor: staff
domains:
  - confidential/gidc
listening_mode: attentive
members: {}
`);
    const configs = loadChannelConfigs(tmpDir);
    const result = getChannelConfig('slack:gidc:channel:C12345678', configs);
    expect(result).not.toBeNull();
    expect(result!.floor).toBe('staff');
    expect(result!.domains).toEqual(['confidential/gidc']);
  });

  it('returns null for unknown JID', () => {
    const configs = loadChannelConfigs(tmpDir);
    const result = getChannelConfig('slack:gidc:channel:CUNKNOWN', configs);
    expect(result).toBeNull();
  });
});

describe('getFloorLevel', () => {
  it('returns floor from channel config', () => {
    writeConfig('slack-gidc-general.yaml', `
platform: slack
workspace: gidc
channel_id: C12345678
channel_name: general
floor: staff
domains: []
listening_mode: on-call
members: {}
`);
    const configs = loadChannelConfigs(tmpDir);
    expect(getFloorLevel('slack:gidc:channel:C12345678', configs)).toBe('staff');
  });

  it('returns guest for unknown channels', () => {
    const configs = loadChannelConfigs(tmpDir);
    expect(getFloorLevel('slack:gidc:channel:CUNKNOWN', configs)).toBe('guest');
  });
});

describe('getDomainGrants', () => {
  it('returns domains from channel config', () => {
    writeConfig('slack-gidc-admin.yaml', `
platform: slack
workspace: gidc
channel_id: C87654321
channel_name: admin
floor: admin
domains:
  - confidential/gidc
  - confidential/sankosh
listening_mode: attentive
members: {}
`);
    const configs = loadChannelConfigs(tmpDir);
    const domains = getDomainGrants('slack:gidc:channel:C87654321', configs);
    expect(domains).toEqual(['confidential/gidc', 'confidential/sankosh']);
  });

  it('returns empty array for unknown channel', () => {
    const configs = loadChannelConfigs(tmpDir);
    expect(getDomainGrants('slack:gidc:channel:CUNKNOWN', configs)).toEqual([]);
  });
});

describe('getQmdPorts', () => {
  it('returns only public port for guest floor', () => {
    writeConfig('test.yaml', `
platform: slack
workspace: gidc
channel_id: C00000001
channel_name: lobby
floor: guest
domains: []
listening_mode: on-call
members: {}
`);
    const configs = loadChannelConfigs(tmpDir);
    const ports = getQmdPorts('slack:gidc:channel:C00000001', configs);
    expect(ports).toEqual({ public: 7333 });
  });

  it('returns public + domain ports for staff with domain grants', () => {
    writeConfig('test.yaml', `
platform: slack
workspace: gidc
channel_id: C00000002
channel_name: team
floor: staff
domains:
  - confidential/gidc
listening_mode: attentive
members: {}
`);
    const configs = loadChannelConfigs(tmpDir);
    const ports = getQmdPorts('slack:gidc:channel:C00000002', configs);
    expect(ports).toEqual({ public: 7333, 'domain-gidc': 7335 });
  });

  it('returns public + crm + domain ports for admin floor', () => {
    writeConfig('test.yaml', `
platform: slack
workspace: gidc
channel_id: C00000003
channel_name: admin
floor: admin
domains:
  - confidential/gidc
  - confidential/sankosh
listening_mode: attentive
members: {}
`);
    const configs = loadChannelConfigs(tmpDir);
    const ports = getQmdPorts('slack:gidc:channel:C00000003', configs);
    expect(ports).toEqual({
      public: 7333,
      crm: 7334,
      'domain-gidc': 7335,
      'domain-sankosh': 7336,
    });
  });

  it('returns all ports for owner floor', () => {
    writeConfig('test.yaml', `
platform: slack
workspace: gidc
channel_id: C00000004
channel_name: owner-dm
floor: owner
domains:
  - confidential/gidc
  - confidential/sankosh
  - confidential/bhutan
  - confidential/gmc
listening_mode: attentive
members: {}
`);
    const configs = loadChannelConfigs(tmpDir);
    const ports = getQmdPorts('slack:gidc:channel:C00000004', configs);
    expect(ports).toEqual({
      public: 7333,
      crm: 7334,
      'domain-gidc': 7335,
      'domain-sankosh': 7336,
      'domain-bhutan': 7337,
      'domain-gmc': 7338,
    });
  });
});
