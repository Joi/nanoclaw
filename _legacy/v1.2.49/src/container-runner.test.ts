import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  CREDENTIAL_PROXY_PORT: 3001,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  ONECLI_URL: 'http://localhost:10254',
  TIMEZONE: 'America/Los_Angeles',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
    },
  };
});

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Mock container-runtime
vi.mock('./container-runtime.js', () => ({
  CONTAINER_RUNTIME_BIN: 'docker',
  hostGatewayArgs: () => [],
  readonlyMountArgs: (h: string, c: string) => ['-v', `${h}:${c}:ro`],
  stopContainer: vi.fn(),
  // CVE-2026-31431 mitigation: real impl reads from disk and throws if
  // missing. In tests we return a deterministic absolute path so the wired
  // --security-opt seccomp=... arg is testable without touching the
  // filesystem.
  assertSeccompProfileExists: vi.fn(
    () => '/test/abs/path/seccomp/agent-default.json',
  ),
  seccompProfilePath: vi.fn(
    () => '/test/abs/path/seccomp/agent-default.json',
  ),
}));

// Mock OneCLI SDK
vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: class {
    applyContainerConfig = vi.fn().mockResolvedValue(true);
    createAgent = vi.fn().mockResolvedValue({ id: 'test' });
    ensureAgent = vi
      .fn()
      .mockResolvedValue({ name: 'test', identifier: 'test', created: true });
  },
}));

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
        return new EventEmitter();
      },
    ),
  };
});

import { runContainerAgent, ContainerOutput } from './container-runner.js';
import type { RegisteredGroup } from './types.js';
import fs from "fs";

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@jibot',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: ContainerOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('container-runner timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output with a result
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event (as if container was stopped by the timeout)
    fakeProc.emit('close', 137);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Here is my response' }),
    );
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event
    fakeProc.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    fakeProc.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });
});

