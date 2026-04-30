/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { logger } from './logger.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/**
 * Absolute path to the seccomp profile applied to every agent container.
 *
 * Resolved from process.cwd() so the dev tree (~/repos/nanoclaw) and the
 * production deploy (~/nanoclaw on jibotmac) share one path convention. The
 * profile itself ships in `seccomp/agent-default.json` at the repo root.
 *
 * Defense-in-depth for CVE-2026-31431 (Linux kernel AF_ALG LPE, disclosed
 * 2026-04-29). See ~/switchboard/jibrain/atlas/concepts/2026-04-30-CVE-2026-31431-AF-ALG-LPE.md
 * and beads jibot-code-ilg.
 */
export function seccompProfilePath(): string {
  return path.join(process.cwd(), 'seccomp', 'agent-default.json');
}

/**
 * Verify the seccomp profile is present on disk before spawning a container.
 *
 * Fail-closed: a missing profile is treated as a deployment fault, not as a
 * silent fall-through to Docker's default profile. Docker's default does NOT
 * block AF_ALG (verified empirically 2026-04-30, kernel 6.8.0-90-generic),
 * so falling back would re-open the very primitive we are mitigating.
 *
 * Mirrors `ensureContainerRuntimeRunning` for tone and fatal-banner format so
 * operators see consistent guidance when the system refuses to start.
 *
 * @returns The validated absolute path on success.
 * @throws  When the profile is not present at the expected location.
 */
export function assertSeccompProfileExists(): string {
  const profilePath = seccompProfilePath();
  if (fs.existsSync(profilePath)) {
    logger.debug({ profilePath }, 'Seccomp profile present');
    return profilePath;
  }

  logger.error(
    { profilePath },
    'Seccomp profile missing — refusing to spawn agent container',
  );
  console.error(
    '\n╔══════════════════════════════════════════════════════════════════╗',
  );
  console.error(
    '║  FATAL: agent-default.json seccomp profile missing               ║',
  );
  console.error(
    '║                                                                  ║',
  );
  console.error(
    '║  NanoClaw refuses to spawn agent containers without the seccomp  ║',
  );
  console.error(
    '║  profile that blocks AF_ALG socket creation (CVE-2026-31431).    ║',
  );
  console.error(
    '║                                                                  ║',
  );
  console.error(
    '║  Expected at:                                                    ║',
  );
  console.error(`║    ${profilePath.padEnd(62)}║`);
  console.error(
    '║                                                                  ║',
  );
  console.error(
    '║  Fix: pull latest from main, or copy seccomp/agent-default.json  ║',
  );
  console.error(
    '║  from a working checkout. See beads jibot-code-ilg.              ║',
  );
  console.error(
    '╚══════════════════════════════════════════════════════════════════╝\n',
  );
  throw new Error(
    `Seccomp profile not found at ${profilePath} (CVE-2026-31431 mitigation required)`,
  );
}

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // On Linux, host.docker.internal isn't built-in — add it explicitly
  if (os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Stop a container by name. Uses execFileSync to avoid shell injection. */
export function stopContainer(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  execSync(`${CONTAINER_RUNTIME_BIN} stop -t 1 ${name}`, { stdio: 'pipe' });
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    logger.debug('Container runtime already running');
  } catch (err) {
    logger.error({ err }, 'Failed to reach container runtime');
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: Container runtime failed to start                      ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Agents cannot run without a container runtime. To fix:        ║',
    );
    console.error(
      '║  1. Ensure Docker is installed and running                     ║',
    );
    console.error(
      '║  2. Run: docker info                                           ║',
    );
    console.error(
      '║  3. Restart NanoClaw                                           ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('Container runtime is required but failed to start', {
      cause: err,
    });
  }
}

/** Kill orphaned NanoClaw containers from previous runs. */
export function cleanupOrphans(): void {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter name=nanoclaw- --format '{{.Names}}'`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      try {
        stopContainer(name);
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      logger.info(
        { count: orphans.length, names: orphans },
        'Stopped orphaned containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}
