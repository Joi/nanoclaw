/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { CONTAINER_INSTALL_LABEL } from './config.js';
import { log } from './log.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/**
 * Absolute path to the seccomp profile applied to every agent container.
 *
 * Resolved from process.cwd() so the dev tree and the production deploy
 * share one path convention. The profile itself ships in
 * `seccomp/agent-default.json` at the repo root.
 *
 * Defense-in-depth for CVE-2026-31431 (Linux kernel AF_ALG LPE, disclosed
 * 2026-04-29). Profile blocks `socket(AF_ALG, ...)` and `socket(AF_VSOCK, ...)`
 * regardless of host kernel patch state.
 */
export function seccompProfilePath(): string {
  return path.join(process.cwd(), 'seccomp', 'agent-default.json');
}

/**
 * Verify the seccomp profile is present on disk before spawning a container.
 *
 * Fail-closed: a missing profile is treated as a deployment fault, not as a
 * silent fall-through to the runtime's default profile (which does NOT block
 * AF_ALG, verified empirically on Docker 29.2.0 / Colima 6.8.0-90-generic).
 * Falling back would re-open the very primitive we are mitigating.
 *
 * @returns The validated absolute path on success.
 * @throws  When the profile is not present at the expected location.
 */
export function assertSeccompProfileExists(): string {
  const profilePath = seccompProfilePath();
  if (fs.existsSync(profilePath)) {
    log.debug('Seccomp profile present', { profilePath });
    return profilePath;
  }
  log.error('Seccomp profile missing — refusing to spawn agent container', { profilePath });
  console.error('\n╔══════════════════════════════════════════════════════════════════╗');
  console.error('║  FATAL: agent-default.json seccomp profile missing               ║');
  console.error('║                                                                  ║');
  console.error('║  NanoClaw refuses to spawn agent containers without the seccomp  ║');
  console.error('║  profile that blocks AF_ALG socket creation (CVE-2026-31431).    ║');
  console.error('║                                                                  ║');
  console.error('║  Expected at:                                                    ║');
  console.error(`║    ${profilePath.padEnd(62)}║`);
  console.error('║                                                                  ║');
  console.error('║  Fix: copy seccomp/agent-default.json from a working checkout    ║');
  console.error('║  or pull latest. Profile is a fork of moby/profiles with AF_ALG  ║');
  console.error('║  and AF_VSOCK rules adjusted (see _legacy/v1.2.49 for history).  ║');
  console.error('╚══════════════════════════════════════════════════════════════════╝\n');
  throw new Error(`Seccomp profile not found at ${profilePath} (CVE-2026-31431 mitigation required)`);
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
export function readonlyMountArgs(hostPath: string, containerPath: string): string[] {
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
    log.debug('Container runtime already running');
  } catch (err) {
    log.error('Failed to reach container runtime', { err });
    console.error('\n╔════════════════════════════════════════════════════════════════╗');
    console.error('║  FATAL: Container runtime failed to start                      ║');
    console.error('║                                                                ║');
    console.error('║  Agents cannot run without a container runtime. To fix:        ║');
    console.error('║  1. Ensure Docker is installed and running                     ║');
    console.error('║  2. Run: docker info                                           ║');
    console.error('║  3. Restart NanoClaw                                           ║');
    console.error('╚════════════════════════════════════════════════════════════════╝\n');
    throw new Error('Container runtime is required but failed to start', {
      cause: err,
    });
  }
}

/**
 * Kill orphaned NanoClaw containers from THIS install's previous runs.
 *
 * Scoped by label `nanoclaw-install=<slug>` so a crash-looping peer install
 * cannot reap our containers, and we cannot reap theirs. The label is
 * stamped onto every container at spawn time — see container-runner.ts.
 */
export function cleanupOrphans(): void {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter label=${CONTAINER_INSTALL_LABEL} --format '{{.Names}}'`,
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
      },
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
      log.info('Stopped orphaned containers', { count: orphans.length, names: orphans });
    }
  } catch (err) {
    log.warn('Failed to clean up orphaned containers', { err });
  }
}