describe("container-runner settings.json QMD MCP configuration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(fs.writeFileSync).mockClear();
    vi.mocked(fs.existsSync).mockReturnValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("includes QMD mcpServers when group has intakeAccess", () => {
    const groupWithIntake: RegisteredGroup = {
      ...testGroup,
      intakeAccess: true,
    };

    // buildVolumeMounts runs synchronously before the first await
    runContainerAgent(groupWithIntake, testInput, () => {});

    const claudeJsonCall = vi.mocked(fs.writeFileSync).mock.calls.find(
      ([filePath]) =>
        typeof filePath === "string" && filePath.includes("claude.json"),
    );
    expect(claudeJsonCall).toBeDefined();
    const content = JSON.parse(claudeJsonCall![1] as string);
    expect(content.mcpServers).toBeDefined();
    expect(content.mcpServers.qmd).toEqual({
      type: "http",
      url: "http://host.docker.internal:7333/mcp",
    });
  });

  it("includes QMD mcpServers when group has fileServingAccess", () => {
    const groupWithFileServing: RegisteredGroup = {
      ...testGroup,
      fileServingAccess: true,
    };

    runContainerAgent(groupWithFileServing, testInput, () => {});

    const claudeJsonCall = vi.mocked(fs.writeFileSync).mock.calls.find(
      ([filePath]) =>
        typeof filePath === "string" && filePath.includes("claude.json"),
    );
    expect(claudeJsonCall).toBeDefined();
    const content = JSON.parse(claudeJsonCall![1] as string);
    expect(content.mcpServers).toBeDefined();
    expect(content.mcpServers.qmd).toEqual({
      type: "http",
      url: "http://host.docker.internal:7333/mcp",
    });
  });

  it("does not include mcpServers when group has no intake or file serving access", () => {
    runContainerAgent(testGroup, testInput, () => {});

    const settingsCall = vi.mocked(fs.writeFileSync).mock.calls.find(
      ([filePath]) =>
        typeof filePath === "string" && filePath.includes("settings.json"),
    );
    expect(settingsCall).toBeDefined();
    const content = JSON.parse(settingsCall![1] as string);
    expect(content.mcpServers).toBeUndefined();
  });

  it("mounts multiple QMD servers when qmdPorts provided", () => {
    const inputWithPorts = {
      ...testInput,
      qmdPorts: { public: 7333, crm: 7334, 'domain-gidc': 7335 },
    };

    runContainerAgent(testGroup, inputWithPorts, () => {});

    const claudeJsonCall = vi.mocked(fs.writeFileSync).mock.calls.find(
      ([filePath]) =>
        typeof filePath === "string" && filePath.includes("claude.json"),
    );
    expect(claudeJsonCall).toBeDefined();
    const content = JSON.parse(claudeJsonCall![1] as string);
    expect(content.mcpServers).toBeDefined();
    expect(content.mcpServers['qmd-public']).toEqual({
      type: "http",
      url: "http://host.docker.internal:7333/mcp",
    });
    expect(content.mcpServers['qmd-crm']).toEqual({
      type: "http",
      url: "http://host.docker.internal:7334/mcp",
    });
    expect(content.mcpServers['qmd-domain-gidc']).toEqual({
      type: "http",
      url: "http://host.docker.internal:7335/mcp",
    });
  });

  it("mounts only public QMD for guest floor (single port)", () => {
    const inputWithPorts = {
      ...testInput,
      qmdPorts: { public: 7333 },
    };

    runContainerAgent(testGroup, inputWithPorts, () => {});

    const claudeJsonCall = vi.mocked(fs.writeFileSync).mock.calls.find(
      ([filePath]) =>
        typeof filePath === "string" && filePath.includes("claude.json"),
    );
    expect(claudeJsonCall).toBeDefined();
    const content = JSON.parse(claudeJsonCall![1] as string);
    expect(content.mcpServers).toBeDefined();
    expect(Object.keys(content.mcpServers)).toEqual(['qmd-public']);
  });

  it("does not rewrite settings.json if it already exists", () => {
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => typeof p === "string" && p.includes("settings.json"),
    );
    runContainerAgent(testGroup, testInput, () => {});
    const settingsCalls = vi.mocked(fs.writeFileSync).mock.calls.filter(
      ([filePath]) =>
        typeof filePath === "string" && filePath.includes("settings.json"),
    );
    expect(settingsCalls).toHaveLength(0);
  });
});

import { spawn } from 'child_process';

describe('container-runner extraEnv injection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(spawn).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('includes extra env vars as -e flags when extraEnv is provided', async () => {
    const inputWithExtraEnv = {
      ...testInput,
      extraEnv: { PERMITTED_WORKSTREAMS: 'sankosh' },
    };

    runContainerAgent(testGroup, inputWithExtraEnv, () => {});

    // Wait for buildContainerArgs (async) to resolve, then spawn to be called
    await Promise.resolve();
    await Promise.resolve();

    const spawnArgs = vi.mocked(spawn).mock.calls[0][1] as string[];
    const idx = spawnArgs.indexOf('PERMITTED_WORKSTREAMS=sankosh');
    expect(idx).toBeGreaterThan(-1);
    expect(spawnArgs[idx - 1]).toBe('-e');
  });

  it('does not add extra -e flags when extraEnv is not provided', async () => {
    runContainerAgent(testGroup, testInput, () => {});

    await Promise.resolve();
    await Promise.resolve();

    const spawnArgs = vi.mocked(spawn).mock.calls[0][1] as string[];
    // Standard env vars should be present; no custom extras
    expect(spawnArgs.some((arg) => arg.startsWith('TZ='))).toBe(true);
    expect(spawnArgs).not.toContain('PERMITTED_WORKSTREAMS=sankosh');
    // Only known env var values present (no unexpected -e values)
    const envValues = spawnArgs.filter((_, i) => i > 0 && spawnArgs[i - 1] === '-e');
    const knownPrefixes = ['TZ=', 'ANTHROPIC_', 'HOME='];
    for (const val of envValues) {
      expect(knownPrefixes.some((p) => val.startsWith(p))).toBe(true);
    }
  });

  it('includes all env vars when extraEnv has multiple entries', async () => {
    const inputWithMultipleEnv = {
      ...testInput,
      extraEnv: {
        PERMITTED_WORKSTREAMS: 'sankosh,founder-mode',
        WORKSTREAM_MODE: 'strict',
      },
    };

    runContainerAgent(testGroup, inputWithMultipleEnv, () => {});

    await Promise.resolve();
    await Promise.resolve();

    const spawnArgs = vi.mocked(spawn).mock.calls[0][1] as string[];

    const wsIdx = spawnArgs.indexOf('PERMITTED_WORKSTREAMS=sankosh,founder-mode');
    expect(wsIdx).toBeGreaterThan(-1);
    expect(spawnArgs[wsIdx - 1]).toBe('-e');

    const modeIdx = spawnArgs.indexOf('WORKSTREAM_MODE=strict');
    expect(modeIdx).toBeGreaterThan(-1);
    expect(spawnArgs[modeIdx - 1]).toBe('-e');
  });
});

