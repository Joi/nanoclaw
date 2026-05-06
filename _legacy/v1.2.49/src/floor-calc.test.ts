import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AccessTier,
  calculateFloor,
  FloorChangeEvent,
  logFloorChange,
} from './floor-calc.js';

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'floor-calc-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('calculateFloor', () => {
  it('returns guest for empty members', () => {
    expect(calculateFloor({})).toBe('guest');
  });

  it('returns owner when all members are owners', () => {
    expect(
      calculateFloor({
        a: { tier: 'owner' },
        b: { tier: 'owner' },
      }),
    ).toBe('owner');
  });

  it('returns admin when admin is lowest', () => {
    expect(
      calculateFloor({
        a: { tier: 'owner' },
        b: { tier: 'admin' },
      }),
    ).toBe('admin');
  });

  it('returns staff when staff is lowest', () => {
    expect(
      calculateFloor({
        a: { tier: 'owner' },
        b: { tier: 'admin' },
        c: { tier: 'staff' },
      }),
    ).toBe('staff');
  });

  it('returns guest when guest is present', () => {
    expect(
      calculateFloor({
        a: { tier: 'owner' },
        b: { tier: 'admin' },
        c: { tier: 'staff' },
        d: { tier: 'guest' },
      }),
    ).toBe('guest');
  });

  it('returns guest when blocked is present (blocked maps to rank 1 = guest)', () => {
    expect(
      calculateFloor({
        a: { tier: 'owner' },
        b: { tier: 'blocked' },
      }),
    ).toBe('guest');
  });

  it('returns guest when banned is present (banned maps to rank 0 = guest)', () => {
    expect(
      calculateFloor({
        a: { tier: 'owner' },
        b: { tier: 'banned' as AccessTier },
      }),
    ).toBe('guest');
  });

  it('handles mixed tiers correctly', () => {
    expect(
      calculateFloor({
        a: { tier: 'admin' },
        b: { tier: 'staff' },
        c: { tier: 'admin' },
      }),
    ).toBe('staff');
  });
});

describe('logFloorChange', () => {
  it('creates floor-changes.jsonl with event', () => {
    const triageDir = path.join(tmpDir, 'triage');
    const event: FloorChangeEvent = {
      timestamp: '2026-01-01T00:00:00.000Z',
      previousFloor: 'admin',
      newFloor: 'staff',
      reason: 'new staff member added',
    };

    logFloorChange(event, triageDir);

    const filePath = path.join(triageDir, 'floor-changes.jsonl');
    expect(fs.existsSync(filePath)).toBe(true);
    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual(event);
  });

  it('appends multiple events', () => {
    const triageDir = path.join(tmpDir, 'triage');
    const event1: FloorChangeEvent = {
      timestamp: '2026-01-01T00:00:00.000Z',
      previousFloor: 'admin',
      newFloor: 'staff',
    };
    const event2: FloorChangeEvent = {
      timestamp: '2026-01-01T01:00:00.000Z',
      previousFloor: 'staff',
      newFloor: 'guest',
    };

    logFloorChange(event1, triageDir);
    logFloorChange(event2, triageDir);

    const filePath = path.join(triageDir, 'floor-changes.jsonl');
    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual(event1);
    expect(JSON.parse(lines[1])).toEqual(event2);
  });
});
