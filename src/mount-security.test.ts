import { beforeAll, describe, expect, it } from 'vitest';

import { loadMountAllowlist, validateMount } from './mount-security.js';
import type { MountAllowlist } from './types.js';

/**
 * Integration tests for mount-security configuration.
 *
 * These tests verify that the REAL ~/.config/nanoclaw/mount-allowlist.json
 * on jibotmac contains the expected entries and that the directory tree
 * under ~/switchboard/confidential exists and is mountable.
 *
 * The loadMountAllowlist() function uses module-level caching — each vitest
 * test file gets a fresh module instance, so the first call here loads from
 * the real file. Subsequent calls in this file hit the cache (same config).
 *
 * Spec: task-8 — Configure Docker container mounts for confidential directory
 */

describe("loadMountAllowlist - integration (reads real ~/.config/nanoclaw/mount-allowlist.json)", () => {
  let allowlist: MountAllowlist | null;

  beforeAll(() => {
    allowlist = loadMountAllowlist();
  });

  it("returns non-null when config file exists", () => {
    expect(allowlist).not.toBeNull();
  });

  it("returns ~/jibrain and ~/switchboard roots", () => {
    if (allowlist === null) return;
    const paths = allowlist.allowedRoots.map((r) => r.path);
    expect(paths).toContain("~/jibrain");
    expect(paths).toContain("~/switchboard");
  });

  it("returns exactly 3 allowed roots", () => {
    if (allowlist === null) return;
    expect(allowlist.allowedRoots).toHaveLength(3);
  });

  it("~/jibrain has allowReadWrite: true", () => {
    if (allowlist === null) return;
    const jibrain = allowlist.allowedRoots.find((r) => r.path === "~/jibrain");
    expect(jibrain).toBeDefined();
    expect(jibrain!.allowReadWrite).toBe(true);
  });

  it("~/switchboard has allowReadWrite: true", () => {
    if (allowlist === null) return;
    const switchboard = allowlist.allowedRoots.find(
      (r) => r.path === "~/switchboard",
    );
    expect(switchboard).toBeDefined();
    expect(switchboard!.allowReadWrite).toBe(true);
  });

  it("~/switchboard has correct description", () => {
    if (allowlist === null) return;
    const switchboard = allowlist.allowedRoots.find(
      (r) => r.path === "~/switchboard",
    );
    expect(switchboard!.description).toBe(
      "Switchboard data (email tracker, agents, ops) — email-tracker.json lives here",
    );
  });
});

describe("validateMount - ~/switchboard/confidential directory tree", () => {
  const subdirs = [
    "sankosh/intake",
    "sankosh/attachments",
    "gidc/intake",
    "gidc/attachments",
    "bhutan/intake",
    "bhutan/attachments",
  ];

  for (const subdir of subdirs) {
    it(`~/switchboard/confidential/${subdir} exists and is mountable read-write`, () => {
      const hostPath = `~/switchboard/confidential/${subdir}`;
      // containerPath must be relative, no slashes — convert "sankosh/intake" → "sankosh-intake"
      const containerPath = subdir.replace("/", "-");
      const result = validateMount(
        { hostPath, containerPath, readonly: false },
        true,
      );
      expect(result.allowed).toBe(true);
      expect(result.effectiveReadonly).toBe(false);
    });
  }
});
