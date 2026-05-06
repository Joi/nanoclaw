import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import YAML from 'yaml';

import {
  isObservationIpcTask,
  ObservationData,
  parseObservation,
  writePendingObservation,
} from './observations.js';

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'observations-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('parseObservation', () => {
  it('structures observation from valid IPC data', () => {
    const data: Record<string, unknown> = {
      type: 'observation',
      person_name: 'Alice Smith',
      observation_text: 'Prefers morning meetings',
      source: 'weekly-standup',
      contributed_by: 'Bob',
      entity_id: 'alice-123',
      discrepancy_noted: true,
    };

    const result = parseObservation(data);

    expect(result).not.toBeNull();
    expect(result!.person_name).toBe('Alice Smith');
    expect(result!.observation_text).toBe('Prefers morning meetings');
    expect(result!.source).toBe('weekly-standup');
    expect(result!.contributed_by).toBe('Bob');
    expect(result!.entity_id).toBe('alice-123');
    expect(result!.discrepancy_noted).toBe(true);
    expect(result!.created).toBeTruthy();
    // created should be a valid ISO date string
    expect(new Date(result!.created).toISOString()).toBe(result!.created);
  });

  it('returns null when type is not observation', () => {
    const data: Record<string, unknown> = {
      type: 'schedule_task',
      person_name: 'Alice',
      observation_text: 'something',
      source: 'chat',
      contributed_by: 'Bob',
    };

    expect(parseObservation(data)).toBeNull();
  });

  it('returns null when person_name is missing', () => {
    const data: Record<string, unknown> = {
      type: 'observation',
      observation_text: 'something',
      source: 'chat',
      contributed_by: 'Bob',
    };

    expect(parseObservation(data)).toBeNull();
  });

  it('returns null when observation_text is missing', () => {
    const data: Record<string, unknown> = {
      type: 'observation',
      person_name: 'Alice',
      source: 'chat',
      contributed_by: 'Bob',
    };

    expect(parseObservation(data)).toBeNull();
  });

  it('returns null when source is missing', () => {
    const data: Record<string, unknown> = {
      type: 'observation',
      person_name: 'Alice',
      observation_text: 'something',
      contributed_by: 'Bob',
    };

    expect(parseObservation(data)).toBeNull();
  });

  it('returns null when contributed_by is missing', () => {
    const data: Record<string, unknown> = {
      type: 'observation',
      person_name: 'Alice',
      observation_text: 'something',
      source: 'chat',
    };

    expect(parseObservation(data)).toBeNull();
  });

  it('defaults discrepancy_noted to false when not provided', () => {
    const data: Record<string, unknown> = {
      type: 'observation',
      person_name: 'Alice',
      observation_text: 'something',
      source: 'chat',
      contributed_by: 'Bob',
    };

    const result = parseObservation(data);
    expect(result).not.toBeNull();
    expect(result!.discrepancy_noted).toBe(false);
  });

  it('sets entity_id to undefined when not provided', () => {
    const data: Record<string, unknown> = {
      type: 'observation',
      person_name: 'Alice',
      observation_text: 'something',
      source: 'chat',
      contributed_by: 'Bob',
    };

    const result = parseObservation(data);
    expect(result).not.toBeNull();
    expect(result!.entity_id).toBeUndefined();
  });
});

describe('isObservationIpcTask', () => {
  it('returns true for observation type', () => {
    expect(isObservationIpcTask({ type: 'observation' })).toBe(true);
  });

  it('returns false for schedule_task type', () => {
    expect(isObservationIpcTask({ type: 'schedule_task' })).toBe(false);
  });

  it('returns false for message type', () => {
    expect(isObservationIpcTask({ type: 'message' })).toBe(false);
  });

  it('returns false when type is missing', () => {
    expect(isObservationIpcTask({})).toBe(false);
  });
});

describe('writePendingObservation', () => {
  const makeObservation = (overrides: Partial<ObservationData> = {}): ObservationData => ({
    person_name: 'Alice Smith',
    observation_text: 'Prefers async communication',
    source: 'team-chat',
    contributed_by: 'Bob',
    discrepancy_noted: false,
    created: '2026-04-05T12:00:00.000Z',
    ...overrides,
  });

  it('creates a YAML file with correct fields', () => {
    const obs = makeObservation();
    const pendingDir = path.join(tmpDir, 'pending');

    const filePath = writePendingObservation(obs, pendingDir);

    expect(fs.existsSync(filePath)).toBe(true);
    const content = YAML.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(content.person_name).toBe('Alice Smith');
    expect(content.observation_text).toBe('Prefers async communication');
    expect(content.source).toBe('team-chat');
    expect(content.contributed_by).toBe('Bob');
    expect(content.discrepancy_noted).toBe(false);
    expect(content.created).toBe('2026-04-05T12:00:00.000Z');
    expect(content.entity_id).toBeNull();
  });

  it('generates filename with date and person name slug', () => {
    const obs = makeObservation({
      person_name: 'John Doe',
      created: '2026-04-05T14:30:00.000Z',
    });
    const pendingDir = path.join(tmpDir, 'pending');

    const filePath = writePendingObservation(obs, pendingDir);
    const filename = path.basename(filePath);

    expect(filename).toMatch(/^2026-04-05-john-doe-[a-z0-9]+\.yaml$/);
  });

  it('creates the pending directory if it does not exist', () => {
    const obs = makeObservation();
    const pendingDir = path.join(tmpDir, 'deep', 'nested', 'pending');

    expect(fs.existsSync(pendingDir)).toBe(false);
    writePendingObservation(obs, pendingDir);
    expect(fs.existsSync(pendingDir)).toBe(true);
  });

  it('handles discrepancy_noted flag set to true', () => {
    const obs = makeObservation({ discrepancy_noted: true });
    const pendingDir = path.join(tmpDir, 'pending');

    const filePath = writePendingObservation(obs, pendingDir);
    const content = YAML.parse(fs.readFileSync(filePath, 'utf-8'));

    expect(content.discrepancy_noted).toBe(true);
  });

  it('includes entity_id in YAML when provided', () => {
    const obs = makeObservation({ entity_id: 'ent-456' });
    const pendingDir = path.join(tmpDir, 'pending');

    const filePath = writePendingObservation(obs, pendingDir);
    const content = YAML.parse(fs.readFileSync(filePath, 'utf-8'));

    expect(content.entity_id).toBe('ent-456');
  });

  it('slugifies names with special characters', () => {
    const obs = makeObservation({
      person_name: "José O'Brien-López",
      created: '2026-04-05T10:00:00.000Z',
    });
    const pendingDir = path.join(tmpDir, 'pending');

    const filePath = writePendingObservation(obs, pendingDir);
    const filename = path.basename(filePath);

    expect(filename).toMatch(/^2026-04-05-jos-obrien-lpez-[a-z0-9]+\.yaml$/);
  });
});