describe('container-runner security hardening', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(spawn).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function getSpawnArgs(): Promise<string[]> {
    runContainerAgent(testGroup, testInput, () => {});
    await Promise.resolve();
    await Promise.resolve();
    return vi.mocked(spawn).mock.calls[0][1] as string[];
  }

  it('includes --security-opt no-new-privileges', async () => {
    const args = await getSpawnArgs();
    const idx = args.indexOf('no-new-privileges');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx - 1]).toBe('--security-opt');
  });

  it('includes --read-only flag', async () => {
    const args = await getSpawnArgs();
    expect(args).toContain('--read-only');
  });

  it('includes tmpfs mount for /tmp', async () => {
    const args = await getSpawnArgs();
    const idx = args.indexOf('/tmp:rw,noexec,nosuid,size=256m');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx - 1]).toBe('--tmpfs');
  });

  it('includes tmpfs mount for /home/node/.npm', async () => {
    const args = await getSpawnArgs();
    const idx = args.indexOf('/home/node/.npm:rw,noexec,nosuid,size=64m');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx - 1]).toBe('--tmpfs');
  });

  it('applies the NanoClaw seccomp profile (CVE-2026-31431 mitigation)', async () => {
    const args = await getSpawnArgs();
    // Find the --security-opt seccomp=<path> pair
    const seccompPairIdx = args.findIndex(
      (a) => typeof a === 'string' && a.startsWith('seccomp='),
    );
    expect(seccompPairIdx).toBeGreaterThan(-1);
    expect(args[seccompPairIdx - 1]).toBe('--security-opt');
    // The profile path must point to agent-default.json (custom NanoClaw
    // profile that blocks AF_ALG), not to "unconfined" or "default", and
    // MUST be absolute. The leading "/" guards against a future refactor
    // where assertSeccompProfileExists() returns a path relative to cwd
    // (which Docker would interpret relative to the dockerd cwd, not the
    // caller's — silent breakage). See jibot-code-1bt.
    const seccompArg = args[seccompPairIdx] as string;
    expect(seccompArg).toMatch(/^seccomp=\/.*agent-default\.json$/);
    expect(seccompArg).not.toContain('unconfined');
    expect(seccompArg).not.toBe('seccomp=default');
  });

  it('drops ALL Linux capabilities (defense-in-depth, jibot-code-x7w)', async () => {
    const args = await getSpawnArgs();
    const idx = args.indexOf('ALL');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx - 1]).toBe('--cap-drop');
    // Sanity: no --cap-add re-additions present. The empty re-add set is the
    // verified-safe configuration as of 2026-04-30 (see jibot-code-x7w).
    // If this assertion fails because someone added --cap-add, that is a
    // security regression requiring separate empirical re-verification and
    // security-guardian review — do NOT simply update this assertion to pass.
    expect(args).not.toContain('--cap-add');
  });
});
